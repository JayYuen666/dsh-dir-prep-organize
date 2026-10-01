// dir-prep-organize 默认模板生成脚本（dev 期按需运行：`npm run gen:defaults`）。
//
// 职责：读取插件内置角色库 agents/<dept>/<file>.md → 用与 src/templates.ts
// 完全一致的解析/提炼规则 → 生成 src/default-templates.generated.ts（精选集）。
//
// 镜像实现与常量表都在 scripts/gen-defaults-lib.mjs（CLI 与漂移测试共用同一份，
// 杜绝"测试比对的表和生成用的表不是同一份"这种自欺）。改动解析/提炼逻辑时必须
// 同步 lib 并 `npm run gen:defaults` 重新生成；test/gen-defaults.test.ts 会做
// 全量漂移锁（85 条逐字段 + 两张镜像表键序 + 生成文件字节级一致），漂移即红。
//
// 用法：`npm run gen:defaults`。任一精选 slug 缺失/解析失败 → 非零退出并报错
// （防静默丢角色）。

/// <reference types="node" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_DIR,
  buildEntries,
  checkFormatted,
  CURATED_SLUGS,
  formatGenerated,
  GENERATED_FILE,
  GROUP_LABELS_FILE,
  AGENT_DIR_GROUP_LABELS,
  renderGenerated,
  renderLabels,
  scanAgentFiles,
} from "./gen-defaults-lib.mjs";

async function main() {
  const agentFiles = await scanAgentFiles();
  const bySlug = new Map(agentFiles.map((file) => [file.slug, file]));
  // 校验精选 slug 全部命中（缺失即报错退出，防静默丢角色）
  const missing = CURATED_SLUGS.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) {
    console.error(`[gen-defaults] 以下精选 slug 在 agents/ 中缺失：\n${missing.join("\n")}`);
    process.exit(1);
  }
  let entries;
  try {
    entries = await buildEntries(bySlug, (filePath) => readFile(filePath, "utf8"));
  } catch (error) {
    console.error(`[gen-defaults] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  await mkdir(path.dirname(GENERATED_FILE), { recursive: true });
  // 排版属于生成链路的一环（不是"记得顺手跑一次 oxfmt"）：fmt:check 把 src/*.generated.ts
  // 算在面上，而 test/gen-defaults.test.ts 锁的是磁盘生成物 = 生成器输出的字节级相等，
  // 两边不同源就必然有一边红。写完再对落盘文件实跑一次 --check，把"临时目录里排版
  // 与在 src/ 里排版是否等价"这条假设变成断言。
  await writeFile(GENERATED_FILE, formatGenerated(renderGenerated(entries)), "utf8");
  await writeFile(GROUP_LABELS_FILE, formatGenerated(renderLabels(AGENT_DIR_GROUP_LABELS)), "utf8");
  checkFormatted(GENERATED_FILE);
  checkFormatted(GROUP_LABELS_FILE);
  console.info(
    `[gen-defaults] wrote ${String(entries.length)} curated defaults -> ${AGENTS_DIR} -> ${GENERATED_FILE}`,
  );
}

await main();
