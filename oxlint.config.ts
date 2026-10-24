import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包唯一的包内定制就是这份 titlePrefixes：用例标题以大写开头的术语/组件名会被
  // vitest/prefer-lowercase-title 判红，这里逐条放行（基线的其余判据无包内例外）。
  // 名单与 test/ 里的标题互为镜像，test/oxlint-prefixes.test.ts 做双向比对，
  // 改标题或删用例后名单过期会在测试里点名，不靠 lint 报错定位。
  titlePrefixes: [
    "AGENT_DIR_GROUP_LABELS",
    "AllowRootsPanel",
    "CRLF",
    "CURATED_SLUGS",
    "GET",
    "HOST_MESSAGES",
    "ImportPanel",
    "OrganizeButton",
    "TemplateButton",
    "TemplatesCard",
  ],
});
