// test/integration/real-fs.ts —— 真实磁盘上的 `FileSystem` 实现，语义逐条对齐宿主 fs-local。
//
// 集成层为什么需要它：本包的目录扫描与角色导入此前只被手搓桩喂过，桩的 `contains` 是
// 「parent.targetKey 前缀 == child.targetKey」的同义反复、`size` 随手一给，于是「插件的
// 假设对不对」在测试里恒为真。这里换成官方抽象类的子类（13 个抽象成员一个都不能少），
// 行为按 harness `packages/fs/fs-local/src/{index,fsio}.ts` 复刻，真目录树说了算。
//
// 契约证据（deepseek-harness @ dsh-v0.2.1-alpha.2）：
//  · resolve：空串/纯空白抛 FS_NOT_FOUND（fsio.ts 的 resolve）；displayPath 保留含 `..` 的物理
//    拼写，否则 path.resolve 归一（fsio.ts 的 displayPath）；targetKey = 文件的 realpath，
//    跟随符号链接并取磁盘真实大小写（fsio.ts 的 targetKey）；缺席路径 realpath 最近存在祖先再拼回
//    缺失后缀（fsio.ts），故「不存在」不抛错、由 stat 返回 undefined 表达。
//  · contains：relative(processPath(parent), processPath(child))，即 **realpath 之后**逐段
//    判包含，`''`（同体）也算内含（fs-local/index.ts 的 contains）→ cwd 内指向外部的软链，
//    其 child.targetKey 已在根外，contains 当场判否。
//  · listDir：数组而非迭代器；readdir 全量（含隐藏项）→ localeCompare 稳定名序
//    （fsio.ts 的 listDir）；子项 type 只有 file|directory|other（联合里没有 symlink，
//    软链报成目标的类型、断链落 other，fsio.ts 的 listDir）；**size 仅普通文件附带**（同处）；
//    缺席 FS_NOT_FOUND、非目录 FS_NOT_DIRECTORY（fsio.ts）。
//  · readText：先 stat，缺席 FS_NOT_FOUND、非普通文件 FS_NOT_REGULAR_FILE（fsio.ts 的 readText）；
//    头 8192 字节含 NUL → FS_NOT_TEXT「binary file」（fsio.ts）；TextDecoder({fatal})
//    失败 → FS_NOT_TEXT（fsio.ts 的 readText）；**byte-for-byte 交付，不归一行尾、不剥 BOM**（同处）。
//  · 错误码词汇表：packages/fs/fs/src/types.ts；FsError 继承 HarnessError 带 code。
//
// 本文件是宿主实现的**语义镜像**，三处规则按整文件豁免，理由各一条：
//  · eslint(new-cap)：`FsTargetKey()` / `FsVersion()` 是官方导出的品牌函数（不是构造器），
//    types.ts 就这么写的，换名字等于自造 API。
//  · eslint(class-methods-use-this)：`FileSystem` 抽象成员的签名归官方，读面实现
//    （processPath / lstat / writeText…）天然不引用 this，硬塞 this 只为过 lint 是假动作。
//  · eslint(no-await-in-loop)：listDir 逐子项串行 await，与 fsio.ts 的 listDir 同式——宿主
//    就是靠串行来天然限流（不开并发），并发化等于偏离被测语义。
/* oxlint-disable class-methods-use-this, new-cap, no-await-in-loop */
import { FsError, FileSystem, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion as FsVersionType,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** fs-local 的二进制采样窗口（fsio.ts）。 */
const BINARY_SAMPLE_BYTES = 8192;

/** 跟随末段软链后可能出现的类型（fs-local 的 `stat` 永不报 symlink，fsio.ts 的 stat）。 */
type FollowedType = "file" | "directory" | "other";

/** 探针返回值（fs-local 的 PathInfo / PathLinkInfo 投影，types.ts）。 */
interface ProbeResult<TType extends FsInfo["type"] | "symlink"> {
  readonly version: FsVersionType;
  readonly type: TType;
  readonly size: number;
}

/** 缺席判据之一（fsio.ts）。 */
function isEnoent(error: unknown): boolean {
  const { code } = error as { code?: string };
  return code === "ENOENT";
}

/** 父段不是目录判据（fsio.ts）：POSIX 上它也意味着「这条路不可能存在」。 */
function isEnotdir(error: unknown): boolean {
  const { code } = error as { code?: string };
  return code === "ENOTDIR";
}

/** ENOENT / ENOTDIR 在宿主口径里同义为「缺席」（fsio.ts）。 */
function isMissing(error: unknown): boolean {
  return isEnoent(error) || isEnotdir(error);
}

/** node 的 Stats 归约成宿主那几档判别（fsio.ts 那几档判别的并集）。 */
function typeOf(
  info: {
    isFile: () => boolean;
    isDirectory: () => boolean;
    isSymbolicLink?: () => boolean;
  },
  followFinal: boolean,
): FollowedType | "symlink" {
  if (!followFinal && info.isSymbolicLink?.() === true) {
    return "symlink";
  }
  if (info.isFile()) {
    return "file";
  }
  return info.isDirectory() ? "directory" : "other";
}

/**
 * 版本串与宿主同式（dev:ino:size:mtime:ctime，fsio.ts 的版本串）。宿主取 bigint 的 mtimeNs，
 * 这里取 mtimeMs：这一位是 **opaque 身份**（types.ts 明令消费方不得解读），两者都只
 * 兑现「改过一次就换一个」，而集成测试判的正是这件事。
 */
function versionOf(info: Stats): FsVersionType {
  return FsVersion(
    `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeMs)}:${String(info.ctimeMs)}`,
  );
}

/** 探针共用体：缺席回 undefined，其余按是否跟随末段取元数据（fsio.ts 的探针）。 */
async function probeWith(
  absolute: string,
  noFollow: boolean,
): Promise<ProbeResult<FollowedType | "symlink"> | undefined> {
  let result: ProbeResult<FollowedType | "symlink"> | undefined;
  try {
    const info = await (noFollow
      ? lstat(absolute, { bigint: false })
      : stat(absolute, { bigint: false }));
    result = {
      version: versionOf(info),
      type: typeOf(
        {
          isFile: () => info.isFile(),
          isDirectory: () => info.isDirectory(),
          isSymbolicLink: () => info.isSymbolicLink(),
        },
        !noFollow,
      ),
      size: info.size,
    };
  } catch (error: unknown) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  return result;
}

/** 跟随末段（fs-local 的 `probe`，fsio.ts 的 probe）。类型上就排除 symlink，省得每个消费点收窄。 */
async function probeFollow(absolute: string): Promise<ProbeResult<FollowedType> | undefined> {
  const info = await probeWith(absolute, false);
  return info === undefined ? undefined : (info as ProbeResult<FollowedType>);
}

/** 不跟随末段（fs-local 的 `probeNoFollow`，fsio.ts）：只有这一支报得出 symlink。 */
async function probeNoFollow(
  absolute: string,
): Promise<ProbeResult<FollowedType | "symlink"> | undefined> {
  return probeWith(absolute, true);
}

/** 缺席 → FS_NOT_FOUND（fsio.ts 的 stat）；其余错误原样上抛。 */
async function statOrThrow(
  absolute: string,
  verb: "read",
): Promise<{ isFile: () => boolean; size: number }> {
  try {
    return await stat(absolute);
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw new FsError(`cannot ${verb} "${absolute}": not found`, "FS_NOT_FOUND");
    }
    throw error;
  }
}

