// test/publish-manifest.test.ts —— 发布形态门禁：入口面必须**与发布器无关**地可解析。
//
// 为什么值得一条测试：构建与单测都在源码侧跑绿，而真实故障发生在装出去之后。两类坑都在
// 那一侧。其一是入口指向没随包发出去的文件；其二是入口覆盖写在 `publishConfig` 里——
// pnpm 发布时把它合并到顶层，npm 不合并（npm 会打印
// "Unknown publishConfig config main/exports" 并忽略），同一个仓库换个发布器就发出一个
// import 必失败的包。这里不模仿任何发布器的实现，而是把不变式钉成断言：**顶层入口自己就
// 完整可解析，且 publishConfig 不再承载入口字段**，于是两套发布器语义的差恒为空。
//
// 第二组门禁扫注释：日期与轮次编号写下时有用，读的人只会困惑，且没有任何读者能从中重建
// 当时的上下文。只扫注释行与文档；测试夹具里的日期（modifiedAfter 之类的边界值）是数据，
// 角色文档里的日期是内容，两者都不在禁面内。
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { strict as assert } from "node:assert";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

/**
 * 只在注释与文档里禁的指涉：日期。
 *
 * 「轮次编号」刻意不进门禁。本仓的 `本轮` / `第 N 轮` 绝大多数指的是**会话轮次**这个产品概念
 * （`第一轮消息不支持 fork`、gate 的「下一轮重新计数」），而不是写下这段注释时的工作轮次。
 * 两种含义在中文里同形，机器分不开；要禁只能靠逐条人工判断，那不是门禁能做到的事。
 */
const FORBIDDEN_IN_COMMENTS: readonly RegExp[] = [/\b(?:19|20)\d{2}-\d{2}-\d{2}\b/u];

/** 「这一行是注释」的判据：行首（含缩进）是 //、/*、* 或 #。
 *  注释门禁与 stripComments 共用同一枚正则——两处各写一份时，一处放宽另一处没放宽，
 *  「哪些文本算注释」就出现第二种口径（曾经就是两份一模一样的字面量）。 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/u;

/** `publishConfig` 里唯一允许出现的字段：可见性与源，都不是入口面。 */
const ALLOWED_PUBLISH_CONFIG = new Set(["access", "registry"]);

/** 遍历时跳过的目录：依赖、产物、以及本门禁刻意不管的面。 */
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "_env",
  "dist",
  ".git",
  // 测试夹具里的日期与轮次编号是数据，不是注释噪音。
  "test",
  "tests",
  "__tests__",
  // 角色文档库：那里的日期是内容（例如下一份威胁报告的时间线）。
  "agents",
]);

/** package.json 里与入口面有关的形状；其余字段本门禁不关心。 */
interface Manifest {
  readonly main?: string;
  readonly types?: string;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** 一条 `files` 模式的两种形态。 */
type PatternShape =
  /** 目录或后缀模式：列该目录（可递归）下以 `extension` 结尾的文件。 */
  | {
      readonly kind: "glob";
      readonly raw: string;
      readonly dir: string;
      readonly extension: string;
    }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly raw: string; readonly file: string };

/**
 * 把 `files` 的一条模式归类。本仓实际用到的只有三种写法：裸文件名、目录名、`dir/*.ext`。
 *
 * 「精确文件名」这一档不能和后缀过滤混为一谈：把 `host.js` 当成 `.js` 后缀过滤，于是
 * `files` 里列的每个构建产物都匹配不上任何条目——`files` 覆盖这道断言的集合会空掉，门禁
 * 自己先失效。实测报出来是「main 指向 host.js，但它不在 files 覆盖范围内」。
 *
 * @param entry - `files` 数组里的一项
 * @returns 该模式要列的目录与后缀过滤，或一个精确文件名
 */
