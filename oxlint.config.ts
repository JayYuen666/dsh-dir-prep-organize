import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 无包内例外：基线（只读那一组同步 API）已覆盖本包的全部用法。
  titlePrefixes: [
    "AGENT_DIR_GROUP_LABELS",
    "AllowRootsPanel",
    "CRLF",
    "CSRF",
    "CURATED_SLUGS",
    "GET",
    "HOST_MESSAGES",
    "ImportPanel",
    "OrganizeButton",
    "TemplateButton",
    "TemplatesCard",
  ],
});
