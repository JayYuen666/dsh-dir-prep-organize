// test/log-ledger.test.ts —— 日志账本自身的守卫。
//
// 两件事：
//   ① test/log-templates.ts 自称「由源码扫出、勿手改」，但生成它的只有人：这里双向比对
//      源码里的 `[dir-prep-organize]` 字面量与模板清单——源码日志被改写/删除时清单里的
//      死模板会点名，新增 console.* 漏登记也会点名；顺带钉住清单本身的形状（冻结、
//      非空、无重复、空白折叠后不变）。
//   ② test/setup-logs.ts 的归一化与查询面（logged/loggedText/级别覆盖）此前没有任何
//      用例消费，改坏不会有人发现。这里用「账本自测」的形态：本文件也在 setupFile 的
//      管辖下，自产的日志必须自带模板片段，否则 afterEach 先红。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LOG_TEMPLATES } from "./log-templates.ts";
// 标签单源：前缀与账本共用同一枚常量，包改名时不会两处各写一份（见 #203）。
import { PKG_PREFIX, logged, loggedText } from "./setup-logs.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 模板清单钉住的前缀：源码扫描面就是它。 */
const PREFIX = PKG_PREFIX;

/** 扫描面：宿主半与 src **整棵子树**（机器生成的 .generated.ts 不产日志，不在面内）。 */
async function logSources(): Promise<{ rel: string; text: string }[]> {
  const srcDir = path.join(pkgDir, "src");
  const entries = await readdir(srcDir, { recursive: true, withFileTypes: true });
  const rels = ["host.ts"];
  const included = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".generated.ts"),
  );
  for (const entry of included) {
    rels.push(path.relative(pkgDir, path.join(entry.parentPath, entry.name)));
  }
  return Promise.all(
    rels.map(async (rel) => ({ rel, text: await readFile(path.join(pkgDir, rel), "utf8") })),
  );
}

/** 空白折叠：账本按 util.format 折叠后的文本匹配，静态片段也要同一口径。 */
function fold(text: string): string {
  return text.split(/\s+/u).join(" ").trim();
}

/** 源码里的一处 console.* 调用：级别 + 首个字面量实参的静态前缀（到插值/引号为止）。 */
interface LogCallSite {
  readonly rel: string;
  readonly level: string;
  readonly staticText: string;
}