function shapeOf(rawEntry: string): PatternShape {
  // 先归一前导 "./"：不归一的话 exact 档的 existsSync 能过，但 shipped 集合里存的是
  // "./docs"，与入口清单里的 "docs" 永远对不上，门禁会报一条查不出原因的「不在 files 里」。
  const entry = rawEntry.replace(/^\.\//u, "");
  const star = entry.indexOf("*");
  if (star !== -1) {
    // 后缀取**最后一个 `*` 之后**的那一段，且必须是点号开头才算后缀过滤。
    // 从整串 lastIndexOf(".") 取会把 "locale/*"（无后缀，列全目录）算出一个空串以外的
    // 怪后缀，也会把 "n*/*.md" 这种写法算到 star 之前那个点上去——后者让 expand 展开
    // 出空集，而空集在这道门禁里等于「files 覆盖了零个文件」，静默失效。
    const tail = entry.slice(entry.lastIndexOf("*") + 1);
    const dir = entry.slice(0, star).replace(/\/$/u, "");
    return {
      kind: "glob",
      raw: rawEntry,
      dir: dir.length === 0 ? "." : dir,
      extension: tail.startsWith(".") ? tail : "",
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", raw: rawEntry, dir: entry, extension: "" };
  }
  return { kind: "exact", raw: rawEntry, file: entry };
}

/**
 * 按 `files` 模式列出包内确实存在的文件（相对包根、`/` 分隔）。
 *
 * @param shape - 见 {@link shapeOf}
 * @returns 命中的文件清单
 */
async function expand(shape: PatternShape): Promise<string[]> {
  if (shape.kind === "exact") {
    return existsSync(path.join(pkgDir, shape.file)) ? [shape.file] : [];
  }
  const dir = path.join(pkgDir, shape.dir);
  // 目录不存在时 readdir 抛的是裸 ENOENT：看不出是哪一条 files 写坏了，也分不清
  // 「files 写错」与「产物没构建」。这里点名模式与解析后的目录，再去列。
  assert.ok(
    existsSync(dir),
    `files 里的 "${shape.raw}" 指向不存在的路径 ${shape.dir}：先确认产物是否已构建`,
  );
  const names = await readdir(dir, { recursive: shape.dir !== "." });
  return names
    .map((name) => name.split(path.sep).join("/"))
    .filter((name) => shape.extension === "" || name.endsWith(shape.extension))
    .map((name) => path.posix.join(shape.dir, name));
}

/**
 * 递归收集一条 `exports` 值里的具体目标文件。通配条目（值含 `*`）没有可验证的固定文件。
 *
 * @param value - `exports` 里某一键的值（字符串或条件对象）
 * @returns 该条目要求存在的包内路径
 */
function filesOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value.includes("*") ? [] : [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap((nested) => filesOf(nested));
  }
  return [];
}

/** 入口目标的相对形态（去掉 `./` 前缀）。 */
function asRelative(target: string): string {
  return target.replace(/^\.\//u, "");
}

/**
 * manifest 里全部需要落地的入口文件：main、types 与每个 exports 具体目标。
 *
 * @param manifest - 解析后的 package.json
 * @returns 目标清单，每项带来源标签以便失败时点名
 */
function entryFiles(manifest: Manifest): readonly { label: string; file: string }[] {
  // exports 也可以是单个字符串/条件对象（这条路径合法且常见于只发一个入口的包）。
  // 直接 Object.entries 一个字符串会把它拆成「逐字符」的键值对，于是 filesOf 收到单个
  // 字符、断言拿字符当路径——比忽略更糟。这里按形态分档，非对象就走 filesOf 整份展开。
  const flat =
    typeof manifest.exports === "object"
      ? Object.entries(manifest.exports).flatMap(([specifier, value]) =>
          filesOf(value).map((file) => ({ label: specifier, file })),
        )
      : filesOf(manifest.exports).map((file) => ({ label: "exports", file }));
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
}

/** 正则元字符集合（含反斜杠本身）：逐字符判，比维护一条转义正则更直白。 */
const BACKSLASH = String.fromCodePoint(92);
const REGEX_SPECIAL_CHARS = new Set([
  ".",
  "*",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  BACKSLASH,
]);

/** 正则转义：把一段字面量塞进 RegExp 之前先转义，导出名里的 `.`/`$` 才不会被当元字符。 */
function escapeRegExp(value: string): string {
  return value
    .split("")
    .map((char) => (REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char))
    .join("");
}

/** 发布器无条件附带的文件：不受 `files` 约束，但也不该由门禁去断言它在 `files` 里。 */
const ALWAYS_SHIPPED = [
  "package.json",
  "README.md",
  "README.zh.md",
  "README.zh-CN.md",
  "LICENSE",
  "CHANGELOG.md",
];

/**
 * 第三方声明文件。npm 只自动附带 README 与 LICENSE，**不带**它——所以必须由 `files` 显式带上，
 * 而不能指望发布器的默认行为。agents/ 整库来自上游项目，其 MIT 声明要求随软件副本分发。
 */
const THIRD_PARTY_NOTICES = "THIRD_PARTY_NOTICES.md";

/** 声明入口（package.json 的 `types` 指向它），也是「types/ 是否产出」的存在性锚点。 */
const DECLARATION_ENTRY = "types/host.d.ts";

/**
 * 运行期才会被读到的构建产物。
 *
 * 它们都不是 `exports` 的入口（entryFiles 那条断言管不到），却同样是构建出来的、同样必须
 * 随包发出去：`host.js` 由宿主按包名载入，`templates.data.mjs` 由 host.js 在 default-templates
 * 端点第一次被请求时 import。漏发任何一个，本地构建与单测都是绿的，只有装出去才会炸。
 */
const RUNTIME_ARTIFACTS = ["host.js", "client.js", "templates.data.mjs"];

/**
 * 读 manifest 与它应当发出去的文件清单。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurfaceOnce(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
}

/** readSurface 的进程内缓存：同一个测试文件里有六处要这同一份磁盘面，读六遍既不快也没有新信息。
 *  缓存的是 Promise 而不是结果，于是并发的两处调用也只真跑一遍。 */
let surface: Promise<{ manifest: Manifest; shipped: Set<string> }> | undefined;

/**
 * 读 manifest 与它应当发出去的文件清单（本文件内只真读一次）。
 *
 * @returns manifest 本体与 `files` 展开后的集合（含发布器无条件附带的件）
 */
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  surface ??= readSurfaceOnce();
  return surface;
}

/**
 * 递归收集该纳入注释门禁的源文件与文档（相对包根、`/` 分隔）。
 *
 * @param dir - 当前目录的绝对路径
 * @param prefix - 相对包根的前缀
 * @returns 命中的文件清单
 */
async function collectSources(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  // 每个条目一个 promise 再一起等：顺序无关，而顺序相关的写法（循环里 await）在这里既
  // 慢又没有对应的正确性理由——收集的是文件名集合，先返回谁都一样。
  const groups = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          return [];
        }
        const nested = await collectSources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        return nested;
      }
      if (/\.(?:ts|tsx|mjs|yml|md)$/u.test(entry.name)) {
        return [`${prefix}${entry.name}`];
      }
      return [];
    }),
  );
  return groups.flat();
}

