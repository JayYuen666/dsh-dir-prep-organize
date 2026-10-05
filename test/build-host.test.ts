// host.js 构建冒烟 + 防回归锁（产物落「包根」这条不变式是本包的生命线）。
//
// 为什么锁得这么死：host.ts 用 `path.join(import.meta.dirname, "agents")` 定位内置
// 角色库（host.ts:67），而 `import.meta.dirname` 取的是**运行期模块自身所在目录**。
// 产物一旦挪进 dist/，AGENTS_DIR 就静默指向 <pkg>/dist/agents（不存在），「导入内置
// 全部」直接空集——不报错、只是没有角色。故这里同时锁三件事：
//   1. 跨包依赖在产物里保持 external（内联会把 shared 的模块级状态复制成多份）；
//   2. 产物里没有 `from "./x.ts"` 残留（残留 = Node 载入即 ERR_UNSUPPORTED…）；
//   3. 产物目录 === host.ts 目录，且产物里的 AGENTS_DIR 仍是 import.meta.dirname
//      相对式（没被折成绝对路径常量）。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { stat } from "node:fs/promises";
import path from "node:path";

import { buildHost } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 包根（本文件在 test/ 下）。产物必须落在这里，与 host.ts 同目录。 */
const PKG_ROOT = path.dirname(import.meta.dirname);

/** 残留的本地 .ts 说明符（`from "./x.ts"` / `from "../y/zz.ts"`）。 */
const LOCAL_TS_IMPORT = /from\s*["']\.{1,2}\/[^"']*\.ts["']/u;

/** 内置模板表的数据产物文件名（build-host.mjs 的 ARTIFACTS 里那一个）。 */
const TEMPLATES_DATA = "templates.data.mjs";

/**
 * 从产物 Map 里取某个文件的正文。
 *
 * buildHost() 交回「落盘绝对路径 → 正文」：Map 形态是为了让 test/host-freshness.ts 的逐字节
 * 门禁把**每个**产物都算进去（它对单串只比一个文件），模板数据产物才不会脱离这道门。
 *
 * @param artifacts - buildHost() 的返回值
 * @param name - 包根下的产物文件名
 * @returns 该产物的正文
 */
function artifactText(artifacts: Map<string, string>, name: string): string {
  const text = artifacts.get(path.join(PKG_ROOT, name));
  assert.ok(text !== undefined, `buildHost() 没有产出 ${name}`);
  return text;
}

