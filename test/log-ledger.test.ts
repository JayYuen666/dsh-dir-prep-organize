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
import { logged, loggedText } from "./setup-logs.ts";

const pkgDir = path.join(import.meta.dirname, "..");

/** 模板清单钉住的前缀：源码扫描面就是它。 */
const PREFIX = "[dir-prep-organize]";

/** 扫描面：宿主半与 src 全部（机器生成的两份数据文件不产日志，不在面内）。 */
async function logSources(): Promise<{ rel: string; text: string }[]> {
  const srcDir = path.join(pkgDir, "src");
  const entries = await readdir(srcDir);
  const names = entries.filter((name) => name.endsWith(".ts") && !name.endsWith(".generated.ts"));
  const rels = ["host.ts", ...names.map((name) => `src/${name}`)];
  return Promise.all(
    rels.map(async (rel) => ({ rel, text: await readFile(path.join(pkgDir, rel), "utf8") })),
  );
}

/** 一行字面量里跟随前缀的片段：到引号、模板插值或行尾为止（跨行模板的后半由运行期
 *  的空白折叠兜住，见「空白不变」那条断言）。 */
function fragmentAfterPrefix(line: string): string {
  const at = line.indexOf(PREFIX);
  const rest = line.slice(at + PREFIX.length);
  const cut = rest.search(/["'`${]/u);
  return `${PREFIX}${cut === -1 ? rest : rest.slice(0, cut)}`.trimEnd();
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

  it("每条模板都能在源码里找到出处", async () => {
    const sources = await logSources();
    for (const fragment of LOG_TEMPLATES) {
      const found = sources.some((source) => source.text.includes(fragment));
      expect(found, `模板不在任何源码里（源码日志已改写或删除）：${fragment}`).toBe(true);
    }
  });

  it("源码里的每条日志字面量都被某条模板认领", async () => {
    const sources = await logSources();
    let literalCount = 0;
    for (const source of sources) {
      const lines = source.text.split("\n").filter((line) => line.includes(PREFIX));
      for (const line of lines) {
        literalCount += 1;
        const fragment = fragmentAfterPrefix(line);
        const claimed = LOG_TEMPLATES.some((template) => fragment.startsWith(template));
        expect(
          claimed,
          `${source.rel} 里有日志没有对应模板片段：${fragment}（test/log-templates.ts 漏登记）`,
        ).toBe(true);
      }
    }
    expect(literalCount, "扫描面不该是空的：源码里一条日志都没有").toBeGreaterThan(0);
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