/**
 * 取一段文本里属于注释或文档的行。文档（`.md`）整体算；代码只取注释行，免得把字符串
 * 字面量里的数据（日期夹具、示例路径）误判成注释噪音。
 *
 * @param file - 相对包根的文件名，用于决定判定口径
 * @param text - 文件全文
 * @returns 参与门禁的行
 */
function commentLines(file: string, text: string): string[] {
  if (file.endsWith(".md")) {
    return text.split("\n");
  }
  return text.split("\n").filter((line) => COMMENT_LINE.test(line));
}

/** 版本 → 可逐位比较的整数键：`[major, minor, patch, 有无预发布]`。 */
function versionKey(value: string): number[] {
  const [core = "", pre = ""] = value.split("-", 2);
  const parts = core.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre === "" ? 1 : 0];
}

/**
 * `version >= bound`：三元组按数字比，同三元组下正式版 ≥ 预发布版。
 *
 * 自己写而不是引 semver：semver 在本仓只是传递依赖，pnpm 隔离的 node_modules 下测试文件
 * 根本 import 不到它；为一个十几行的比较引入一个直接依赖不划算。
 *
 * 刻意的简化：**同一三元组下两个不同预发布之间的标识符细序不比**。本门禁的输入形态是
 * 「peer 下界 vs 精确钉版或更新钉版」，两者要么三元组不同、要么其中一个本就是正式版，
 * 落不到这一档；真落进去也只是少拦一次版本错配，而不是把对的判成错的。
 *
 * @param version - 待判版本
 * @param bound - 下界版本
 * @returns version 是否不小于 bound
 */
function atLeast(version: string, bound: string): boolean {
  const left = versionKey(version);
  const right = versionKey(bound);
  for (const index of [0, 1, 2, 3]) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff > 0;
    }
  }
  return true;
}

/**
 * 取区间声明的下界版本：`>=X`、`^X`、裸 `X` 都落到 X；`A || B` 取各段下界里**最低**的
 * 那个，它才代表「声称支持的最老宿主」。
 *
 * 遇到没见过的写法返回空串，让下游断言**失败**而不是静默放过：一条看不懂的区间声明
 * 不该被判为合规。
 *
 * @param range - package.json 里的区间串
 * @returns 下界版本号；写法不认识时为空串
 */
