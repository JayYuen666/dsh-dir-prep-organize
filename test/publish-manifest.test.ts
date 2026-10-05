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
import { readFile, readdir } from "node:fs/promises";
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

describe("宿主依赖的版本形状（升级防线）", () => {
  it("dsh-* 家族一律精确钉，不留任何范围算子", async () => {
    // registry 上的 dist-tag 是实测出来的陷阱：`latest` 可能指向远早于宿主 ABI 的版本。
    // 精确钉是让「不带版本地装成远古版本」这件事不可能发生的最小条件；一旦放宽成 `^`/`~`，
    // 宿主某天发新 minor 就会自动跟上去，而插件与宿主 ABI 耦合，那等于让消费方在没有测试的
    // 情况下换掉宿主类型面。
    const { manifest } = await readSurface();
    // 过滤出违规项再一次性断言，而不是在循环里按条件 expect：失败时 diff 直接列出
    // 「哪个包钉成了什么」，比逐条抛错更好读。
    const ranged = Object.entries(manifest.dependencies ?? {}).filter(
      ([name, range]) => name.startsWith(DSH_PREFIX) && !/^\d+\.\d+\.\d+-/u.test(range),
    );
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
    const devDeps = manifest.devDependencies ?? {};

    const runtime = Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
      name.startsWith(DSH_PREFIX),
    );
    // ①② 全部 dsh-*（运行期 + 构建期）钉同一个版本。只比 dependencies 不够——
    // devDependencies 里的 dsh-* 同样是编译期真实存在的类型面，两边分家就会出现
    // 「同一个会话里两份宿主包」，而它不报编译错、只在运行期报「认不出这个 callId」。
    const allDsh = [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(devDeps),
    ].filter(([name]) => name.startsWith(DSH_PREFIX));
    expect(new Set(allDsh.map(([, range]) => range)).size, "dsh-* 钉在了不同版本上").toBe(1);
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