describe("dir-prep-organize host 构建", () => {
  it("产物与最新构建逐字节一致（改 host.ts / src/*.ts 后必须 node build-host.mjs）", async () => {
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] 产物已过期：host.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    );
  });

  it("产物里跨包依赖保持 external（含 shared 子路径说明符）", async () => {
    const text = artifactText(await buildHost(), "host.js");
    // 子路径：external 判据必须按「包名段」匹配，字符串项精确匹配不到 `/lib/http`。
    // 本条由"只查包名前缀"升级为逐个列名——前缀断言会被 lib/http 一条满足，
    // 看不见 lib/record 哪天被内联（该批评见 zvec-grep/test/build-host.test.ts:36 的注释）。
    for (const subpath of ["lib/http", "lib/locale", "lib/record", "lib/errors"]) {
      assert.ok(
        text.includes(`from "@jayyuen66/dsh-plugin-shared/${subpath}"`),
        `shared/${subpath} 必须留在产物里（内联 = shared 单例被复制）`,
      );
    }
    assert.ok(
      text.includes('from "@deepseek-ai/dsh-brand"'),
      "dsh-brand 必须外部化（口径 A：值导入落 dependencies，内联=复制官方构造器）",
    );
    assert.ok(!/^function brandString\(/mu.test(text), "产物不得内联 brandString 的函数体");
    // 设置 schema 引擎 = 宿主 fork 的 schemastery：0.1.7 的 `.volatile()` 只有它有实现，
    // 公共包既没有该方法、解析出的 volatile 字段也仍是普通值（读不到设置卡写进去的值）。
    assert.ok(
      text.includes('from "@deepseek-ai/schemastery"'),
      "@deepseek-ai/schemastery（宿主 fork，设置 schema 引擎）必须以裸说明符留在产物里",
    );
    // 反向锁：不得退回公共 schemastery。
    assert.ok(
      !/from\s+["']schemastery["']/u.test(text),
      "host.js 不得再值导入公共 schemastery（0.1.7 volatile 解析只在宿主 fork 里）",
    );
    assert.ok(text.includes('from "node:path"'), "node: 内建不打包");
  });

  it("产物里没有本地 .ts 说明符残留", async () => {
    for (const [file, text] of await buildHost()) {
      assert.equal(
        text.search(LOCAL_TS_IMPORT),
        -1,
        `${path.basename(file)} 残留 ./x.ts 会让 Node 载入即抛错`,
      );
    }
  });

  it("内置模板表不在 host.js 里，改由 templates.data.mjs 按需 import", async () => {
    // 这条锁的是「按需」本身。表有 85 条、生成物约 640 KB 源码，一旦被静态导入打回
    // host.js，宿主载入插件就替所有用户把内存占了——而它只有一个消费者，且客户端本来
    // 就是首次打开下拉才拉。所以两头都必须按需。
    const artifacts = await buildHost();
    const host = artifactText(artifacts, "host.js");
    const data = artifactText(artifacts, TEMPLATES_DATA);
    assert.ok(
      host.length < data.length,
      `host.js（${String(host.length)} 字符）应当明显小于模板数据产物（${String(data.length)} 字符）`,
    );
    // 宿主侧保留的只有「指向产物的 URL + import」这一步，不能出现表本身。
    assert.ok(
      host.includes('new URL("templates.data.mjs", import.meta.url)'),
      "host.js 必须保留对 templates.data.mjs 的相对定位（与 AGENTS_DIR 同一套落点理由）",
    );
    assert.ok(!host.includes("DEFAULT_TEMPLATES = ["), "模板表字面量不得回到 host.js");
    // 产物那侧则必须真的带着表，且是具名导出（宿主按形状取）。
    assert.ok(data.includes("DEFAULT_TEMPLATES"), "templates.data.mjs 必须导出 DEFAULT_TEMPLATES");
  });

  it("产物全部落在包根（与 host.ts 同目录）：AGENTS_DIR 与模板数据都与包同住", async () => {
    const artifacts = await buildHost();
    // ① host.js 仍是「运行时相对定位」，没有被构建成绝对路径字面量。
    const host = artifactText(artifacts, "host.js");
    assert.ok(
      host.includes('path.join(import.meta.dirname, "agents")'),
      "AGENTS_DIR 必须保持 import.meta.dirname 相对式",
    );
    // ② 每个产物的落盘路径都在包根直下（不进 dist/）。这一条原本是对构建脚本源码做文本
    // 匹配，写法一改就失效；改成对 buildHost() 的返回值断言——要守的不变式没变，但不再
    // 依赖实现的写法长相。
    for (const file of artifacts.keys()) {
      assert.equal(
        path.dirname(file),
        PKG_ROOT,
        `产物 ${path.basename(file)} 必须落在包根：进 dist/ 会让 AGENTS_DIR / templates.data.mjs 静默失联`,
      );
    }
    // ③ 包根下确有 agents/ 目录，且两个产物都已落盘 —— 三者同时成立才等价于
    //    「运行期 AGENTS_DIR === <pkg>/agents」且模板表可被 import。
    const landed = new Map(
      await Promise.all(
        ["agents", "host.js", TEMPLATES_DATA].map(
          async (name) => [name, await stat(path.join(PKG_ROOT, name))] as const,
        ),
      ),
    );
    assert.ok(landed.get("agents")?.isDirectory() === true, "agents/ 角色库存在");
    assert.ok(landed.get("host.js")?.isFile() === true, "host.js 已产出（npm run build）");
    assert.ok(
      landed.get(TEMPLATES_DATA)?.isFile() === true,
      "templates.data.mjs 已产出（npm run build）",
    );
  });
});

describe("闸门的外部化面（shared/lib/trust）", () => {
  it("lib/trust 子路径保持裸说明符，且 guardTrust 的实现未被内联", async () => {
    // 这些包原先只钉了 http/project-key/record/jsonl 几枚子路径，`lib/trust` 是新增的第四个坑位：
    // external 的字符串项是精确匹配，子路径一旦漏掉就把整份判据复制进本包产物（判据分叉的起点）。
    const out = artifactText(await buildHost(), "host.js");
    assert.ok(
      out.includes('from "@jayyuen66/dsh-plugin-shared/lib/trust"'),
      "shared/trust 必须外部化",
    );
    assert.ok(!/^function guardTrust\(/mu.test(out), "产物不得内联 guardTrust 的函数体");
  });
});
