// 构建失败时「读者拿到什么」的锁。
//
// 为什么必须有：tsc 把编译诊断写在 **stdout**，工具自身崩溃与 node 的用法错误写在 stderr。
// `run()` 曾经两者的处理相反——读 stderr、把 stdout 设成 "ignore"——于是类型错误时抛出来的
// 只剩 `Command failed: node …/tsc -p …` 那一行，真正指出哪一行有错的那几行已经被丢掉。
// 这里钉住三件事：
//   1. 有 stdout 诊断时，抛出的消息就是它；
//   2. 两路都有时按 stdout、stderr 的顺序拼起来，不丢任何一路；
//   3. Buffer 形态（调用方没设 encoding 时的样子）也能读成文本。

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { diagnosticsOf, run } from "../build-types.mjs";

/** 两条诊断文本：只在断言里用；拼进子进程脚本时先转成码点，脚本源码里因此没有这串字。
 *  理由见那条用例的注释——`execFileSync` 失败时 `String(error)` 带着整条命令行，而脚本源码
 *  就写在命令行上，字面量直接进去会让「stdout 被丢掉」这一态也匹配得上。 */
const DIAGNOSTIC_A = "参考行一";

/** 第二条诊断文本。 */
const DIAGNOSTIC_B = "参考行二";

/** 把一段文本转成 `String.fromCodePoint` 的参数串（只有数字，不含原文）。 */
function codePointsOf(text: string): string {
  return Array.from(text, (char) => (char.codePointAt(0) ?? 0).toString()).join(",");
}

/** 造一个带 stdout/stderr 的错误对象，形状与 execFileSync 失败时挂出来的一致。 */
function execErrorOf(stdout: string | Buffer, stderr: string | Buffer): Error {
  const error = new Error("Command failed: node tsc -p tsconfig.types.json");
  return Object.assign(error, { stdout, stderr });
}

describe("diagnosticsOf：子进程失败时把诊断原样交回来", () => {
  it("tsc 的编译诊断在 stdout 上：只读 stderr 会把它整段丢掉", () => {
    const error = execErrorOf("src/a.ts(1,7): error TS2322: Type 'string' is not assignable", "");

    const detail = diagnosticsOf(error);

    assert.match(detail, /error TS2322/u);
    assert.match(detail, /src\/a\.ts\(1,7\)/u);
  });

  it("两路都有时都留下，顺序是 stdout 在前", () => {
    const error = execErrorOf("stdout 那一半", "stderr 那一半");

    const detail = diagnosticsOf(error);

    assert.equal(detail, "stdout 那一半\nstderr 那一半");
  });

  it("没设 encoding 时那两路是 Buffer：也读得出文本，不是空串", () => {
    const error = execErrorOf(Buffer.from("编译诊断\n"), Buffer.from("用法错误\n"));

    const detail = diagnosticsOf(error);

    assert.equal(detail, "编译诊断\n用法错误");
  });

  it("两路都空、或错误对象根本没挂这两枚属性时交回空串（调用方据此回落到 String(error)）", () => {
    assert.equal(diagnosticsOf(execErrorOf("", "")), "");
    assert.equal(diagnosticsOf(new Error("没有 stdout / stderr")), "");
    assert.equal(diagnosticsOf("不是错误对象"), "");
  });
});

describe("run：stdout 真的被接住了（不是只在纯函数上成立）", () => {
  it("子进程把诊断写到 stdout 后非零退出：抛出的消息里有那几行", () => {
    // 用 node 自己当被测子进程：它写 stdout、然后以非零码退出，与 tsc 报类型错误同形。
    // 这一条驱动的是 run 的 stdio 设置——把 stdout 退回 "ignore" 它就会红。
    const script = [
      `process.stdout.write(String.fromCodePoint(${codePointsOf(DIAGNOSTIC_A)}) + "\\n");`,
      `process.stdout.write(String.fromCodePoint(${codePointsOf(DIAGNOSTIC_B)}) + "\\n");`,
      "process.exit(1);",
    ].join("");

    let caught: unknown;
    try {
      run(process.execPath, ["-e", script]);
    } catch (error: unknown) {
      caught = error;
    }
    assert.ok(caught instanceof Error, "子进程非零退出时 run 必须抛");
    assert.match(caught.message, new RegExp(DIAGNOSTIC_A, "u"));
    assert.match(caught.message, new RegExp(DIAGNOSTIC_B, "u"));
  });
});
