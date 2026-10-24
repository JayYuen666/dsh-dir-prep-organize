// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 用 `settings.register(ns, Schema.object({...}), base)` 注册 N 个设置字段，
// client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改 settings 底层或
// 读源码。曾踩过的坑：quality-gate 的 `memoryFeedback`（功能性开关——host.ts 的
// `if (cfg.memoryFeedback !== false)` 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，反复审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 的用例里断言一次；helper 交回**问题清单**，
// 空数组即通过 —— 同 client-freshness.ts 的理由）：
//   assert.deepEqual(schemaCoverageProblems(import.meta.url), []);
//   assert.deepEqual(schemaCoverageProblems(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   }), []);
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 boundFieldsIn）。它会**漏拦**也会**假绿**：
//   · 多认（注释里的 set('x')、别的对象上的同名键）→ 门禁更宽松，那是已知代价；
//   · 少认（组件是 .tsx、字段名拼在模板串里）→ 功能性缺失被放过，那是真漏拦。
// 所以注释与字符串外的文本先剥一遍（stripComments），扩展名白名单也收 .tsx；剩下的
// 假阳性靠「豁免表反向校验」与人工审查兜。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 字符串或注释的跨度：`end` 是它之后的下标，`quote` 是跨过之后所处的引号状态。 */
interface LiteralSpan {
  readonly end: number;
  readonly quote: string;
  readonly kind: "comment" | "string";
}

/** 行注释/块注释的收尾下标（找不到收尾就吃到文末）。 */
function commentEndAfter(text: string, index: number): number {
  const isLine = text.charAt(index + 1) === "/";
  const stop = isLine ? text.indexOf("\n", index) : text.indexOf("*/", index + 2);
  if (stop === -1) {
    return text.length;
  }
  return isLine ? stop : stop + 2;
}

const isQuoteChar = (char: string): boolean => char === '"' || char === "'" || char === "`";

/**
 * `index` 处若是字符串/注释的开头（或正处在字符串内部），交回它的跨度；否则交回 `null`。
 *
 * 三处文本扫描（取字段名、配括号、剥注释）都要认同一套字面量边界，抄三份就会三处不同步，
 * 所以只在这里定义一次。转义只认反斜杠（模板串里的 `${}` 不需要特判：里面出现的括号属于
 * 表达式，本来该参与配对）。
 */
function literalAt(text: string, index: number, quote: string): LiteralSpan | null {
  const char = text.charAt(index);
  const next = text.charAt(index + 1);
  let span: LiteralSpan | null = null;
  if (quote !== "") {
    const end = index + (char === "\\" ? 2 : 1);
    const nextQuote = char === "\\" || char !== quote ? quote : "";
    span = { end, quote: nextQuote, kind: "string" };
  } else if (char === "/" && (next === "/" || next === "*")) {
    span = { end: commentEndAfter(text, index), quote: "", kind: "comment" };
  } else if (isQuoteChar(char)) {
    span = { end: index + 1, quote: char, kind: "string" };
  }
  return span;
}

