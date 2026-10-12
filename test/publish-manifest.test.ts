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
  | { readonly kind: "glob"; readonly dir: string; readonly extension: string }
  /** 精确文件名：带点号又无通配的条目是**文件名**（`host.js`），不是后缀过滤。 */
  | { readonly kind: "exact"; readonly file: string };

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
function shapeOf(entry: string): PatternShape {
  const dot = entry.lastIndexOf(".");
  const star = entry.indexOf("*");
  if (star !== -1) {
    return {
      kind: "glob",
      dir: entry.slice(0, star).replace(/\/$/u, ""),
      extension: entry.slice(dot),
    };
  }
  if (!entry.includes(".")) {
    return { kind: "glob", dir: entry, extension: "" };
  }
  return { kind: "exact", file: entry };
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
  const names = await readdir(path.join(pkgDir, shape.dir), { recursive: shape.dir !== "." });
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
  const flat = Object.entries(manifest.exports ?? {}).flatMap(([specifier, value]) =>
    filesOf(value).map((file) => ({ label: specifier, file })),
  );
  const scalars = [
    ...(typeof manifest.main === "string" ? [{ label: "main", file: manifest.main }] : []),
    ...(typeof manifest.types === "string" ? [{ label: "types", file: manifest.types }] : []),
  ];
  return [...scalars, ...flat];
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
async function readSurface(): Promise<{ manifest: Manifest; shipped: Set<string> }> {
  const manifest = JSON.parse(
    await readFile(path.join(pkgDir, "package.json"), "utf8"),
  ) as unknown as Manifest;
  const groups = await Promise.all((manifest.files ?? []).map((entry) => expand(shapeOf(entry))));
  const attached = ALWAYS_SHIPPED.filter((name) => existsSync(path.join(pkgDir, name)));
  return { manifest, shipped: new Set([...groups.flat(), ...attached]) };
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
  return text.split("\n").filter((line) => /^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
}

/**
 * 取区间声明的下界版本：`>=X`、`^X`、裸 `X` 三种写法都落到 X。
 *
 * 只认这三种——本仓 peer 只用这三种。遇到没见过的写法返回空串，让下游断言**失败**
 * 而不是静默放过：一条看不懂的区间声明不该被判为合规。
 *
 * @param range - package.json 里的区间串
 * @returns 下界版本号；写法不认识时为空串
 */
function lowerBoundOf(range: string): string {
  return (
    /^\s*(?:>=|\^)?\s*(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/u.exec(range)?.groups?.[
      "version"
    ] ?? ""
  );
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
      expect(
        new RegExp(`\\b${name}\\b`, "u").test(declaration),
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

/**
 * 宿主包在 peer 与 dev 两张表里的并集。`dependencies` 是禁区（见下面那条门禁）：peer 记录
 * 「运行期由宿主提供」，dev 记录「本包编译与测试要用它」，两者都不会被消费方的 profile 安装。
 * 同名键以 peer 表为准，那才是消费方环境里真正提供的那一枚。
 *
 * @param manifest - 解析后的 package.json
 * @returns 宿主包名到版本区间
 */
function hostRanges(manifest: Manifest): Record<string, string> {
  return { ...manifest.devDependencies, ...manifest.peerDependencies };
}

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

  it("dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不可能发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让消费方在没有测试的
    // 情况下换掉宿主类型面。
    const { manifest } = await readSurface();
    // 判据读 peer ∪ dev，不读 dependencies——宿主包已经不在那张表里了（见上一条门禁），照着
    // dependencies 读只会得到一个空集，于是这道门自己先静默失效。
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const dshDeps = Object.entries(hostRanges(manifest)).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    expect(dshDeps.length, "至少要钉住一枚 dsh-* 宿主依赖，否则这道门是空转").toBeGreaterThan(0);
    const ranged = dshDeps.filter(([, range]) => !/^\d+\.\d+\.\d+-/u.test(range));
    expect(ranged, "这些 dsh-* 依赖没有精确钉住版本").toStrictEqual([]);
  });

  it("运行期 dsh-* 彼此同版本、与构建版本一致、且不高于 peer 的下界", async () => {
    // 旧写法是「dsh-* 的版本号 == peer 去掉 ^/~ 后的版本号」。那在 peer 是**单点范围**
    // （`^0.2.1-alpha.1`）时成立，因为那时「宿主支持哪个版本」和「本包构建于哪个版本」
    // 是同一个数。peer 一旦放宽成 `>=0.2.0-rc.2` 这种区间，两个事实就分家了：
    //   peer      = 对**宿主**的声明（本包声称能在哪些宿主上跑）
    //   依赖钉版  = 对**自己**的声明（本包是在哪个宿主版本上构建并测过的）
    // 混成一条断言的后果是二选一：要么放宽 peer 就必然误报，要么为了门禁绿而不敢放宽。
    // 于是拆成三条各自成立的不变式。
    //
    // 真正要防的故障是「同一个会话里出现同一枚宿主包的两份拷贝」——它不报编译错，
    // 只在运行期报「认不出这个 callId」，是本仓最难查的一类问题。
    const { manifest } = await readSurface();
    const peer = manifest.peerDependencies?.["@deepseek-ai/dsh"];
    expect(peer, "peer 依赖缺失：宿主版本就失去基准了").toBeDefined();
    const host = hostRanges(manifest);

    // ①② 全部 dsh-*（运行期的 peer + 构建期的 dev）钉同一个版本。只比一张表不够——
    // devDependencies 里的 dsh-* 同样是编译期真实存在的类型面，两边分家就会出现
    // 「同一个会话里两份宿主包」，而它不报编译错、只在运行期报「认不出这个 callId」。
    // 宿主包现在一律落 peer 与 dev（见上面那条门禁），hostRanges 的并集就是这两张表，
    // 没有第三个来源要并进来；读 dependencies 只会拿到空集，①② 便成了空转。
    const allDsh = Object.entries(host).filter(([name]) => name.startsWith(DSH_PREFIX));
    expect(new Set(allDsh.map(([, range]) => range)).size, "dsh-* 钉在了不同版本上").toBe(1);
    // ③ 的基准取**运行期**那一面：peer 表里的 dsh-* 才是消费方环境真正提供的那几枚。
    const runtime = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    const pinned = runtime[0]?.[1] ?? "";
    // ③ 不高于 peer 下界：钉的版本比声称支持的宿主区间还高，就是「装得上、跑不了」。
    const bound = lowerBoundOf(peer ?? "");
    // 空串必须在这里**直接**断言，不能指望下游 atLeast 顺带报警：versionKey("") 解析成
    // [0,0,0,1]，跟任何真实版本比都是「更大」，于是看不懂的区间会被静默判为通过——
    // 而这正是这条不变式最危险的失效方向：区间写错了，门禁却报绿。
    expect(bound, `peer 区间「${peer}」的写法认不出来（本门禁只支持 >=X / ^X / 裸 X）`).not.toBe(
      "",
    );
    for (const [name] of runtime) {
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
const REFERENCE_EXEMPTION: Readonly<Record<string, string>> = {};

/**
 * 去掉整行注释与块注释：注释里的包名不算引用面。
 *
 * 顺序必须是**先按行剥、再剥块**：本仓注释里会出现 `fetch('/_dsh/dir-prep/*')` 这种带
 * `/*` 的示例路径，先跑块注释正则会从那一处一路吞到下一个 `*\/`，把整段 import 当成注释
 * 抹掉——那道「必须有引用面」的门于是把 host.ts 真正 import 的包全判成孤儿。
 */
function stripComments(text: string): string {
  const lines = text.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*|#)/u.test(line));
  return lines.join("\n").replaceAll(/\/\*[\s\S]*?\*\//gu, " ");
}

/**
 * 扫一棵目录里**非注释文本**里出现的引号串，收成包名。
 *
 * 为什么按引号串而不是只按 `from "…"`：构建脚本的 externalNames 是一张裸字符串表
 * （build-host.mjs:47），那同样是「代码按名字引用了这枚包」。为什么先去注释：本仓注释里
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
    // 而 pnpm 的 auto-install-peers 本就会装它们，仓库里没有任何文件按名字引用过它们一次。
    // 后果不在发布物（宿主包一律不进 dependencies，见上面那条门禁），而在依赖树：多装 5 枚
    // 真实目录，升级时人人都得替它们做版本决定，而没人读它们。
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
