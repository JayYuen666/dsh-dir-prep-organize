// test/integration/filesystem.test.ts —— 任务 #3：以**真实 FileSystem 抽象类**驱动本包读面。
//
// 与 test/routes.test.ts 的分工：那里用 `FsService` 形状的**手搓桩**跑回执分支（快、稳、可造
// 罕见错误）；这里换成真磁盘 + 真抽象类子类（test/integration/real-fs.ts，语义逐条对齐宿主
// fs-local，契约证据写在那份文件头），于是三类只在真件上才会露面的东西被纳入判据：
//   ① listDir 交来的 `size`/`type` 是不是真的（桩里 `size` 随手一给就"测得出绿"，而
//      readSnippetBounded 整条取舍都挂在它上面）；
//   ② 软链的 targetKey 身份（宿主 fsio.ts 的 realpath 派生）在 contains/去重上是否一致；
//   ③ 真错误（FS_NOT_TEXT / FS_NOT_DIRECTORY / FS_TOO_LARGE）经本包降级后计到哪一格。
//
// 契约证据（deepseek-harness @ dsh-v0.2.1-alpha.2）：
//  · `FileSystem` 抽象面 13 位：packages/fs/fs/src/index.ts 的 resolve / processPath /
//    fileUrl / contains / stat / lstat / readText / streamText / readBytes / readByteRange /
//    listDir / writeText / editText；
//    `declare module { interface Context { fs: FileSystem } }` 也在同一份声明里。
//  · `FsDirEntry`：name/type('file'|'directory'|'other')/target/version?/size?
//    packages/fs/fs/src/types.ts —— 注意联合里**没有 'symlink'**，故软链在 listDir
//    里只能以"跟随后的真身"露面（断链落 'other'），本文件那两条软链用例判的就是这件事。
//  · 错误码词汇表：packages/fs/fs/src/types.ts（FS_NOT_TEXT / FS_TOO_LARGE /
//    FS_NOT_DIRECTORY / FS_NOT_FOUND / FS_NOT_REGULAR_FILE …）。
//  · 本包消费面：`FsService = Pick<FileSystem, "resolve" | "listDir" | "readText" |
//    "contains" | "stat">`（host.ts），`collectDirContext` 的形参只取其中不带 `stat` 的几位。
import { afterEach, beforeEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { chmod, mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { FsError } from "@deepseek-ai/dsh-fs";

import { collectAgentTemplates, collectDirContext } from "../../host.ts";
import { HOST_MESSAGES } from "../../src/host-messages.ts";
import { DiskFileSystem } from "./real-fs.ts";

const MESSAGES = HOST_MESSAGES.zh;

/** 反复出现的路径名与正文（sonarjs 的重复字面量计数，收一处）。 */
const PKG_JSON = "package.json";
const README_MD = "README.md";
const README_BODY = "# 前端开发者 🎨\n\n第一行\n";
/** 摘要面判的是 trim 之后的正文（host.ts 的 makeSnippet）。 */
const README_SNIPPET = "# 前端开发者 🎨\n\n第一行";

/** FsError 判别：错误码是宿主给消费方的**唯一**机读位（types.ts）。 */
function isFsError(error: unknown, code: string): boolean {
  assert.ok(error instanceof FsError, `应抛 FsError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

/** 带正文的角色文件（泄漏哨兵要塞进正文里）。 */
function roleFile(name: string, body: string): string {
  return `---\nname: ${name}\n---\n${body}\n`;
}

/** 角色 .md 的正文形状（frontmatter + 正文），导入用例判的都是「收进来了哪几枚」。 */
function role(name: string, description = "描述"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;
}

interface Tree {
  readonly root: string;
  readonly fs: DiskFileSystem;
  readonly ctx: Context;
}

let current: Tree | undefined;

/** 铺一棵临时目录树并把真 `DiskFileSystem` 挂进真实 Context（`ctx.fs` 即官方那一位）。 */
async function makeTree(): Promise<Tree> {
  const root = await mkdtemp(path.join(os.tmpdir(), "organize-fs-"));
  const ctx = new Context();
  const fs = new DiskFileSystem(ctx);
  return { root, fs, ctx };
}

/** 写盘并回传路径。 */
async function disk(file: string, body: string | Uint8Array): Promise<string> {
  await writeFile(file, body);
  return file;
}

// 本文件的台子是**全局**的（一枚真 Context + 一棵临时目录树），hooks 属于装配而不属于
// 任何一族用例，故按行豁免 vitest/require-top-level-describe（把它塞进某一族 describe
// 反而会让另外几族失去隔离）。
/* oxlint-disable vitest/require-top-level-describe */
beforeEach(async () => {
  current = await makeTree();
});

afterEach(async () => {
  const built = current;
  current = undefined;
  if (built !== undefined) {
    try {
      await built.ctx.fiber.dispose();
    } finally {
      // dispose 抛错也必须把临时树删掉：否则每次失败都会在 /tmp 留一棵目录（且下一次
      // afterEach 看到的 current 已被清空，没人再管它）。
      await rm(built.root, { recursive: true, force: true });
    }
  }
});
/* oxlint-enable vitest/require-top-level-describe */

/** 取当前台（断言"在用例里"而不是把 undefined 传进生产面）。 */
function tree(): Tree {
  const built = current;
  if (built === undefined) {
    throw new Error("用例没建起目录台");
  }
  return built;
}

/** 模板条目 → 角色名列表（导入用例判的都是"收进来了哪几枚、按什么序"）。 */
function names(entries: readonly { name: string }[]): string[] {
  return entries.map((item) => item.name);
}

describe("真实 FileSystem 抽象类：装配与身份", () => {
  it("挂进真实 Context 后就是官方 ctx.fs 那一位，且缺席/非法路径按 fs-local 语义抛", async () => {
    const { fs, ctx } = tree();
    // cordis 交出的是服务代理而不是实例本身，故"就是这一位"要看代理背后：实例同类 + 服务名 'fs'
    // （packages/fs/fs/src/index.ts 的 `super(ctx, 'fs')` 就是注册点本身）。
    assert.ok(ctx.fs instanceof DiskFileSystem, "ctx.fs 解析到本类的实例");
    assert.equal(fs.name, "fs");
    // 同一 Context 上再注册一次 'fs' 当场撞名——这条失败正是"构造函数即注册点"的正面证据。
    assert.throws(() => new DiskFileSystem(ctx), /registered/u);
    // fsio.ts 的 resolve：空/纯空白不是"当前目录"的别名，而是坏输入
    await assert.rejects(
      () => fs.resolve("   "),
      (error: unknown) => isFsError(error, "FS_NOT_FOUND"),
    );
    // 缺席目录列不得：FS_NOT_FOUND（fsio.ts 的 listDir）；拿文件当目录列：FS_NOT_DIRECTORY（同上）
    const missing = await fs.resolve(path.join(tree().root, "nope"));
    await assert.rejects(
      () => fs.listDir(missing),
      (error: unknown) => isFsError(error, "FS_NOT_FOUND"),
    );
    const aFile = await disk(path.join(tree().root, "plain.txt"), "x");
    const fileTarget = await fs.resolve(aFile);
    await assert.rejects(
      () => fs.listDir(fileTarget),
      (error: unknown) => isFsError(error, "FS_NOT_DIRECTORY"),
    );
  });

  it("软链让别名共用同一把 targetKey，而 lstat 仍能认出末段是链（fsio.ts:165/263）", async () => {
    const { fs, root } = tree();
    await mkdir(path.join(root, "src"), { recursive: true });
    const real = await disk(path.join(root, "src", "real.ts"), "export const a = 1;\n");
    const link = path.join(root, "alias.ts");
    await symlink(real, link);
    const byReal = await fs.resolve(real);
    const byLink = await fs.resolve(link);
    // resolve 跟随软链 → 同一身份（宿主 index.ts 的 resolve + fsio.ts 的 realpath 派生）
    assert.equal(String(byLink.targetKey), String(byReal.targetKey));
    // displayPath 保留各自拼写：给 UI 看的那一位不是身份
    assert.equal(path.basename(byLink.displayPath), "alias.ts");
    // lstat 是唯一报得出 'symlink' 的那一位（fs/index.ts 的文档语义）
    const pathInfo = await fs.lstat(link);
    assert.equal(pathInfo?.type, "symlink");
    // 而 stat（跟随）报的是真身
    const followed = await fs.stat(byLink);
    assert.equal(followed?.type, "file");
  });

  it("contains 逐段判容器，同前缀兄弟目录不得被字符串前缀放行", async () => {
    const { fs, root } = tree();
    const parent = await fs.resolve(path.join(root, "proj"));
    const inside = await fs.resolve(path.join(root, "proj", "sub", "a.md"));
    const sibling = await fs.resolve(path.join(root, "proj-two", "a.md"));
    assert.equal(fs.contains(parent, inside), true);
    // 这正是本包「允许根」门禁要的判据（host.ts 注释里那条 /home/dev/project-two 审计复现）
    assert.equal(fs.contains(parent, sibling), false);
    // 自身算容器内（fs-local index.ts 的 contains，`path === ''`）
    assert.equal(fs.contains(parent, parent), true);
  });

  it("displayPath 命中物理 .. 段时保留原拼写，而身份仍是同一份", async () => {
    const { fs, root } = tree();
    await mkdir(path.join(root, "sub"), { recursive: true });
    const file = await disk(path.join(root, "sub", "a.txt"), "0123456789");
    const direct = await fs.resolve(file, { cwd: root });
    // 用字符串拼而不是 path.join：join 自己就把 `..` 归一掉了，那样根本测不到这条判据。
    const traversing = ["sub", "..", "sub", "a.txt"].join("/");
    const byTraversal = await fs.resolve(traversing, { cwd: root });
    // 宿主 localDisplayPath 在 POSIX 上命中 `..` 时原样交回拼出来的串（不 resolve）
    assert.ok(
      byTraversal.displayPath.includes(".."),
      `命中物理 .. 时 displayPath 要保留原拼写，实际 ${byTraversal.displayPath}`,
    );
    assert.notEqual(byTraversal.displayPath, direct.displayPath, "两条分支不能等价");
    // 拼写不同不影响身份：targetKey 仍归一到同一份真身
    assert.equal(String(byTraversal.targetKey), String(direct.targetKey));
  });

  it("readByteRange 走定向读，非普通文件先拦在 stat 上", async () => {
    const { fs, root } = tree();
    const file = await disk(path.join(root, "ten.txt"), "0123456789");
    const target = await fs.resolve(file);
    assert.deepEqual(
      [...(await fs.readByteRange(target, { offset: 2, length: 3 }))],
      [...new TextEncoder().encode("234")],
    );
    const empty = await fs.readByteRange(target, { offset: 0, length: 0 });
    assert.equal(empty.length, 0);
    // 目录：宿主 readByteWindow 先 statRegularFile，故拿到的是 FS_NOT_REGULAR_FILE 而不是
    // 各平台各不相同的原生 EISDIR
    await mkdir(path.join(root, "dir"), { recursive: true });
    const dir = await fs.resolve(path.join(root, "dir"));
    await assert.rejects(
      () => fs.readByteRange(dir, { offset: 0, length: 4 }),
      (error: unknown) => isFsError(error, "FS_NOT_REGULAR_FILE"),
    );
    await assert.rejects(
      () => fs.readBytes(dir, undefined, 1024),
      (error: unknown) => isFsError(error, "FS_NOT_REGULAR_FILE"),
    );
  });

  it("断链在 listDir 里落 'other'，绝不冒充 file/directory", async () => {
    const { fs, root } = tree();
    await mkdir(path.join(root, "d"), { recursive: true });
    await symlink(path.join(root, "gone.md"), path.join(root, "d", "broken.md"));
    const dir = await fs.resolve(path.join(root, "d"));
    const entries = await fs.listDir(dir);
    assert.deepEqual(
      entries.map((item) => [item.name, item.type]),
      [["broken.md", "other"]],
    );
    // 'other' 无 size：本包的摘要取舍必须把"没有 size"当成跳过而不是 0 字节读（host.ts 的 readSnippetBounded）
    assert.equal(entries[0]?.size, undefined);
  });
});

describe("collectDirContext 在真实磁盘上", () => {
  it("关键文件按稳定名序列出，非关键扩展名不带摘要，目录段只标 isDir", async () => {
    const { fs, root } = tree();
    await Promise.all([
      disk(path.join(root, PKG_JSON), '{ "name": "probe" }\n'),
      disk(path.join(root, README_MD), "# readme\n"),
      disk(path.join(root, "notes.txt"), "不是关键扩展名\n"),
      mkdir(path.join(root, "src"), { recursive: true }),
      disk(path.join(root, ".env"), "SECRET=1\n"),
    ]);
    const result = await collectDirContext(fs, root, MESSAGES);
    assert.equal(result.error, undefined);
    // 名序是**直传**（collectDirContext 不重排）：这里拿真后端自己的 listDir 顺序做判据，
    // 而不是把 en-US collation 的取值写死。写死 `package.json` 在 `README.md` 之前会让
    // 断言依赖 runner 的 locale/ICU（同一份代码在小 ICU 环境下结论不同，见 #140）。
    const listed = await fs.listDir(await fs.resolve(root));
    const listedFiles = listed.filter((item) => item.type === "file").map((item) => item.name);
    const resultFiles = result.entries.filter((item) => !item.isDir).map((item) => item.name);
    assert.deepEqual(resultFiles, listedFiles, "文件项顺序必须是 listDir 的原序（直传、不重排）");
    // 摘要取舍逐项判（比整串快照稳）：关键扩展名带摘要、非关键不带、.env 被 SECRET 规则压住。
    const byName = new Map(result.entries.map((item) => [item.name, item]));
    assert.deepEqual(
      [...byName.keys()].toSorted(),
      [".env", "README.md", PKG_JSON, "notes.txt", "src"].toSorted(),
      "条目集合",
    );
    assert.equal(
      byName.get(PKG_JSON)?.snippet?.includes('"name": "probe"'),
      true,
      "package.json 应带摘要",
    );
    assert.equal(byName.get(README_MD)?.snippet?.includes("# readme"), true, "README.md 应带摘要");
    assert.equal(byName.get("notes.txt")?.snippet, undefined, "非关键扩展名不带摘要");
    assert.deepEqual(
      result.entries.filter((item) => item.isDir).map((item) => item.name),
      ["src"],
      "目录项只此一条（位置由后端顺序决定，不按 locale 猜）",
    );
    const src = result.entries.find((item) => item.name === "src");
    assert.ok(src !== undefined, "src 目录必须列出");
    assert.equal(src.isDir, true);
    assert.equal(src.snippet, undefined, "目录永不带摘要（host.ts:759）");
    // SECRET_PATTERN 优先于扩展名：.env 就算改成 .json 也不许被摘
    assert.equal(result.entries.find((item) => item.name === ".env")?.snippet, undefined);
    assert.equal(result.truncated, false);
  });

  it("大写扩展名的 README.MD 不得静默丢数据（大小写不敏感的关键文件判据）", async () => {
    const { fs, root } = tree();
    await disk(path.join(root, "README.MD"), "大写扩展名也要有摘要\n");
    const result = await collectDirContext(fs, root, MESSAGES);
    assert.equal(result.entries[0]?.snippet, "大写扩展名也要有摘要");
    assert.equal(result.truncated, false);
  });

  it("二进制关键文件读失败 → 计入 skipped.unreadable 且 truncated 反映事实", async () => {
    const { fs, root } = tree();
    // 走字节面写入（不是字符串），让「真件按 UTF-8 解码后原样交付」这一步有出处
    await disk(path.join(root, PKG_JSON), Buffer.from('{"a":1}', "utf8"));
    // 第二枚带 NUL：真件在这里抛 FS_NOT_TEXT（fsio.ts 的 readText），桩只能凭空造一个 catch
    await disk(path.join(root, "config.JSON"), new Uint8Array([0, 0, 0, 0]));
    const result = await collectDirContext(fs, root, MESSAGES);
    assert.equal(result.skipped.unreadable, 1, "只有带 NUL 的那枚算读失败");
    assert.equal(result.skipped.tooLarge, 0);
    assert.equal(result.truncated, true, "有跳过就必须让 truncated 为真（host.ts:764）");
    assert.equal(result.entries.find((item) => item.name === "package.json")?.snippet, '{"a":1}');
  });

  it("超过 maxSnippetBytes 的整份跳过并计数；size 缺失一律不盲读", async () => {
    const { fs, root } = tree();
    const big = path.join(root, PKG_JSON);
    await disk(big, "x".repeat(4096));
    const result = await collectDirContext(fs, root, MESSAGES, {
      maxSnippetBytes: 128,
      readConcurrency: 2,
    });
    assert.equal(result.skipped.tooLarge, 1);
    assert.equal(result.entries[0]?.snippet, undefined);
    assert.equal(result.truncated, true);
    // 总量预算夹掉的也算 tooLarge（classifyRead）：这里给一份 200 字节 + 预算 150
    await rm(big);
    await disk(path.join(root, README_MD), "y".repeat(200));
    const overTotal = await collectDirContext(fs, root, MESSAGES, {
      maxSnippetBytes: 4096,
      readConcurrency: 1,
      maxTotalBytes: 150,
    });
    assert.equal(overTotal.skipped.tooLarge, 1);
    assert.equal(overTotal.entries[0]?.snippet, undefined);
  });

  it("超大文件不被读进内存：listDir 的 size 早停（真件用 sparse 文件）", async () => {
    const { fs, root } = tree();
    const huge = path.join(root, PKG_JSON);
    await disk(huge, "");
    await truncate(huge, 8 * 1024 * 1024);
    const listed = await fs.listDir(await fs.resolve(root));
    assert.equal(listed[0]?.size, 8 * 1024 * 1024, "size 来自真 stat");
    const result = await collectDirContext(fs, root, MESSAGES, {
      maxSnippetBytes: 256 * 1024,
      readConcurrency: 1,
    });
    assert.equal(result.skipped.tooLarge, 1);
    assert.equal(result.skipped.unreadable, 0, "早停不是读失败，两类计数不许混");
  });

  it("unicode 目录与正文：sizeBytes 是 UTF-8 字节数，摘要原样带出", async () => {
    const { fs, root } = tree();
    const dir = path.join(root, "角色库");
    await mkdir(dir, { recursive: true });
    await disk(path.join(dir, README_MD), README_BODY);
    const result = await collectDirContext(fs, dir, MESSAGES);
    const readme = result.entries.find((item) => item.name === "README.md");
    assert.equal(readme?.snippet, README_SNIPPET);
    const listed = await fs.listDir(await fs.resolve(dir));
    assert.equal(listed[0]?.size, Buffer.byteLength(README_BODY, "utf8"));
    assert.equal(result.cwd, dir);
  });

  it("cwd 为空串/未定义时回一句而不炸；读不了的目录回 readDirFailed", async () => {
    const { fs } = tree();
    const empty = await collectDirContext(fs, "", MESSAGES);
    assert.equal(empty.error, MESSAGES.cwdEmpty);
    assert.deepEqual(empty.entries, []);
    const missing = await collectDirContext(fs, undefined, MESSAGES);
    assert.equal(missing.error, MESSAGES.cwdEmpty, "未定义与空串同档：回一句而不是炸");
    assert.deepEqual(missing.entries, []);
    const bad = await collectDirContext(fs, path.join(tree().root, "不存在"), MESSAGES);
    assert.match(String(bad.error), /读取目录失败/u);
    assert.deepEqual(bad.entries, []);
  });
});

describe("collectAgentTemplates 在真实磁盘上", () => {
  /** 一枚最小角色 .md（parseAgentFrontmatter 要非空 name）。 */

  it("顶层 + 一层子目录都收，第三层只清点并计入 skipped.deeper", async () => {
    const { fs, root } = tree();
    await mkdir(path.join(root, "grp", "deep"), { recursive: true });
    await Promise.all([
      disk(path.join(root, "a.md"), role("甲")),
      disk(path.join(root, "grp", "b.md"), role("乙")),
      disk(path.join(root, "grp", "deep", "c.md"), role("丙")),
    ]);
    // 扫描根 = grp 时，grp/*.md 是顶层、grp/deep/*.md 是"一层子目录"，两者都收
    const fromGrp = await collectAgentTemplates(fs, "grp", root, MESSAGES, {
      skipPolicy: true,
      limits: { maxSnippetBytes: 4096, readConcurrency: 2 },
    });
    assert.equal(fromGrp.error, undefined);
    assert.deepEqual(names(fromGrp.entries), ["乙", "丙"]);
    assert.equal(fromGrp.skipped.deeper, 0);
    // 扫描根 = 工程根时，第三层（grp/deep）越界：只清点、不入条目
    const fromRoot = await collectAgentTemplates(fs, ".", root, MESSAGES, {
      skipPolicy: true,
      limits: { maxSnippetBytes: 4096, readConcurrency: 2 },
    });
    assert.equal(fromRoot.skipped.deeper, 1, "第三层的 .md 只清点不读");
    assert.deepEqual(names(fromRoot.entries), ["甲", "乙"]);
    assert.equal(
      fromRoot.entries.some((item) => item.name === "丙"),
      false,
      "第三层绝不入条目（漏掉必须记账，旧版是整批静默消失）",
    );
  });

  it("隐藏段一律不入候选：.hidden/a.md 与 .secret.md 都跳过", async () => {
    const { fs, root } = tree();
    await mkdir(path.join(root, ".hidden"), { recursive: true });
    await Promise.all([
      disk(path.join(root, ".hidden", "a.md"), role("隐藏目录里的")),
      disk(path.join(root, ".secret.md"), role("隐藏文件")),
      disk(path.join(root, "visible.md"), role("可见")),
    ]);
    const result = await collectAgentTemplates(fs, ".", root, MESSAGES, {
      skipPolicy: true,
      limits: { maxSnippetBytes: 4096, readConcurrency: 1 },
    });
    assert.deepEqual(names(result.entries), ["可见"]);
    assert.equal(result.skipped.unnamed, 0, "隐藏项不该被读进来再记成无名跳过");
  });

  it("解析不出 name 的文件计入 skipped.unnamed，绝不把原文当模板交出去", async () => {
    const { fs, root } = tree();
    await Promise.all([
      disk(path.join(root, "role.md"), role("有名字")),
      disk(path.join(root, "random.md"), "# 这只是普通文档\n"),
    ]);
    const result = await collectAgentTemplates(fs, ".", root, MESSAGES, {
      skipPolicy: true,
      limits: { maxSnippetBytes: 4096, readConcurrency: 2 },
    });
    assert.deepEqual(names(result.entries), ["有名字"]);
    assert.equal(result.skipped.deeper, 0);
    assert.equal(result.skipped.unnamed, 1);
  });

  it("软链出目录的 .md 被 contains 拦下：链外正文不得经目录扫描进来", async () => {
    const { fs, root } = tree();
    const outsideName = `organize-outside-${String(Date.now())}.md`;
    const outside = await disk(path.join(os.tmpdir(), outsideName), role("外面"));
    try {
      await mkdir(path.join(root, "roles"), { recursive: true });
      await symlink(outside, path.join(root, "roles", "leak.md"));
      await disk(path.join(root, "roles", "inside.md"), role("里面"));
      const result = await collectAgentTemplates(fs, "roles", root, MESSAGES, {
        skipPolicy: true,
        limits: { maxSnippetBytes: 4096, readConcurrency: 1 },
      });
      assert.deepEqual(
        result.entries.map((item) => item.name),
        ["里面"],
        "链外文件 realpath 后不在父目录之内，mdCandidates 的 contains 门必须拦住（host.ts:986-996）",
      );
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("单文件导入走同一套真读面，路径策略拒绝仍优先", async () => {
    const { fs, root } = tree();
    await disk(path.join(root, "solo.md"), role("单文件"));
    const single = await collectAgentTemplates(fs, "solo.md", root, MESSAGES, { skipPolicy: true });
    assert.deepEqual(names(single.entries), ["单文件"]);
    const outsideRoot = await collectAgentTemplates(
      fs,
      path.join(os.tmpdir(), "x.md"),
      root,
      MESSAGES,
      {
        allowRoots: [],
      },
    );
    assert.notEqual(outsideRoot.error, undefined, "允许根之外一律拒（host.ts:792-809）");
    assert.deepEqual(outsideRoot.entries, []);
  });
});

// ── 符号链接逃逸的四条钉（写在本包修复之前，全部实测为红）──────────────────────
//
// 为什么单独立一段：`importPathError` 判的是**字符串段**，`readText` 读的是**真实对象**，
// 两者之间只有后端的 `contains` 能收口（host.ts 的 escapesAllRoots 那段注释讲的就是这件事）。
// 手搓桩里 contains 是「parent.key 前缀 == child.key」的同义反复——桩永远配合被测代码，
// 于是「单文件分支没走 contains」「按直接父目录而不是导入根判」两处缺口在单元测试里
// 全绿。只有真磁盘 + 真 realpath 才让它们露面。
describe("符号链接逃逸：允许根外的正文一律不得进模型", () => {
  const LEAK = "LEAKED-SECRET-BODY";

  /** root/cwd 里放一条指到 root/outside 的 .md 软链，返回两边的路径。 */
  async function linkOut(prefix: string): Promise<{ cwd: string; link: string; secret: string }> {
    const { root } = tree();
    const cwdDir = path.join(root, "cwd");
    const outsideDir = path.join(root, "outside");
    await mkdir(cwdDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const secret = await disk(path.join(outsideDir, "secret.md"), roleFile("根外角色", LEAK));
    const link = path.join(cwdDir, `${prefix}.md`);
    await symlink(secret, link);
    return { cwd: cwdDir, link, secret };
  }

  it("目录扫描：软链文件的名字可以列出，正文绝不进摘要", async () => {
    const { fs } = tree();
    const { cwd, link } = await linkOut("link-out");
    await disk(path.join(cwd, "plain.md"), roleFile("普通", "普通正文"));
    const result = await collectDirContext(fs, cwd, MESSAGES);
    const leaked = result.entries.filter(
      (item) => item.name === path.basename(link) && (item.snippet ?? "").includes(LEAK),
    );
    assert.deepEqual(leaked, [], "collectDirContext 跟随软链：根外文件全文进了 system prompt");
    assert.equal(result.skipped.escaped, 1, "被安全闸门拦下的项必须数得出来");
    assert.equal(result.truncated, true, "有排除项就要让 truncated 反映事实");
    // 正例：同一层里合法的 plain.md 必须照常进摘要——只断言 escaped=1 会让「整层都被
    // 拦掉」也绿，而那正是一次过度收紧会踩的形态（见 #142）。
    assert.ok(
      (result.entries.find((item) => item.name === "plain.md")?.snippet ?? "").includes("普通正文"),
      "同层合法文件不能被逃逸闸门连带拦掉",
    );
  });

  it("单文件导入：请求路径看着在 cwd 内、真身在根外时按越界拒绝", async () => {
    const { fs } = tree();
    const { cwd, link } = await linkOut("solo-link");
    const result = await collectAgentTemplates(fs, link, cwd, MESSAGES, { allowRoots: [] });
    assert.equal(
      result.entries.filter((item) => item.text.includes(LEAK)).length,
      0,
      "单文件分支从未走 contains/lstat 复判：cwd/solo-link.md 的链外真身被当成用户角色导入了",
    );
    assert.notEqual(result.error, undefined, "越界必须回一句拒绝，而不是空列表");
    assert.equal(result.skipped.escaped, 1);
  });

  it("整棵被链接进来的子目录：判据必须是导入根，不是子项的直接父目录", async () => {
    const { fs, root } = tree();
    const cwdDir = path.join(root, "cwd");
    const outsideDir = path.join(root, "outside-roles");
    await mkdir(path.join(outsideDir, "nested"), { recursive: true });
    await mkdir(cwdDir, { recursive: true });
    await disk(path.join(outsideDir, "nested", "d.md"), roleFile("链外深层", LEAK));
    await disk(path.join(outsideDir, "top.md"), roleFile("链外顶层", LEAK));
    await disk(path.join(cwdDir, "mine.md"), roleFile("我的", "本地正文"));
    await symlink(outsideDir, path.join(cwdDir, "linkdir"));
    const result = await collectAgentTemplates(fs, cwdDir, cwdDir, MESSAGES, { allowRoots: [] });
    assert.deepEqual(
      names(result.entries),
      ["我的"],
      "linkdir 的 target 本身在根外，拿「直接父目录」当 contains 判据会把整棵链外目录放进来",
    );
    assert.ok(result.skipped.escaped > 0, "链外候选要计入 escaped，不能静默消失");
  });

  it(
    String.raw`CRLF 文件：宿主 readText 按 byte-for-byte 交付，插件必须把 \r 收掉再进 prompt`,
    async () => {
      const { fs, root } = tree();
      await disk(path.join(root, "crlf.md"), "第一行\r\n第二行\r\n");
      const result = await collectDirContext(fs, root, MESSAGES);
      const snippet = result.entries.find((item) => item.name === "crlf.md")?.snippet ?? "";
      assert.ok(snippet.includes("第一行"), "正文要进来");
      assert.ok(
        !snippet.includes("\r"),
        String.raw`client 只把 \n 压平成空格，残留的 \r 会原样进模型输入`,
      );
    },
  );
});

// ── 导入根本身是越界软链（修复前实测为红：断言 0 条实得 1 条）──────────────────
//
// 为什么单独立一段：上面那三条钉的都是「**根内的子项**被链接到根外」，靠
// `importFromDirectory` 里的 `mdCandidates`（拿导入根当父判据）拦住。而「**导入根自己**
// 就是一条指向根外的软链」是另一回事：`fs.resolve` 给的 target 已经落在允许根之外，
// 再拿它自己当 contains 的父判据必然为真——那道门形同虚设。
// 目录分支原先整批漏掉后端复判（单文件分支一直有），于是 cwd 里一条
// `roles -> ~/.ssh` 这样的软链能把根外目录里的 .md 连同正文整批导进来。
describe("导入根本身是越界软链：两条分支都必须过后端复判", () => {
  /** 泄漏哨兵：出现即代表根外正文被读走（同上面那组的口径）。 */
  const LEAK = "LEAKED-SECRET-BODY";

  /** cwd 里放一条指到 root/outside 的**目录**软链，返回两边的路径。 */
  async function linkDirToOutside(): Promise<{
    fs: DiskFileSystem;
    cwd: string;
    link: string;
  }> {
    const { fs, root } = tree();
    const cwd = path.join(root, "cwd");
    const outside = path.join(root, "outside");
    await mkdir(cwd, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.md"), roleFile("根外角色", LEAK), "utf8");
    const link = path.join(cwd, "roles");
    await symlink(outside, link);
    return { fs, cwd, link };
  }

  it("绝对路径导入软链目录 → 按越界拒绝", async () => {
    const { fs, cwd, link } = await linkDirToOutside();
    const result = await collectAgentTemplates(fs, link, cwd, MESSAGES, {
      allowRoots: [],
      limits: { maxSnippetBytes: 65_536, readConcurrency: 4 },
    });
    assert.deepEqual(names(result.entries), [], "链外目录的内容一条都不该进模型");
    assert.notEqual(result.error, undefined, "越界必须回一句拒绝，而不是空列表");
    assert.equal(result.skipped.escaped, 1, "越界要计入 escaped");
  });

  it("相对路径导入软链目录 → 同形（解析基准不同，判据一样）", async () => {
    const { fs, cwd } = await linkDirToOutside();
    const result = await collectAgentTemplates(fs, "roles", cwd, MESSAGES, {
      allowRoots: [],
      limits: { maxSnippetBytes: 65_536, readConcurrency: 4 },
    });
    assert.deepEqual(names(result.entries), [], "链外目录的内容一条都不该进模型");
    assert.equal(result.skipped.escaped, 1);
  });

  it("合法地导入允许根本身（child 就是 parent）不得被这道门误伤", async () => {
    // contains 的官方语义是「child 是 parent **或其后代**为真」（installed
    // dsh-fs/lib/types/index.d.ts）。只按 startsWith(parent+sep) 写的替身会把
    // 「导入 cwd 本身」判成越界，于是这里锁住真后端下这条合法路径仍然放行。
    const { fs, cwd } = await linkDirToOutside();
    await writeFile(path.join(cwd, "mine.md"), roleFile("我的", "本地正文"), "utf8");
    const result = await collectAgentTemplates(fs, cwd, cwd, MESSAGES, { allowRoots: [] });
    assert.deepEqual(names(result.entries), ["我的"]);
    assert.equal(result.error, undefined);
  });
});

// ── 单文件导入的字节上限（修复前实测为红：上限配 1024 仍整份读进内存）──────────
//
// 目录分支的每个候选都自带 listDir 给的 size，readCandidate 能在读之前判上限；单文件
// 导入只有一个 resolve 出来的 target，不 stat 就只能盲读——官方 readText 自述"读整份
// 文本"、没有任何上限，于是一个几 MB 的 .md 会整份进宿主内存。
describe("单文件导入的字节上限", () => {
  it("超过 maxSnippetBytes 的单文件整份跳过并计入 tooLarge（不读进内存）", async () => {
    const { fs, root } = tree();
    await disk(path.join(root, "big.md"), roleFile("大角色", "x".repeat(3 * 1024 * 1024)));
    const result = await collectAgentTemplates(fs, "big.md", root, MESSAGES, {
      allowRoots: [root],
      limits: { maxSnippetBytes: 1024, readConcurrency: 4 },
    });
    assert.deepEqual(names(result.entries), [], "超限文件一条都不该产出");
    assert.equal(result.skipped.tooLarge, 1, "超限要如实计数，不能静默消失");
    assert.equal(result.truncated, true, "truncated 必须反映「确实有东西没进来」");
  });

  it("在上限之内的单文件照常导入（这道门不是一刀切）", async () => {
    const { fs, root } = tree();
    await disk(path.join(root, "ok.md"), roleFile("小角色", "正文"));
    const result = await collectAgentTemplates(fs, "ok.md", root, MESSAGES, {
      allowRoots: [root],
      limits: { maxSnippetBytes: 65_536, readConcurrency: 4 },
    });
    assert.deepEqual(names(result.entries), ["小角色"]);
    assert.equal(result.skipped.tooLarge, 0);
  });
});

// ── 一个读不动的子目录不得让整次导入归零（修复前实测为红：0 条）────────────────
//
// mapBounded 内部是 Promise.all，worker 一抛就整批 reject，把同批已读完的结果一起丢掉，
// 上层 catch 再把整次导入变成「导入失败」。文件级读取早有降级（unreadable 计数），
// 目录枚举却漏了；mapBounded 自己的注释也写着「worker 自己负责错误降级（不抛）」。
/** 造一个 chmod 000 的子目录（POSIX 专属：Windows 上 chmod 等价于只读，列不出来造不出）。 */
async function lockDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "deep.md"), roleFile("锁内角色", "正文"), "utf8");
  await chmod(dir, 0o000);
}

/** 把一个目录的权限改回去（用例收尾要复原，否则临时树删不掉）。 */
async function unlockDir(dir: string): Promise<void> {
  await chmod(dir, 0o755);
}

// chmod 000 是 POSIX 语义：Windows 上 chmod 等价于只读，列不出来这件事根本造不出来；
// root（含容器里默认 uid 0 的 CI）也绕过 000，此时目录照样可读、断言会以「unreadable 应为 1」
// 的形式假红——所以两者都按平台/身份显式跳过，而不是在用例体内猜。
// 整族按平台跳过（而不是在用例体内分支），这样「这两条在 Windows 上没跑」在报告里
// 是显式的，而不是两条用例悄悄变绿。
// 用官方的 describe.skipIf 而不是 `const posixOnly = cond ? describe.skip : describe`：
// 后者对 linter 是「调用一个来路不明的标识符」，静态分析跟不出它是 describe，
// 于是 vitest/consistent-test-it 与 vitest/require-hook 两条都会误报（前者无从
// 判定该用 it 还是 test，后者把它当成 describe 体里的 setup 调用）。skipIf 是
// describe 上的具名成员，两条规则都认得，不需要任何豁免。
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "目录枚举逐个降级：一个坏子目录不牵连其余条目",
  () => {
    it("读不动的子目录 → 只自己计 unreadable，同层好文件照常导入", async () => {
      const { fs, root } = tree();
      const roles = path.join(root, "roles");
      const locked = path.join(roles, "locked");
      await mkdir(roles, { recursive: true });
      await disk(path.join(roles, "ok.md"), roleFile("好角色", "正文"));
      await lockDir(locked);
      try {
        const result = await collectAgentTemplates(fs, "roles", root, MESSAGES, {
          allowRoots: [root],
          limits: { maxSnippetBytes: 65_536, readConcurrency: 4 },
        });
        assert.deepEqual(names(result.entries), ["好角色"], "一个锁住的子目录不该让整次导入归零");
        assert.equal(result.error, undefined);
        assert.equal(result.skipped.unreadable, 1, "列不出来的目录要计入 unreadable");
      } finally {
        await unlockDir(locked);
      }
    });

    it("第三层目录读不动 → 同样只自己降级（清点层曾让整次导入失败）", async () => {
      const { fs, root } = tree();
      const roles = path.join(root, "roles");
      const sub = path.join(roles, "sub");
      const locked = path.join(sub, "locked");
      await mkdir(sub, { recursive: true });
      await disk(path.join(roles, "ok.md"), roleFile("好角色", "正文"));
      await lockDir(locked);
      try {
        const result = await collectAgentTemplates(fs, "roles", root, MESSAGES, {
          allowRoots: [root],
          limits: { maxSnippetBytes: 65_536, readConcurrency: 4 },
        });
        assert.deepEqual(names(result.entries), ["好角色"], "第三层读不动不该让整次导入归零");
        assert.equal(result.error, undefined);
        assert.ok(result.skipped.unreadable >= 1, "列不出来的深层目录要计入 unreadable");
      } finally {
        await unlockDir(locked);
      }
    });
  },
);
