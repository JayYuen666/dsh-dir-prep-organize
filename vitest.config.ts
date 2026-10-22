import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（含覆盖率阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异，
// 不重复基线的内容——基线改了这里不该跟着改。
export default definePackageConfig({
  coverageInclude: ["host.ts", "src/**/*.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