/** abort 检查独立成函数：内联两处的话 TS 会把上一轮的收窄带过 await，把第二次判真当作不可达。 */
function checkAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted === true) {
    throw new FsError(`${verb} aborted`, "FS_ABORTED");
  }
}

/** 整读：open/read 循环而不是一把 readFile，让超大文件能在早停处止步。 */
async function readFileBounded(absolute: string, signal?: AbortSignal): Promise<Uint8Array> {
  checkAborted(signal, "read");
  const handle = await open(absolute, "r");
  try {
    const statInfo = await handle.stat();
    const buffer = new Uint8Array(statInfo.size);
    let read = 0;
    while (read < buffer.length) {
      checkAborted(signal, "read");
      const chunk = await handle.read(buffer, read, buffer.length - read, read);
      if (chunk.bytesRead === 0) {
        break;
      }
      read += chunk.bytesRead;
    }
    return read === buffer.length ? buffer : buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/**
 * displayPath 与 fs-local `localDisplayPath` 同式：请求里带物理 `..` 遍历段时保留原拼写，
 * 否则 path.resolve 归一（fsio.ts 的 displayPath）。
 */
function displayPathOf(base: string, request: string): string {
  const raw = path.isAbsolute(request) ? request : `${base}${path.sep}${request}`;
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(raw) ? path.resolve(raw) : path.resolve(base, request);
}

/**
 * realpath 身份（fs-local `resolveLocalTarget` 的 key 那一半，fsio.ts 的 realpath 身份）：存在即取
 * 自身 realpath；缺席则 realpath 最近存在祖先再拼回缺失后缀，使创建前后身份一致。
 */
async function identityOf(absolute: string): Promise<string> {
  try {
    return await realpath(absolute);
  } catch (error: unknown) {
    if (isEnotdir(error)) {
      throw new FsError(
        `cannot resolve "${absolute}": a parent path segment is not a directory`,
        "FS_NOT_FOUND",
        { cause: error },
      );
    }
    if (!isEnoent(error)) {
      throw error;
    }
  }
  const missing: string[] = [path.basename(absolute)];
  let ancestor = path.dirname(absolute);
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...missing);
    } catch (error: unknown) {
      if (!isEnoent(error)) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return absolute;
      }
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * 真实磁盘上的 `FileSystem`：读面 + 有界字节读。本包从不写盘（host.ts 文件头的「只读」承诺），
 * 故 `writeText` / `editText` 交回 FS_IO_ERROR——哪天生产面真动手写，这里当场炸，而不是悄悄通过。
 */
export class DiskFileSystem extends FileSystem {
  public override async resolve(
    request: string,
    opts?: { cwd?: string; signal?: AbortSignal },
  ): Promise<FsTarget> {
    checkAborted(opts?.signal, "resolve");
    if (request.trim().length === 0) {
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    }
    const displayPath = displayPathOf(opts?.cwd ?? process.cwd(), request);
    return { displayPath, targetKey: FsTargetKey(await identityOf(displayPath)) };
  }

  public override processPath(target: FsTarget): string {
    return String(target.targetKey);
  }

  public override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href;
  }

  public override contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = path.relative(this.processPath(parent), this.processPath(child));
    return (
      rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  }

  public override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    checkAborted(signal, "stat");
    const info = await probeFollow(this.processPath(target));
    return info === undefined
      ? undefined
      : { version: info.version, type: info.type, size: info.size };
  }

  /** 末段是软链时不跟随：`symlink` 这一档只有 lstat 报得出（fs-local/index.ts 的 lstat）。 */
  public override async lstat(
    request: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    checkAborted(signal, "lstat");
    if (request.trim().length === 0) {
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    }
    const info = await probeNoFollow(displayPathOf(opts?.cwd ?? process.cwd(), request));
    return info === undefined
      ? undefined
      : { version: info.version, type: info.type, size: info.size };
  }

  public override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    checkAborted(signal, "read");
    const file = this.processPath(target);
    const info = await statOrThrow(file, "read");
    if (!info.isFile()) {
      throw new FsError(
        `cannot read "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    const raw = await readFileBounded(file, signal);
    checkAborted(signal, "read");
    if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new FsError(`cannot read "${target.displayPath}": binary file`, "FS_NOT_TEXT");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new FsError(`cannot read "${target.displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT");
    }
  }

  public override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<string>> {
    const text = await this.readText(target, signal);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        yield text;
      },
    };
  }

  /** 整读字节，`maxBytes` 是**完整内容**的上界（fsio.ts 的 stat 早停）。 */
  public override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const file = this.processPath(target);
    const info = await statOrThrow(file, "read");
    if (info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": file too large`, "FS_TOO_LARGE");
    }
    const raw = await readFileBounded(file, signal);
    if (raw.length > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": file too large`, "FS_TOO_LARGE");
    }
    return raw;
  }

  public override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const raw = await readFileBounded(this.processPath(target), signal);
    return raw.subarray(range.offset, range.offset + range.length);
  }

  /** 稳定名序 + 跟随软链的子项形状 + 从不读正文（fsio.ts 的 listDir）。 */
  public override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    checkAborted(signal, "list");
    const dir = this.processPath(target);
    const info = await probeFollow(dir);
    if (info === undefined) {
      throw new FsError(`cannot list "${target.displayPath}": not found`, "FS_NOT_FOUND");
    }
    if (info.type !== "directory") {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, "FS_NOT_DIRECTORY");
    }
    const listed = await readdir(dir);
    const names = listed.toSorted((left, right) => left.localeCompare(right));
    const out: FsDirEntry[] = [];
    for (const name of names) {
      checkAborted(signal, "list");
      // 子项以 **parent.targetKey（realpath 世界）** 为基准解析，与 fsio.ts 的 listDir 同式：
      // 链接子项的 targetKey 因此落在真实目标上——contains 的判据就是为这件事准备的。
      const child = await identityOf(path.join(dir, name));
      const childInfo = await probeFollow(child);
      out.push({
        name,
        // 跟随末段的探针报不出 symlink（FsDirEntry 的联合里本来就没有这一档，
        // fsio.ts 的 listDir），断链探针缺席 → undefined → 'other'，与 fs-local 同式。
        type: childInfo?.type ?? "other",
        target: { targetKey: FsTargetKey(child), displayPath: path.join(target.displayPath, name) },
        ...(childInfo === undefined ? {} : { version: childInfo.version }),
        ...(childInfo?.type === "file" ? { size: childInfo.size } : {}),
      });
    }
    return out;
  }

  public override async writeText(
    target: FsTarget,
    _content: string,
    _expected?: FsWriteIntent,
    _signal?: AbortSignal,
    _sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    throw new FsError(
      `refused write to "${target.displayPath}": test backend is read-only`,
      "FS_IO_ERROR",
    );
  }

  public override async editText(
    target: FsTarget,
    _edit: FsEditRequest,
    _expected?: { version: FsVersionType },
  ): Promise<FsEditOutcome> {
    throw new FsError(
      `refused edit of "${target.displayPath}": test backend is read-only`,
      "FS_IO_ERROR",
    );
  }
}