const CONSOLE_CALL = /console\.(?<level>log|info|warn|error|debug|trace)\(\s*(?<quote>["'`])/gu;

/**
 * 首参字面量的结束下标：跳过 `\\x` 这类转义，反引号里遇 `${` 立即截止。
 */
function literalEnd(text: string, start: number, quote: string): number {
  let end = start;
  let escaped = false;
  while (end < text.length) {
    const char = text[end];
    if (escaped) {
      escaped = false;
      end += 1;
    } else if (char === "\\") {
      escaped = true;
      end += 1;
    } else if (char === quote || (quote === "`" && char === "$" && text[end + 1] === "{")) {
      break;
    } else {
      end += 1;
    }
  }
  return end;
}

/**
 * 扫「真调用点」而不是「任意含前缀的行」：注释、字符串里提到前缀都不算日志，
 * 而漏掉调用点正是「无前缀的 console.* 两侧都看不见」的形态。
 * 首参不是字面量的调用（`console.error(err)`）单独报出：它无从与模板比对。
 */
function logCallSites(rel: string, text: string): { sites: LogCallSite[]; nonLiteral: string[] } {
  const sites: LogCallSite[] = [];
  const nonLiteral: string[] = [];
  for (const match of text.matchAll(CONSOLE_CALL)) {
    const level = match.groups?.["level"] ?? "?";
    const quote = match.groups?.["quote"] ?? '"';
    const start = match.index + match[0].length;
    const staticText = fold(text.slice(start, literalEnd(text, start, quote)));
    if (staticText.startsWith(PREFIX)) {
      sites.push({ rel, level, staticText });
    } else {
      nonLiteral.push(`${rel} console.${level}(${staticText.slice(0, 80) || "非字面量实参"})`);
    }
  }
  return { sites, nonLiteral };
}

/** 全扫描面（host.ts + src 整棵子树）的调用点汇总。 */
async function allCallSites(): Promise<{ sites: LogCallSite[]; nonLiteral: string[] }> {
  const sites: LogCallSite[] = [];
  const nonLiteral: string[] = [];
  for (const source of await logSources()) {
    const scan = logCallSites(source.rel, source.text);
    sites.push(...scan.sites);
    nonLiteral.push(...scan.nonLiteral);
  }
  return { sites, nonLiteral };
}

describe("模板清单与源码日志字面量互为镜像", () => {
  it("清单在运行时冻结、非空、无重复、无空串", () => {
    expect(Object.isFrozen(LOG_TEMPLATES), "共享常量必须运行时冻结").toBe(true);
    expect(LOG_TEMPLATES.length).toBeGreaterThan(0);
    expect(new Set(LOG_TEMPLATES).size, "清单里有重复片段").toBe(LOG_TEMPLATES.length);
    expect(
      LOG_TEMPLATES.every((fragment) => fragment.length > 0),
      "清单里有空串",
    ).toBe(true);
  });

  it("每条模板都是空白折叠不变的（账本按折叠后的文本匹配）", () => {
    for (const fragment of LOG_TEMPLATES) {
      expect(fragment.split(/\s+/u).join(" ").trim(), `片段含连续/首尾空白：${fragment}`).toBe(
        fragment,
      );
    }
  });

  it("每条模板都能在源码的 console.* 调用点里找到出处（不再按含前缀的行粗筛）", async () => {
    const { sites } = await allCallSites();
    for (const template of LOG_TEMPLATES) {
      const found = sites.some((site) => site.staticText === template);
      expect(
        found,
        `模板在源码里没有逐字对应的调用点（日志被改写/删除/换行形态变了）：${template}`,
      ).toBe(true);
    }
  });

  it("源码里每个 console.* 调用点都被某条模板认领（首参必须是带前缀的字面量）", async () => {
    const { sites, nonLiteral } = await allCallSites();
    expect(
      nonLiteral,
      `这些调用点的首参不是带 ${PREFIX} 前缀的字面量：账本按首参静态文本比对，非字面量（或漏前缀）的日志两侧都看不见，等于不受账本约束：\n${nonLiteral.join("\n")}`,
    ).toStrictEqual([]);
    for (const site of sites) {
      const claimed = LOG_TEMPLATES.some((template) => template === site.staticText);
      expect(
        claimed,
        `${site.rel} 的 console.${site.level} 没有对应模板片段：${site.staticText}（test/log-templates.ts 漏登记）`,
      ).toBe(true);
    }
    expect(sites.length, "扫描面不该是空的：源码里一条日志都没有").toBeGreaterThan(0);
  });
});

describe("setup-logs 账本自身的归一化与查询面", () => {
  it("记录展开 %s 占位、剥 ANSI、折叠空白并去首尾，logged/loggedText 都能取到", () => {
    // util.format 只拿首参当格式串：占位符与其余实参都在这一条里（真实日志的形状）。
    console.error(
      "  [dir-prep-organize] templates settings write failed: %s→\n%s",
      "\u001B[31mred\u001B[0m",
      "tail",
    );
    const records = logged();
    expect(records, "本条用例的日志要能取回").toHaveLength(1);
    expect(records[0]?.level).toBe("error");
    expect(records[0]?.text).toBe("[dir-prep-organize] templates settings write failed: red→ tail");
    expect(loggedText()).toBe(records[0]?.text);
  });

  it("loggedText 把多条记录按换行连起来（单条时与 logged()[0].text 同形）", () => {
    console.error(`${PREFIX} templates settings write failed: first`);
    console.warn(`${PREFIX} templates settings write failed: second`);
    const records = logged();
    expect(records).toHaveLength(2);
    expect(loggedText()).toBe(records.map((record) => record.text).join("\n"));
    expect(loggedText().split("\n")).toHaveLength(2);
  });

  it("debug 与 trace 同样进账本（级别清单漏掉就漏账）", () => {
    // 基线 no-console 的 allow 面不含 debug/trace；账本接管的全局 console 正是这里要调的东西。
    // oxlint-disable-next-line no-console
    console.debug(`${PREFIX} templates settings write failed: via debug`);
    // oxlint-disable-next-line no-console
    console.trace(`${PREFIX} templates settings write failed: via trace`);
    const levels = logged().map((record) => record.level);
    expect(levels).toContain("debug");
    expect(levels).toContain("trace");
  });
});