function lowerBoundOf(range: string): string {
  const bounds = range
    .split("||")
    .map(
      (part) =>
        /^\s*(?:>=|\^)?\s*(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/u.exec(part)?.groups?.[
          "version"
        ] ?? "",
    );
  if (bounds.some((bound) => bound === "")) {
    return "";
  }
  return (
    bounds.toSorted((left, right) => {
      if (left === right) {
        return 0;
      }
      return atLeast(left, right) ? 1 : -1;
    })[0] ?? ""
  );
}

/** 宿主包名前缀：`@deepseek-ai/` 整族，含 cordis / cosmokit / schemastery 这几枚不同版本的底座。 */
const HOST_PREFIX = "@deepseek-ai/";

/** dsh-* 包名前缀：本门禁里按它筛选依赖，提出来免得三处各抄一遍。 */
const DSH_PREFIX = "@deepseek-ai/dsh-";

describe("发布形态", () => {
  it("files 覆盖全部入口目标（换个发布器也不会发出悬空入口）", async () => {
    const { manifest, shipped } = await readSurface();
    const targets = entryFiles(manifest);
    expect(targets.length, "入口面不该是空的").toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        shipped.has(asRelative(target.file)),
        `${target.label} 指向 ${target.file}，但它不在 files 覆盖范围内`,
      ).toBe(true);
    }
  });

  it("入口一律指向构建产物，源码目录不参与发布", async () => {
    const { manifest } = await readSurface();
    for (const target of entryFiles(manifest)) {
      // `.d.ts` 也是产物：`build:types` 从源码 emit 出来的声明文件。把它判成源码，这道门就
      // 变成了「禁止发类型」，而类型恰恰是这道门想守住的东西。真正要挡的是 `.ts` / `.tsx`。
      const isDeclaration = target.file.endsWith(".d.ts");
      expect(
        isDeclaration || !/\.tsx?$/u.test(target.file),
        `${target.label} 不该指源码：${target.file}`,
      ).toBe(true);
    }
  });

  it("第三方声明随包发出（agents/ 来自上游项目，MIT 要求声明随副本分发）", async () => {
    const { shipped } = await readSurface();
    expect(
      shipped.has(THIRD_PARTY_NOTICES),
      `${THIRD_PARTY_NOTICES} 必须列进 files：npm 不会自动附带它，漏了就等于没随包分发上游声明`,
    ).toBe(true);
  });

  it("声明产物覆盖全部运行时导出（types 不能停在旧源码上）", async () => {
    // host.js 的新鲜度由 test/build-host.test.ts 逐字节门禁守着；声明产物没有等价门禁，
    // 于是它可能悄悄停在上一次 emit 的源码上——症状是消费方拿到类型却缺导出，只有他们看得见。
    // 这里反向比对：从源码取运行时导出名，要求声明文件里每个都出现。
    const runtimeExports = Object.keys(await import("../host.ts")).toSorted();
    expect(runtimeExports.length, "运行时导出不该是空的").toBeGreaterThan(0);
    const declaration = await readFile(path.join(pkgDir, DECLARATION_ENTRY), "utf8");
    for (const name of runtimeExports) {
      // 不能写成 \b${name}\b：导出名本身要正则转义（名字里可能有 $），而 \b 对以 $
      // 开头/结尾的名字不成立——那会让一条真缺失的导出现在「查得到」。改用「两侧都不是
      // 标识符字符」的边界，标识符字符集按 JS 取 [\w$]。
      expect(
        new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "u").test(declaration),
        `声明文件缺少运行时导出 ${name}：多半是 types/ 停在了旧源码上，请运行 npm run build:types`,
      ).toBe(true);
    }
  });

  it("声明产物不含本机绝对路径或包管理器内部路径", async () => {
    // 声明文件现在随包发布，路径泄漏从「仓库内问题」变成「分发问题」：消费方的类型检查
    // 会去解析一个指向别人机器的 specifier，报出来的是一条比原始故障更难查的错。
    // recursive readdir 把目录也一并交回；按后缀收成文件，否则下一步 readFile 撞 EISDIR。
    const entries = await readdir(path.join(pkgDir, "types"), { recursive: true });
    const files = entries.filter((file) => file.endsWith(".d.ts"));
    expect(files.length, "types/ 至少该产出一个声明文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      files.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, "types", file), "utf8"),
      })),
    );
    for (const entry of texts) {
      // 源码按 NodeNext 约定写显式 `.ts` 后缀，声明产物会原样抄下来，于是声明会指向包里根本
      // 不存在的 `src/x.ts`（只有 `src/x.d.ts`）。build-types.mjs 把相对说明符改写成 `.js`
      // 正是为了这个；漏跑后处理的症状就是这里红。
      expect(
        /from\s*["']\.{1,2}\/[^"']*\.ts["']/u.test(entry.text),
        `types/${entry.file} 的相对说明符仍指源码 .ts，消费方解析不到`,
      ).toBe(false);
      for (const leak of [/(?:^|[^\w.])\/(?:Users|home)\//u, /\.pnpm[\\/]/u]) {
        expect(leak.test(entry.text), `types/${entry.file} 泄漏了本机或包管理器内部路径`).toBe(
          false,
        );
      }
    }
  });

  it("publishConfig 只留可见性与源，不留入口覆盖", async () => {
    const { manifest } = await readSurface();
    for (const key of Object.keys(manifest.publishConfig ?? {})) {
      expect(ALLOWED_PUBLISH_CONFIG.has(key), `publishConfig.${key} 会被 npm 忽略`).toBe(true);
    }
  });

  it("构建产物逐个进 files（少一个就是运行期才炸的那类故障）", async () => {
    // 这些不是入口，不走 entryFiles 那条断言；而它们全部是**运行期才被读到**的文件：
    // host.js 由宿主按包名载入，templates.data.mjs 由 host.js 在端点第一次被请求时 import。
    // 漏发一个，构建与单测全绿，装出去之后才炸——所以在这里钉成断言。
    const { shipped } = await readSurface();
    for (const artifact of RUNTIME_ARTIFACTS) {
      expect(shipped.has(artifact), `${artifact} 是构建产物，必须列进 files`).toBe(true);
    }
  });
});

