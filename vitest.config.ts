import { fileURLToPath } from "node:url";
import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（含覆盖率阈值与排除表）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
// setupFiles 是基线 test 块里没有的键：工厂里 `...test` 是键级展开，这一条是新增而非覆盖。
//
// coverage.exclude 整表重申基线的排除面并追加一条：src/*.generated.ts 是 gen:defaults
// 的机器产物（字节锁在 test/gen-defaults.test.ts），不进 100% 分母——v8 对它们的计入与否
// 随运行波动（同一份配置实测两种形态都出现过），计入时分母随角色库增删抖动。
// 基线的排除表没有导出（消费的是 registry 上的 shared 包），所以这里只能整表重申；
// 基线增删条目时这一份要跟着对。
//
// coverageInclude 刻意不收 build-*.mjs 与 scripts/gen-defaults-lib.mjs：它们有测试 import，
// 但 100% 四项阈值守不住——实测纳入后全包降至 88%，其中 build-types.mjs 35%、
// gen-defaults-lib.mjs 86%（未覆盖面集中在 CLI 入口与 oxfmt 子进程封装，收口需要给
// 依赖注入开缝）。在阈值放宽或注入缝隙落地之前，收进来等于硬凑红灯。
export default definePackageConfig({
  coverageInclude: ["host.ts", "src/**/*.ts"],
  coverage: {
    exclude: [
      "test/**",
      "node_modules/**",
      "**/test/**",
      "**/node_modules/**",
      "build-client*",
      "client.js",
      "agents/**",
      "scripts/**",
      "**/*.d.ts",
      "**/*.d.mts",
      "src/**/*.generated.ts",
    ],
  },
  test: {
    // 用配置文件自身定位：vitest 默认按 cwd 解析相对 setupFiles，从上级目录以
    // `--config` 指定本文件时相对路径会指到不存在的位置，日志账本会静默不安装。
    setupFiles: [fileURLToPath(new URL("test/setup-logs.ts", import.meta.url))],
  },
});
