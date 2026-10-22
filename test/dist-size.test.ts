// test/dist-size.test.ts —— 产物体积闸门。
//
// 为什么要有：`pnpm run check` 的顺序是 build 在 test 之前，所以这道门读到的是**当轮刚产出**
// 的产物，不是上一次遗留的。它挡的是「有人在切面里塞进大对象字面量或整段查表」这类回退——
// 它们不会让任何现有用例变红（体积不是行为），所以必须有一道单独的尺子。
//
// 预算怎么定的：取当前实测值上浮约 15%，向上取整到 500 B。留这些余量是给正常演进的——
// 加一条规则、改一句文案不该立刻要人改预算；翻倍一定会顶穿。真需要突破时，改这些常量并写明理由。
//
// templates.data.mjs 是上游精选模板表的生成物（scripts/gen-defaults.mjs 产出），体积主要跟着
// 数据量走；把它纳入同一道门是因为它与 host.js 一样随包发布、在第一次请求时被载入。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(import.meta.dirname, "..");

/** 拦截半产物体积预算（实测 75,557 B）。 */
const HOST_BUDGET_BYTES = 87_000;
/** 客户端半产物体积预算（实测 78,388 B）。 */
const CLIENT_BUDGET_BYTES = 90_500;
/** 精选模板数据产物体积预算（实测 640,020 B）。 */
const TEMPLATES_BUDGET_BYTES = 736_500;
/** types/ 入口声明体积预算。
 *
 *  比产物那一组松得多，因为 tsc 的 removeComments 是关着的：声明文件保留源码里的文档注释，
 *  而这份声明是插件对外唯一的类型说明面——注释一走，导出项上那些"为什么这么写"的约束就只剩
 *  实现侧能看。留注释的代价就是体积（当前量级是数万字节），这条预算按"保留注释"的实测值定，
 *  不要再按去掉注释的量级去卡它。 */
const DECLARATION_ENTRY_BUDGET_BYTES = 33_500;

/** 产物文件名与预算的对照。 */
const BUDGETS: readonly (readonly [string, number])[] = [
  ["host.js", HOST_BUDGET_BYTES],
  ["client.js", CLIENT_BUDGET_BYTES],
  ["templates.data.mjs", TEMPLATES_BUDGET_BYTES],
];

/**
 * types/ 一层 `.d.ts` 的字节合计（**不递归**）。
 *
 * 不递归是刻意的：types/ 一层就是声明入口，lib/ 下是它们各自的依赖，量级不同。只对一层求和，
 * 就不必去减一个可能为空的子目录——那种写法在子目录为空时得到 0、断言恒真，而一条永远绿的
 * 闸门比没有闸门更坏：它让人以为有护栏。
 *
 * @param dir - 目录绝对路径
 * @returns 字节合计
 */
function entryDeclarationBytes(dir: string): number {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".d.ts"))
    .reduce((sum, name) => sum + readFileSync(path.join(dir, name)).byteLength, 0);
}

describe("产物体积", () => {
  it.each(BUDGETS)("%s 不超过 %s 字节预算", (file, budget) => {
    const bytes = readFileSync(path.join(pkgDir, file)).byteLength;
    assert.ok(
      bytes <= budget,
      `${file} 实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${budget.toLocaleString("en-US")} B：多半是某个切面塞进了大查表或字面量。` +
        `确属正常演进就改 test/dist-size.test.ts 里对应的预算常量，并写明理由。`,
    );
  });

  it("types/ 入口声明不超出预算", () => {
    const bytes = entryDeclarationBytes(path.join(pkgDir, "types"));
    assert.ok(
      bytes <= DECLARATION_ENTRY_BUDGET_BYTES,
      `types/ 入口声明实测 ${bytes.toLocaleString("en-US")} B，超出预算 ` +
        `${DECLARATION_ENTRY_BUDGET_BYTES.toLocaleString("en-US")} B。` +
        `确认是正常演进就改这条预算常量，并写明理由。`,
    );
  });
});
