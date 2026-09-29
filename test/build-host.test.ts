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
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { buildHost } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 包根（本文件在 test/ 下）。产物必须落在这里，与 host.ts 同目录。 */
const PKG_ROOT = path.dirname(import.meta.dirname);

/** 残留的本地 .ts 说明符（`from "./x.ts"` / `from "../y/zz.ts"`）。 */
const LOCAL_TS_IMPORT = /from\s*["']\.{1,2}\/[^"']*\.ts["']/u;

describe("dir-prep-organize host 构建", () => {
  it("host.js 与最新构建逐字节一致（改 host.ts / src/*.ts 后必须 node build-host.mjs）", async () => {
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] host.js 已过期：host.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    );
  });

  it("产物里跨包依赖保持 external（含 shared 子路径说明符）", async () => {
    const text = await buildHost();
    // 子路径：external 判据必须按「包名段」匹配，字符串项精确匹配不到 `/lib/http`。
    // 本条由"只查包名前缀"升级为逐个列名——前缀断言会被 lib/http 一条满足，
    // 看不见 lib/record 哪天被内联（该批评见 zvec-grep/test/build-host.test.ts:36 的注释）。
    for (const subpath of ["lib/http", "lib/locale", "lib/record", "lib/errors"]) {
      assert.ok(
        text.includes(`from "@jayyuen666/dsh-plugin-shared/${subpath}"`),
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
    const text = await buildHost();
    assert.equal(text.search(LOCAL_TS_IMPORT), -1, "残留 ./x.ts 会让 Node 载入即抛错");
  });

  it("产物落在包根（与 host.ts 同目录）：AGENTS_DIR 在产物态仍指向包内 agents/", async () => {
    const text = await buildHost();
    // ① 产物仍是「运行时相对定位」，没有被构建成绝对路径字面量。
    assert.ok(
      text.includes('path.join(import.meta.dirname, "agents")'),
      "AGENTS_DIR 必须保持 import.meta.dirname 相对式",
    );
    // ② 构建脚本的写入目标 = 脚本自身目录（= 包根）；改这一行必须同步改本断言。
    const builder = await readFile(path.join(PKG_ROOT, "build-host.mjs"), "utf8");
    assert.ok(
      builder.includes("const root = import.meta.dirname;") &&
        builder.includes('writeFile(path.join(root, "host.js")'),
      "build-host.mjs 必须把 host.js 写在包根（产物进 dist/ 会让 AGENTS_DIR 静默失效）",
    );
    // ③ 包根下确有 agents/ 目录，且已产出的 host.js 就躺在包根 —— 三者同时成立才
    //    等价于「运行期 AGENTS_DIR === <pkg>/agents」。
    const agentsStat = await stat(path.join(PKG_ROOT, "agents"));
    const artifactStat = await stat(path.join(PKG_ROOT, "host.js"));
    assert.ok(agentsStat.isDirectory(), "agents/ 角色库存在");
    assert.ok(artifactStat.isFile(), "host.js 已产出（npm run build）");
  });
});

describe("闸门的外部化面（shared/lib/trust）", () => {
  it("lib/trust 子路径保持裸说明符，且 guardTrust 的实现未被内联", async () => {
    // 这些包原先只钉了 http/project-key/record/jsonl 几枚子路径，`lib/trust` 是新增的第四个坑位：
    // external 的字符串项是精确匹配，子路径一旦漏掉就把整份判据复制进本包产物（判据分叉的起点）。
    const out = await buildHost();
    assert.ok(
      out.includes('from "@jayyuen666/dsh-plugin-shared/lib/trust"'),
      "shared/trust 必须外部化",
    );
    assert.ok(!/^function guardTrust\(/mu.test(out), "产物不得内联 guardTrust 的函数体");
  });
});
