// test/setup-logs.ts —— 插件运行日志的账本（vitest setupFile）。
//
// 为什么不用 vitest 的 `silent`：那只是不显示，新飘出来的日志照样没人看。这里把「跑测不该有
// 算子日志漏进报告」变成一条可判的契约：
//   ① 每条 `[<pkg>]` 日志必须含有 test/log-templates.ts 里的某个模板片段，否则当场红；
//   ② 带别家标签的日志出现在本包测试里也红（装配范围错了）；
//   ③ 生产侧一行不改：级别、文案、时机全部照旧，账本只在测试进程里接管输出。
// 用例要看日志内容时用 logged()/loggedText() 取，断言写在用例里（对这份账本自身的
// 归一化行为有 meta 测试钉着：test/log-ledger.test.ts）。
//
// 本文件按「用例串行、日志同步产出」的前提记账，**不兼容 test.concurrent**：并行用例
// 共享下面这份模块级 records，beforeEach/afterEach 交错会互相清空、互相断言。
import { afterEach, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { format, stripVTControlCharacters } from "node:util";

import { LOG_TEMPLATES } from "./log-templates.ts";

/** 本包标签前缀，如 `[dir-prep-organize]`。 */
const PKG_PREFIX = "[dir-prep-organize]";

/**
 * 接管的 console 级别。契约是「插件日志无论走哪个级别都必须被记账」，所以这里要覆盖
 * 插件代码可能用到的每一个级别：新增 console.debug/trace 一样进账本，而不是漏账。
 * 联合类型取属性索引，避免以字符串索引 Console。
 */
export type LogLevel = "info" | "warn" | "error" | "log" | "debug" | "trace";
const LEVELS: readonly LogLevel[] = ["info", "warn", "error", "log", "debug", "trace"];

/**
 * 已知由测试架/工具链打出、与本包装配无关的 `[tag]` 标签：命中它们的 `[...]` 输出不算
 * 「别家插件」。刻意从空表起步——每一条都该在真出现过一次、确认过出处之后再加，
 * 预填不存在的标签等于把未知输出静默放行。
 */
const KNOWN_TOOL_TAGS = new Set<string>();

/** 一次接管到的调用：归一化后的首参 + 其余实参原文。 */
export interface LogRecord {
  level: LogLevel;
  text: string;
  extra: unknown[];
}

let records: LogRecord[] = [];

/** 一档接管的两侧：original 是接管前的 console[level]，spy 是账本装上的处理器。 */
const installed = new Map<
  LogLevel,
  { original: (...args: unknown[]) => void; spy: (...args: unknown[]) => void }
>();

/**
 * 接管一个级别。归一化三件事：util.format 展开全部实参（`%s` 占位、Error 的正文否则
 * 静默丢失，模板匹配会假阴）、剥 ANSI 色码、折叠空白并去首尾——首参带前导空格/换行
 * 时既进不了 ours 也进不了 strangers，正好躲过整套判据。
 * 处理器单独成函数，别在 for 里现造闭包（no-loop-func 拦的就是这个）。
 */
function spyLevel(level: LogLevel): void {
  const original = console[level];
  const spy = (...args: unknown[]): void => {
    records.push({
      level,
      text: stripVTControlCharacters(format(...args))
        .replaceAll(/\s+/gu, " ")
        .trim(),
      extra: args.slice(1),
    });
  };
  console[level] = spy;
  installed.set(level, { original, spy });
}

function install(): void {
  // 已接管就短路：重复 install 会把「已是 spy 的函数」记成 original，uninstall 恢复
  // 出来的还是 spy，console 从此被永久劫持在整个测试进程里。
  if (installed.size > 0) {
    return;
  }
  for (const level of LEVELS) {
    spyLevel(level);
  }
}

function uninstall(): void {
  for (const [level, { original, spy }] of installed) {
    // 只还原自己装的：测试期间有库在 spy 之上再包一层时，无条件覆盖会拆掉对方的 patch。
    if (console[level] === spy) {
      console[level] = original;
    }
  }
  installed.clear();
}

function containsTemplate(text: string): boolean {
  return LOG_TEMPLATES.some((fragment) => text.includes(fragment));
}

beforeEach(() => {
  records = [];
  install();
});

afterEach(() => {
  try {
    const ours = records.filter((record) => record.text.startsWith(PKG_PREFIX));
    const strangers = records
      .filter((record) => record.text.startsWith("["))
      .filter((record) => !record.text.startsWith(PKG_PREFIX))
      .filter((record) => {
        const tag = /^\[(?<tag>[^\]\s]+)\]/u.exec(record.text);
        const name = tag?.groups?.["tag"];
        return name === undefined || !KNOWN_TOOL_TAGS.has(name);
      })
      .map((record) => record.text.slice(0, 120));
    const unclaimed = ours
      .filter((record) => !containsTemplate(record.text))
      .map((record) => record.text.slice(0, 120));

    assert.deepEqual(
      strangers,
      [],
      "本包测试里出现了别家插件的日志：装配范围错了。确认是测试架/工具链自己打的标签时，把它加进 KNOWN_TOOL_TAGS",
    );
    assert.deepEqual(
      unclaimed,
      [],
      "这些日志对不上本包源码里的任何模板片段：新增 console.* 没有用例认领，或消息是临时拼的",
    );
  } finally {
    uninstall();
    records = [];
  }
});

/** 本条用例产生的插件日志，按调用顺序。 */
export function logged(): readonly LogRecord[] {
  return records.filter((record) => record.text.startsWith(PKG_PREFIX));
}

/** 拼平的日志正文，便于 match 断言。 */
export function loggedText(): string {
  return logged()
    .map((record) => record.text)
    .join("\n");
}