describe("宿主依赖的版本形状（升级防线）", () => {
  it("@deepseek-ai/* 一律不进 dependencies：装出去会在宿主进程里物化第二份", async () => {
    // 钉的是「全绿但宿主瘫痪」这一类坑，别把它当风格偏好，更别把任何 @deepseek-ai/*「恢复」回
    // dependencies。本插件被装进消费方 profile 的口径是 `nodeLinker: hoisted` 且
    // `autoInstallPeers: false`（见 pnpm-workspace.yaml），所以 `dependencies` 里的每一枚宿主包
    // 都会在那棵 profile 依赖树里落成**真实目录**，与宿主进程已经加载的那份并存在一起。
    // 而 `@deepseek-ai/dsh-tools` 的 TOOL_RUNTIME_SCHEDULER 是普通 `Symbol`（不是 `Symbol.for`），
    // 符号身份按模块实例计算：宿主的 dsh-agent-loop 用自己那份的 Symbol 去读由副本挂载出来的
    // ToolRuntime，拿到 `undefined`，于是 `.prepare(...)` 在**每一次**原生工具调用上抛
    // "Cannot read properties of undefined (reading 'prepare')"，整个 profile 的工具一起失效。
    // 本包的构建、类型检查与测试在此之前全部照绿，判据只能落在 manifest 面。
    // 运行期真要用的那两枚（host.js 值导入 dsh-brand 与 schemastery）走**非 optional 的 peer**：
    // 宿主在场提供，而 profile 不装 peer，所以不产生副本；只被声明产物引用的 cosmokit 是 optional
    // peer。外部化名单读 dependencies ∪ peerDependencies（build-host.mjs），因此挪进 peer 之后
    // 产物里的裸说明符一字不变——挪去 dev 才会被 rolldown 内联，那由 test/build-host.test.ts 拦。
    const { manifest } = await readSurface();
    const leaked = Object.keys(manifest.dependencies ?? {}).filter((name) =>
      name.startsWith(HOST_PREFIX),
    );
    expect(leaked, "这些宿主包会随消费方装进 profile，物化出第二份实例").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让本包在没有测试的
    // 情况下换掉编译用的宿主类型面。
    // 只判 dev 这一侧：它才是本包真正装下来的那一份。peer 记的是「运行期由宿主提供」，
    // 装什么版本由宿主决定，那一条判据在下面。
    const { manifest } = await readSurface();
    const dshDeps = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDeps.length, "至少要钉住一枚 dsh-* 开发依赖，否则这道门是空转").toBeGreaterThan(0);
    const ranged = dshDeps.filter(([, range]) => !/^\d+\.\d+\.\d+-/u.test(range));
    expect(ranged, "这些 dsh-* 开发依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("devDependencies 里的 dsh-* 彼此同版本，且不高于 peer 支持窗口的下界", async () => {
    // 旧写法是「dsh-* 的版本号 == peer 去掉 ^/~ 后的版本号」。那在 peer 是**单点范围**
    // 时成立，因为那时「宿主支持哪个版本」和「本包构建于哪个版本」是同一个数。peer 放宽成
    // 窗口范围之后，两个事实就分家了，混成一条断言的后果是二选一：要么放宽就必然误报，
    // 要么为了门禁绿而不敢放宽。于是拆成各自成立的两条不变式。
    //
    // 真正要防的故障是「同一个会话里出现同一枚宿主包的两份拷贝」——它不报编译错，
    // 只在运行期报「认不出这个 callId」，是本仓最难查的一类问题。那一面读 dev：
    // devDependencies 里的 dsh-* 才是编译期真实存在的那份类型面。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 依赖缺失：支持窗口就失去基准了").toBeDefined();
    // ① 全部 dsh-* 开发依赖钉同一个版本。
    const installed = Object.entries(manifest.devDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(installed.length, "至少要钉住一枚 dsh-* 开发依赖，否则这条是空转").toBeGreaterThan(0);
    expect(new Set(installed.map(([, range]) => range)).size, "dsh-* 钉在了不同版本上").toBe(1);
    const pinned = installed[0]?.[1] ?? "";
    // ② 不高于 peer 下界：钉的版本比声称支持的宿主区间还高，就是「装得上、跑不了」。
    const bound = lowerBoundOf(peer ?? "");
    // 空串必须在这里**直接**断言，不能指望下游 atLeast 顺带报警：versionKey("") 解析成
    // [0,0,0,1]，跟任何真实版本比都是「更大」，于是看不懂的区间会被静默判为通过——
    // 而这正是这条不变式最危险的失效方向：区间写错了，门禁却报绿。
    expect(
      bound,
      `peer 区间「${peer}」的写法认不出来（本门禁只支持 >=X / ^X / 裸 X 及其 || 组合）`,
    ).not.toBe("");
    for (const [name] of installed) {
      expect(
        atLeast(pinned, bound),
        `${name}@${pinned} 高于 peer 下界 ${bound}，会在更老的宿主上装出一个跑不了的包`,
      ).toBe(true);
    }
  });
});

/**
 * 声明产物里的裸说明符：`from "x"` 与 `import("x")` 引号内那一段。
 * 用前后向断言而不是捕获组——本仓 tsc 的 `noPropertyAccessFromIndexSignature` 与 oxlint 的
 * `dot-notation` 对具名组的字面量键互斥（点访问报 TS4111，方括号报 dot-notation），
 * 零组则直接取 `match[0]`，两边都不烫。
 */
const DECLARATION_SPECIFIER = /(?<=\bfrom\s*["']|\bimport\(\s*["'])[^"']+(?=["'])/gu;

/**
 * 把一条说明符收成**包名**（剥掉子路径），供与 manifest 的表键比对。
 *
 * @param specifier - 声明产物里出现的一条说明符
 * @returns 包名；相对路径与 `node:` 内置返回 undefined（它们不由 manifest 决定能否解析）
 */
function packageNameOf(specifier: string): string | undefined {
  const segments = specifier.split("/");
  const bare = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
  // 相对路径与 `node:` 内置不参与 manifest 比对：那两类由消费方自己的运行时决定能否解析。
  return specifier.startsWith(".") || bare.startsWith("node:") ? undefined : bare;
}

/**
 * 扫出一棵目录里所有 `.d.ts` 引用到的包名。
 *
 * @param dir - 声明产物目录
 * @returns 被引用的包名集合
 */
async function declarationPackages(dir: string): Promise<Set<string>> {
  const listed = await readdir(dir, { recursive: true });
  const texts = await Promise.all(
    listed
      .map((name) => name.split(path.sep).join("/"))
      .filter((rel) => rel.endsWith(".d.ts"))
      .map((rel) => readFile(path.join(dir, rel), "utf8")),
  );
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(DECLARATION_SPECIFIER)) {
      const pkg = packageNameOf(match[0]);
      if (pkg !== undefined) {
        found.add(pkg);
      }
    }
  }
  return found;
}

/**
 * 参与「引用面」扫描的文件后缀：源码、构建脚本、配置与测试。
 *
 * `tsx` 不在列内——本包不产 tsx，留着只会让将来任何 tsx 夹具悄悄逃过判定。
 */
const REFERENCE_SUFFIXES = /\.(?:ts|mts|cjs|mjs)$/u;

/**
 * 引用面扫描跳过的目录。
 *
 * 不能沿用注释门禁那张 {@link SKIP_DIRS}：它贴着 `test`，而集成层的四个用例恰好是宿主包
 * 唯一的引用现场（`dsh-app-boot` / `dsh-config-editor` 只在测试里 import）。照抄过去会让
 * 这道门一开工就把它们判成孤儿，然后有人把它们删掉、集成测试当场红。
 */
const CODE_SKIP_DIRS = new Set(["node_modules", "coverage", "_env", "dist", ".git", "agents"]);

/**
 * 免检的直接依赖：以「引用面」判会被误杀的例外，键是包名，值是为什么必须留着。
 *
 * 每条都必须是**可复查的事实**，不是习惯。加一条就等于承认这道门在这一处不成立，所以
 * 宁可留空也要先按实证办法（摘掉→跑 typecheck+test）试一遍。
 */
const REFERENCE_EXEMPTION: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis-plugin-include":
    "dsh-config-editor 的必填 peer（settings-boot 起真 Loader 时由它 import）：本仓 autoInstallPeers 为 false，peer 不会被自动装，缺它即整个套件在 import 阶段失败。",
  "@deepseek-ai/dsh-scope":
    "dsh-session 的必填 peer：本仓 autoInstallPeers 为 false，pnpm 不替我们装 peer，集成层起真 SessionStore 时缺它即 import 失败（roundtrip）。",
  "@deepseek-ai/dsh-home-paths":
    "dsh-app-boot 的必填 peer：同上，autoInstallPeers 为 false 时不会被自动装；settings-boot 用真 Loader 启动时缺它即 import 失败。",
  "@deepseek-ai/dsh-launch-environment":
    "dsh-app-boot 的必填 peer：同上；补上 home-paths 之后紧接着缺的就是它，app-boot 一被 import 就要。",
};

/**
 * 去掉整行注释与块注释：注释里的包名不算引用面。
 *
 * 顺序必须是**先按行剥、再剥块**：本仓注释里会出现 `fetch('/_dsh/dir-prep/*')` 这种带
 * `/*` 的示例路径，先跑块注释正则会从那一处一路吞到下一个 `*\/`，把整段 import 当成注释
 * 抹掉——那道「必须有引用面」的门于是把 host.ts 真正 import 的包全判成孤儿。
 */
function stripComments(text: string): string {
  const lines = text.split("\n").filter((line) => !COMMENT_LINE.test(line));
  return lines.join("\n").replaceAll(/\/\*[\s\S]*?\*\//gu, " ");
}

/**
 * 扫一棵目录里**非注释文本**里出现的引号串，收成包名。
 *
 * 为什么按引号串而不是只按 `from "…"`：构建脚本的 externalNames 是一张裸字符串表
 * （build-host.mjs 里那张），那同样是「代码按名字引用了这枚包」。为什么先去注释：本仓注释里
 * 大量讨论宿主包名（`peer 面`、`第二份实例` 的成因就写在注释里），留着注释等于让门禁自己
 * 判定自己——注释提一句就算引用，那道门就空转了。
 *
 * @param dir - 起始目录或文件路径
 * @param found - 累积的包名集合（就地累加，返回同一枚引用）
 * @param exempt - 不参与扫描的文件模式（本门禁自身要点名 peer 名，构成自引用）
 * @returns 累积后的包名集合
 */
async function codePackages(
  dir: string,
  found: Set<string>,
  exempt: readonly RegExp[] = [],
): Promise<Set<string>> {
  const info = await stat(dir);
  if (info.isFile()) {
    if (!REFERENCE_SUFFIXES.test(dir) || exempt.some((pattern) => pattern.test(dir))) {
      return found;
    }
    const text = await readFile(dir, "utf8");
    for (const match of stripComments(text).matchAll(/["'`](?<specifier>[^"'`\n]+)["'`]/gu)) {
      const pkg = packageNameOf(match.groups?.["specifier"] ?? "");
      if (pkg !== undefined) {
        found.add(pkg);
      }
    }
    return found;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => !CODE_SKIP_DIRS.has(entry.name))
      .map((entry) => codePackages(path.join(dir, entry.name), found, exempt)),
  );
  return found;
}

describe("声明产物的可解析性（升级防线）", () => {
  it("types/ 引用的每枚宿主包都落在 peer 表：否则消费方的声明入口过不了类型检查", async () => {
    // 判据取**产物**而不是源码：type-only 导入在 host.ts 里随构建擦除，却原样留在
    // types/host.d.ts 的裸说明符里。消费方那侧只按 manifest 装依赖，声明里没这个名字
    // 就是 TS2307，而本仓自己的 typecheck 全照绿——dev 与 peer 两张表我们都有它。
    // 宿主包不许进 dependencies（见上面那条门禁），所以唯一的合法落点就是 peer。
    const { manifest } = await readSurface();
    const referenced = await declarationPackages(path.join(pkgDir, "types"));
    expect(referenced.size, "至少要扫到一枚被声明产物引用的包，否则这道门是空转").toBeGreaterThan(
      0,
    );
    const missing = [...referenced]
      .filter((name) => name.startsWith(HOST_PREFIX))
      .filter((name) => manifest.peerDependencies?.[name] === undefined)
      .toSorted();
    expect(missing, "这些宿主包只被声明产物引用，却没声明为 peer").toStrictEqual([]);
  });

  it("每枚宿主 devDependency 都要有引用面：代码按名引用它，或声明产物点名它", async () => {
    // 这一条是「为填 peer 而加依赖」的防线。事故形态很具体：给集成层装真宿主时，有人把
    // `@deepseek-ai/dsh-app-boot` 的 5 枚 peer（cordis-plugin-group / cordis-plugin-include /
    // dsh-home-paths / dsh-launch-environment / dsh-system-prompt）逐一写进 devDependencies，
    // 仓库里没有任何文件按名字引用过它们一次。后果不在发布物（宿主包一律不进 dependencies，
    // 见上面那条门禁），而在依赖树：多装 5 枚真实目录，升级时人人都得替它们做版本决定。
    //
    // 那条判据的原始前提是「pnpm 的 auto-install-peers 本就会装 peer」。本仓 pnpm-workspace.yaml
    // 里 autoInstallPeers 是 false，前提不成立：peer 一枚都不会被自动装。伞根那次安装走的是 pnpm
    // 默认值（true），所以 dev 态 check 一直绿、而仓自己的 CI 装完就缺这几枚。例外表里那几条因此
    // 不是「为填 peer 而加」的重演，是 autoInstallPeers: false 下必须由本仓自己声明的 peer 闭包。
    // 判据取两处并集：代码里的引号串（import 说明符 + 构建脚本的 external 名单），以及
    // types/ 点名的裸说明符（type-only 面，见下面那条 peer 门禁的同一份读法）。
    // 剩下的缺口是「有引用但引用面是死代码」——那归覆盖率与 lint 管，不在本门禁扩面。
    const { manifest } = await readSurface();
    const declared = Object.keys(manifest.devDependencies ?? {}).filter((name) =>
      name.startsWith(HOST_PREFIX),
    );
    expect(declared.length, "至少要有一枚宿主 devDependency，否则这道门是空转").toBeGreaterThan(0);

    const cited = new Set([
      ...(await declarationPackages(path.join(pkgDir, "types"))),
      ...(await codePackages(pkgDir, new Set<string>(), [/publish-manifest\.test\.ts$/u])),
    ]);
    const orphans = declared
      .filter((name) => !cited.has(name))
      .filter((name) => REFERENCE_EXEMPTION[name] === undefined)
      .toSorted();
    expect(orphans, "这些宿主包没有引用面：删掉，或在例外表里写明依据").toStrictEqual([]);

    // 例外表不许长草：条目对应的包一旦重新有了引用面（或已被删掉），就该从表里摘走。
    const stale = Object.entries(REFERENCE_EXEMPTION)
      .filter(([name]) => cited.has(name) || manifest.devDependencies?.[name] === undefined)
      .map(([name, reason]) => `${name}（${reason}）`)
      .toSorted();
    expect(stale, "这些引用面例外已经不再成立").toStrictEqual([]);
  });
});

describe("注释与文档没有内部指涉", () => {
  it("源码与文档的注释里没有日期", async () => {
    const collected = await collectSources(pkgDir, "");
    const sources = collected.toSorted();
    expect(sources.length, "至少要扫到源码文件").toBeGreaterThan(0);
    const texts = await Promise.all(
      sources.map(async (file) => ({
        file,
        text: await readFile(path.join(pkgDir, file), "utf8"),
      })),
    );
    for (const entry of texts) {
      for (const line of commentLines(entry.file, entry.text)) {
        for (const pattern of FORBIDDEN_IN_COMMENTS) {
          expect(
            pattern.test(line),
            `${entry.file} 的注释命中内部指涉 ${pattern}：${line.trim().slice(0, 80)}`,
          ).toBe(false);
        }
      }
    }
  });
});

/** 版本字面量在本段反复出现，提为常量：断言要钉的是规则，逐处手抄版本号只会抄错。 */
const V_RC2 = "0.2.0-rc.2";
const V_ALPHA1 = "0.2.1-alpha.1";
const V_ALPHA2 = "0.2.1-alpha.2";
const V_BETA = "0.2.1-beta";
const V_PLAIN = "0.2.1";

describe("版本区间比较（门禁自带的两个纯函数）", () => {
  it("lowerBoundOf 只认 >=X / ^X / 裸 X，其余写法返回空串", () => {
    assert.equal(lowerBoundOf(`>=${V_RC2}`), V_RC2);
    assert.equal(lowerBoundOf(`^${V_ALPHA1}`), V_ALPHA1);
    assert.equal(lowerBoundOf(V_PLAIN), V_PLAIN);
    assert.equal(lowerBoundOf(">= 0.2.0"), "0.2.0", ">= 与版本号之间的空白容忍");
    // 不认识 → 空串，断言会红而不是静默放行
    assert.equal(lowerBoundOf(">=0.2.0 <0.3.0"), "");
    assert.equal(lowerBoundOf("*"), "");
    assert.equal(lowerBoundOf(""), "");
  });

  it("atLeast：三元组按数字比，预发布排在正式版之前", () => {
    assert.equal(atLeast(V_ALPHA1, V_RC2), true, "patch 更大");
    assert.equal(atLeast("0.3.0", V_RC2), true, "minor 更大");
    assert.equal(atLeast("1.0.0", V_RC2), true, "major 更大");
    assert.equal(atLeast(V_RC2, V_RC2), true, "相等");
    assert.equal(atLeast("0.1.9", V_RC2), false, "minor 更小");
  });

  it("atLeast：同一三元组下，带预发布者小于正式版", () => {
    assert.equal(atLeast(V_PLAIN, V_ALPHA1), true, "正式版 >= 预发布");
    assert.equal(atLeast(V_ALPHA1, V_PLAIN), false, "预发布 < 正式版");
    assert.equal(atLeast(V_ALPHA1, V_ALPHA1), true, "同为预发布且相同");
  });

  it("atLeast：同三元组下两个预发布判为相等（文档里写明的简化，不是漏判）", () => {
    // semver 会逐标识符比 alpha < beta；这里刻意不比。本门禁的输入形态是
    // 「peer 下界 vs 精确钉版或更新钉版」，落不到这一档。
    assert.equal(atLeast(V_ALPHA1, V_BETA), true);
    assert.equal(atLeast(V_BETA, V_ALPHA1), true);
    assert.equal(atLeast(V_ALPHA2, V_ALPHA1), true);
  });
});
