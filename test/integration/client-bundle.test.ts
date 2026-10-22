// @vitest-environment happy-dom
// test/integration/client-bundle.test.ts —— 执行**发布出去的 client.js**，而不是它的源码。
//
// 缺口所在：test/build-client.test.ts 只判产物字节新鲜度，test/client.test.ts 判的是
// `src/client-entry.ts` 的行为契约——两边都没碰过「发出去的那份产物能不能被装载」。而这枚
// 产物走的是宿主的模块表面协议：`window.__ModuleLoader__.load({ id, factory(require) })`
// （注册面见 harness packages/client/modules/src/client/system.ts），宿主按**裸包名**建键、
// 用自建的 require 物化。任何一处对不上——id 不等于包名、工厂要出宿主给不出的说明符、导出面
// 缺 apply/inject——症状都是「插件在页面上整块不出现」，而源码侧的测试全照绿。
//
// 装载方式本身也是契约：client.js 顶层只有那一句 load(...)，文本同时是合法 ESM。所以这里用
// `import()` 取它（跑的是宿主 <script> 之外同一份字节），而不是把源码字符串交给求值器——后者
// 既偏离真实装载路径，也是本仓明文禁用的写法。
//
// 边界说清楚：本文件只判「宿主能不能装载它」。apply 之后的行为契约（含 `hooks.card → useCard`
// 的属性合成）归 test/client.test.ts，那里的 rig 接得住产物会打的全部路由。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { describe, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..", "..");
const PKG_NAME = (
  JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as unknown as {
    name: string;
  }
).name;

/**
 * 属性组袋与卡片行为不在本文件判：`hooks.card → useCard` 那套合成、以及 apply 之后的交互，
 * 由 test/client.test.ts 用完整 rig 覆盖（那里接得住产物会打的全部路由）。
 */
/** 宿主 `__ModuleLoader__.load` 收下的那一枚注册。 */
interface Registration {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>;
}

const registered: Registration[] = [];
let loading: Promise<unknown> | undefined;

/**
 * 取回产物向 `__ModuleLoader__` 交出的那一枚注册。
 *
 * 桩必须先立后取：`load(...)` 是模块求值期的副作用，而 `import()` 按 URL 缓存，所以桩立一次、
 * 文本只取一次，各用例读的是同一份注册。收成数组而不是 `let registration`：赋值发生在回调里，
 * 控制流分析看不见它，判过空之后 TS 仍会把那枚变量收窄成 undefined（门禁据此报假违规）。
 */
async function loadRegistration(): Promise<Registration> {
  if (registered.length === 0) {
    const holder = globalThis as unknown as { window: Record<string, unknown> };
    holder.window["__ModuleLoader__"] = {
      load(taken: Registration): void {
        registered.push(taken);
      },
    };
    loading ??= import(pathToFileURL(path.join(pkgDir, "client.js")).href);
    await loading;
  }
  const [taken] = registered;
  assert.ok(taken !== undefined, "client.js 没有向 __ModuleLoader__ 注册任何模块");
  return taken;
}

/**
 * 物化导出面：宿主只提供裸包名映射，所以除了 react 之外索取到任何说明符都当场抛——
 * 那正是「页面上整块不出现」的第一现场，回 undefined 只会把症状拖成更难查的空态。
 */
async function materialize(): Promise<Record<string, unknown>> {
  const taken = await loadRegistration();
  return taken.factory((specifier: string): unknown => {
    if (specifier === "react") {
      return React;
    }
    throw new Error(`宿主的模块表面给不出这份说明符：${specifier}`);
  });
}

/**
 * 本文件只判**产物可装载性**这三件事：注册键、导出面、以及 require 面。
 *
 * 为什么不在这里跑 apply / 挂组件：产物的卡片 store 会在初始化时去拉内置精选集
 * （`/_dsh/dir-prep/default-templates`）。在源码侧的 test/client.test.ts 里，那发请求被
 * 完整 rig 的 fetch 替身接住了；而本文件拿的是**发布产物**，一旦没接住，未 stub 的相对
 * URL 请求在 happy-dom 里会一路重试——实测把 worker 顶到内存上限、被内核 SIGKILL。
 * apply 之后的行为契约属于 src 侧测试的职责，产物侧要判的是「宿主能不能装载它」。
 */
describe("发布产物 client.js 的装载", () => {
  it("按裸包名注册：宿主 client-modules 只认这一枚键", async () => {
    const taken = await loadRegistration();
    assert.equal(taken.id, PKG_NAME, "id 不等于包名就永远装载不到本插件（宿主按裸包名建键）");
    assert.equal(typeof taken.factory, "function", "工厂形产物才有可物化的导出面");
  });

  it("物化只需要 react 这一枚外部依赖，并交出宿主会调的两位", async () => {
    const bundle = await materialize();
    assert.deepEqual(bundle["inject"], ["slots", "configForms", "locale"], "缺一位就少一个服务面");
    assert.equal(typeof bundle["apply"], "function", "宿主装载后要调的就是这一位");
  });

  it("索取面恰好只有 react：多一枚外部依赖就是宿主装载不到的一块砖", async () => {
    const taken = await loadRegistration();
    const asked: string[] = [];
    taken.factory((specifier: string): unknown => {
      asked.push(specifier);
      if (specifier !== "react") {
        throw new Error(`宿主的模块表面给不出这份说明符：${specifier}`);
      }
      return React;
    });
    // 判「问过了什么」而不是「有没有抛」：产物本来只该问 react，问了别的才会抛。
    // 这条同时是 build-client.mjs 外部化名单的下游锁——名单里多写一枚宿主包，这里就会红。
    assert.deepEqual(asked.toSorted(), ["react"], "产物的外部依赖面应当恰好只有 react");
  });
});
