import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（含覆盖率阈值与排除表）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
// setupFiles 是基线 test 块里没有的键：工厂里 `...test` 是键级展开，这一条是新增而非覆盖。
//
// coverage.exclude 整表重申基线的排除面并追加一条：两份 src/*.generated.ts 是
// gen:defaults 的机器产物（字节锁在 test/gen-defaults.test.ts），不进 100% 分母——
// v8 对它们的计入与否随运行波动（同一份配置实测两种形态都出现过），计入时分母随
// 角色库增删抖动。基线的排除表未导出，改基线时这里要跟着对。
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
    setupFiles: ["test/setup-logs.ts"],
  },
});