/** `index` 处的「顶层键」：词首的标识符且其后紧跟冒号。 */
function keyAt(block: string, index: number): { name: string; end: number } | null {
  const char = block.charAt(index);
  const prev = index === 0 ? "" : block.charAt(index - 1);
  const startsWord = /[A-Za-z_$]/u.test(char) && (prev === "" || /[\s,{[(]/u.test(prev));
  const name = startsWord ? (/^[A-Za-z_$][\w$]*/u.exec(block.slice(index))?.[0] ?? "") : "";
  const isKey =
    name !== "" &&
    block
      .slice(index + name.length)
      .trimStart()
      .startsWith(":");
  return isKey ? { name, end: index + name.length } : null;
}

/**
 * 对象字面量的**顶层**键（逐字符扫描，不用行首缩进猜层级）。
 *
 * 按行首两个空格取键的旧写法有两个洞：① 单行写法
 * `Schema.object({ a: Schema.string(), b: Schema.string() })` 一个键都取不到；② 缩进一旦
 * 不是两格（一层嵌套对象恰好也缩两格、或被格式化到四格）就会把嵌套键当顶层键。改成按
 * 花括号/圆括号/方括号的深度扫：深度 0 处的 `标识符:` 才是这个对象的顶层键（入参是
 * 去掉外层花括号之后的块体）。
 */
function literalTopLevelKeys(block: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  for (let index = 0; index < block.length; index += 1) {
    const span = literalAt(block, index, quote);
    const char = block.charAt(index);
    const key = span === null && quote === "" && depth === 0 ? keyAt(block, index) : null;
    if (span !== null) {
      ({ quote } = span);
      index = span.end - 1;
    } else if (key !== null) {
      out.push(key.name);
      index = key.end - 1;
    } else if (char === "{" || char === "(" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
    }
  }
  return out;
}

/** 配括号的行走状态。 */
interface BracketWalk {
  started: boolean;
  depth: number;
  out: string;
}

/**
 * 非字面量位置的一步。交回 `true` 表示刚收到配平的右括号（区段到此结束）。
 *
 * 拆出来不是因为这段逻辑复杂，而是主循环里「跳过字面量」与「数括号」两件事混在一起时
 * 认知复杂度会越过 15（本仓 sonarjs 的门槛），读的人还得同时记住两个状态。
 */
function bracketStep(
  state: BracketWalk,
  char: string,
  openChar: string,
  closeChar: string,
): boolean {
  if (!state.started) {
    state.started = char === openChar;
    state.depth = state.started ? 1 : 0;
    return false;
  }
  if (char === openChar) {
    state.depth += 1;
    state.out += char;
    return false;
  }
  if (char !== closeChar) {
    state.out += char;
    return false;
  }
  state.depth -= 1;
  if (state.depth === 0) {
    return true;
  }
  state.out += char;
  return false;
}

/**
 * 从 `open` 处的括号起取配对括号内的文本；没配对上时返回空串。
 *
 * 字符串、模板串与注释里的括号不参与配对——旧实现按字符数深度，块里只要出现 `")"`
 * 或一行 `// )` 就会提前收尾，块后半段的字段全被截掉，而唯一失败判据是「字段数为 0」，
 * 部分截断不会报错。
 */
function sliceInside(text: string, open: number, openChar: string, closeChar: string): string {
  const state: BracketWalk = { started: false, depth: 0, out: "" };
  let quote = "";
  for (let index = open; index < text.length; index += 1) {
    const span = literalAt(text, index, quote);
    if (span !== null) {
      state.out += span.kind === "comment" ? "" : text.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    } else if (bracketStep(state, text.charAt(index), openChar, closeChar)) {
      return state.out;
    }
  }
  return "";
}

/** 括号家族的两个便捷入口（花括号取对象字面量、圆括号取实参）。 */
const bracesAt = (text: string, open: number): string => sliceInside(text, open, "{", "}");
const parensAt = (text: string, open: number): string => sliceInside(text, open, "(", ")");

/** `Schema.object(` 的实参 → 字段名；字面量直取顶层键，标识符回溯到同名 const 字面量。 */
function fieldsOfSchemaArgument(hostTs: string, argument: string): string[] {
  const trimmed = argument.trim();
  if (trimmed.startsWith("{")) {
    return literalTopLevelKeys(trimmed.slice(1, -1));
  }
  const identifier = /^(?<name>[A-Za-z_$][\w$]*)$/u.exec(trimmed)?.groups?.["name"] ?? "";
  if (identifier === "") {
    return [];
  }
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier}\\s*(?::[^=]+)?=\\s*\\{`,
    "u",
  ).exec(hostTs);
  if (declaration === null) {
    return [];
  }
  return literalTopLevelKeys(bracesAt(hostTs, declaration.index + declaration[0].length - 1));
}

/**
 * 去掉注释（块注释整段抹掉、行注释抹到行尾），保留字符串原样。
 *
 * 绑定识别的两条正则都要扫**这条之后**的文本：否则被注释掉的旧代码、废弃分支里的
 * `field: 'x'` / `set('x')` 会算成"已绑定"，卡片明明没有那个控件却过门禁——这是漏拦
 * （假绿），比多认几个名字严重得多。字符串里的内容不抹：要认的字段名本身就写在字符串里
 * （`set("importAllowRoots")`），抹了等于一个都认不出。
 */
function stripComments(src: string): string {
  let out = "";
  let quote = "";
  for (let index = 0; index < src.length; index += 1) {
    const span = literalAt(src, index, quote);
    if (span === null) {
      out += src.charAt(index);
    } else {
      out += span.kind === "comment" ? "" : src.slice(index, span.end);
      ({ quote } = span);
      index = span.end - 1;
    }
  }
  return out;
}

/**
 * 从 host.ts 抽取**全部** `Schema.object(...)` 块内的字段名（并集）。
 *
 * 旧实现只取第一个块，而"第一个"是不是设置 schema 取决于源码书写顺序：设置 schema
 * 内联成 `Schema.object({...})` 的包（lesson-loop / quality-gate / session-rescue /
 * zvec-grep）恰好是，本包不是——本包第一个是 `TemplateEntrySchema`（`templates` 数组的
 * 元素形状），设置 schema 却是 `Schema.object(configShape)`（实参是标识符）。
 *
 * 现在两种形态都收：实参是字面量就直接取顶层键，是标识符就回溯到同名 `const` 字面量，
 * 两者并集。解析不了的块**不再静默跳过**，而是由调用方把块首原文报成问题项——否则
 * "解析器少认了一种写法"和"这个包没有设置 schema"在结果上无法区分，门禁会悄悄缩小范围。
 */
function hostSchemaFields(source: string): { fields: string[]; unresolved: string[] } {
  // 先剥注释再找块：注释里写着的 `Schema.object({ legacy: 1 })` 也是一处字面匹配，
  // 拿它当块起点会把 `legacy` 收进字段全集，随后报成「卡片未暴露」——一条纯属虚构的
  // 漏项。字符串不剥（`"Schema.object("` 这种内容不影响块起点判定，且字段名本身在字符串里）。
  const hostTs = stripComments(source);
  const marker = "Schema.object(";
  const fields = new Set<string>();
  const unresolved: string[] = [];
  let from = 0;
  for (;;) {
    const start = hostTs.indexOf(marker, from);
    if (start === -1) {
      break;
    }
    from = start + marker.length;
    const open = hostTs.indexOf("(", start);
    const argument = open === -1 ? "" : parensAt(hostTs, open);
    const parsed = argument === "" ? [] : fieldsOfSchemaArgument(hostTs, argument);
    if (parsed.length === 0) {
      unresolved.push(
        argument === "" ? `${marker}… 的括号没有配对` : `${marker}${argument.trim().slice(0, 40)})`,
      );
    }
    for (const field of parsed) {
      fields.add(field);
    }
  }
  return { fields: [...fields], unresolved };
}

/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(source: string): Set<string> {
  const src = stripComments(source);
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 schemaCoverageProblems 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 卡片源码的扩展名白名单：组件可能是 .tsx，别只看 .ts。 */
const CLIENT_SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"] as const;

/** 递归收集目录下所有卡片源文件文本（跳过 node_modules，不跟随软链，IO 失败不抛）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  let entries;
  try {
    // withFileTypes 一次拿到类型，省掉每条目一次 statSync；isSymbolicLink 不跟随，
    // 否则目录自指的软链会让这里无限递归（或 ELOOP）。
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // 读不动就是读不动：调用方的契约是「交回问题清单」，不该在这里抛。
    return out;
  }
  for (const entry of entries) {
    const usable = entry.name !== "node_modules" && !entry.isSymbolicLink();
    const filePath = path.join(dir, entry.name);
    if (!usable) {
      // 跳过依赖树与软链（后者可能自指，跟随就会无限递归）。
    } else if (entry.isDirectory()) {
      out.push(...walk(filePath));
    } else if (CLIENT_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      try {
        out.push(readFileSync(filePath, "utf8"));
      } catch {
        // 同上：读不到就跳过，别让门禁自己炸。
      }
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（只扫 `src/` 与 `lib/` 两棵树，包根下的单文件不在其中）。 */
function clientBoundFields(pkgDir: string): Set<string> {
  const out = new Set<string>();
  for (const src of [...walk(path.join(pkgDir, "src")), ...walk(path.join(pkgDir, "lib"))]) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/**
 * 「卡片字段覆盖 host schema」门禁的问题清单（空数组即通过）。
 *
 * 交回清单而不是自己登记用例：登记只能发生在用例文件的 describe/用例体内，
 * 且断言得写在那个体内才看得见（vitest require-hook + expect-expect）。
 * 调用点写法见本文件头。
 */
export function schemaCoverageProblems(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): string[] {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  // 契约是「交回问题清单，空数组即通过」。读不到包根文件时抛 ENOENT 会让调用方只看到一条
  // 难以定位的异常（assert.deepEqual 撞上它连断言都到不了），所以这里转成问题项。
  const readOrProblem = (name: string): string | null => {
    try {
      return readFileSync(path.resolve(pkgDir, name), "utf8");
    } catch {
      // 读不到就交回 null：调用方把这一态报成问题项，而不是让门禁抛出去。
      return null;
    }
  };
  const pkgJson = readOrProblem("package.json");
  if (pkgJson === null) {
    return [
      `[schema-coverage] 读不到 ${pkgDir}/package.json：包目录推导错了，或测试文件不在包根的下一层`,
    ];
  }
  const pkgName = /"name":\s*"(?<name>[^"]+)"/u.exec(pkgJson)?.groups?.["name"] ?? "unknown";
  const hostTs = readOrProblem("host.ts");
  if (hostTs === null) {
    return [`[${pkgName}] 读不到 ${pkgDir}/host.ts：卡片字段覆盖门禁要求 host 与测试同仓`];
  }
  const { fields: hostFields, unresolved } = hostSchemaFields(hostTs);
  const bound = clientBoundFields(pkgDir);
  const declared = opts.allowUnbound ?? [];
  const exemptions = new Map(declared.map((item) => [item.field, item.reason]));
  const problems: string[] = [];
  // 重复声明：Map 会让后者静默覆盖前者（两份理由只剩一份），这本身就是该报的账。
  const duplicated = [
    ...new Set(
      declared
        .map((item) => item.field)
        .filter((field, index, all) => all.indexOf(field) !== index),
    ),
  ];
  if (duplicated.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 有重复条目（后一条会覆盖前一条的理由）：${duplicated.join(", ")}`,
    );
  }

  // 解析不了的 Schema.object 块单独报：否则"本包换了写法"与"本包没有设置 schema"结果相同，
  // 门禁会静默缩小到一个子集上照绿。
  if (unresolved.length > 0) {
    problems.push(
      [
        `[${pkgName}] 以下 Schema.object 块的字段名解析不出来（改了解析器认得的写法）：`,
        ...unresolved.map((snippet) => `  ${snippet}`),
        `→ 让 test/schema-coverage.ts 的 fieldsOfSchemaArgument 认这种写法，别再靠"解析失败就跳过"。`,
      ].join("\n"),
    );
  }
  if (hostFields.length === 0) {
    problems.push("host.ts 未找到 Schema.object 字段（解析失败或该包无设置）");
  }
  const missing = hostFields.filter((field) => !bound.has(field));
  const unexempted = missing.filter((field) => !exemptions.has(field));
  if (unexempted.length > 0) {
    problems.push(
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 schemaCoverageProblems 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免项必须在 host 字段里真的存在：拼错字段名或 host 侧改名之后，这条豁免会静默失效，
  // 而它本该是「可审计的显式声明」——写错的豁免等于没写，却看起来写了。
  const unknownExemptions = [...exemptions.keys()].filter((field) => !hostFields.includes(field));
  if (unknownExemptions.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 指向了 host schema 里不存在的字段（拼错或 host 侧已改名）：${unknownExemptions.join(", ")}`,
    );
  }
  // 豁免必须有理由，否则等于无门禁。
  const noReason = [...exemptions].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
  );
  if (noReason.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  }
  return problems;
}
