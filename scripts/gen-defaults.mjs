// dir-prep-organize 默认模板生成脚本（dev 期按需运行：`npm run gen:defaults`）。
//
// 职责：读取插件内置角色库 agents/<dept>/<file>.md → 用与 src/templates.ts
// 完全一致的解析/提炼规则 → 生成 src/default-templates.generated.ts（精选集）。
//
// 镜像实现与常量表都在 scripts/gen-defaults-lib.mjs（CLI 与漂移测试共用同一份，
// 杜绝"测试比对的表和生成用的表不是同一份"这种自欺）。改动解析/提炼逻辑时必须
// 同步 lib 并 `npm run gen:defaults` 重新生成；test/gen-defaults.test.ts 会做
// 全量漂移锁（全表逐字段 + 两张镜像表键序 + 生成文件字节级一致），漂移即红。
//
// 用法：`npm run gen:defaults`。任一精选 slug 缺失/解析失败/跨部门目录同名 →
// 非零退出并报错（防静默丢角色、防同名覆盖）。

/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENTS_DIR,
  buildEntries,
  checkFormatted,
  CURATED_SLUGS,
  duplicateSlugsOf,
  formatGenerated,
  GENERATED_FILE,
  GROUP_LABELS_FILE,
  AGENT_DIR_GROUP_LABELS,
  renderGenerated,
  renderLabels,
  scanAgentFiles,
} from "./gen-defaults-lib.mjs";

/**
 * 原子落盘一份生成物：先写同目录临时文件并过一遍排版校验，两份都就绪后再统一 rename。
 * 校验或写盘失败时删除临时文件并原样上抛，磁盘上的旧生成物保持原样——不会留下
 * 「default-templates 已更新而 group-labels 还是旧的」这类新旧混合态。
 * @param {Array<{ target: string; content: string }>} staged - 目标路径与已排版内容
 * @returns {Promise<void>}
 */
async function publishAll(staged) {
  /** @type {Array<{ tmp: string; target: string }>} */
  const pending = [];
  try {
    // 写与校验各文件互相独立，并行发起；两份都通过校验后才统一 rename。
    const written = await Promise.all(
      staged.map(async ({ target, content }) => {
        const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, content, "utf8");
        checkFormatted(tmp);
        return { tmp, target };
      }),
    );
    await Promise.all(written.map(({ tmp, target }) => rename(tmp, target)));
    pending.push(...written);
  } finally {
    await Promise.all(pending.map(({ tmp }) => rm(tmp, { force: true })));
  }
}

async function main() {
  const agentFiles = await scanAgentFiles();
  // 精选索引按 slug 建 Map：跨部门目录的同名 .md 会让后扫到的静默覆盖先扫到的
  //（顺序还随 readdir 波动），必须在建索引前显式报错，不能靠漂移测试偶然发现。
  const duplicates = duplicateSlugsOf(agentFiles);
  if (duplicates.length > 0) {
    throw new Error(
      `agents/ 下存在跨部门目录同名 slug，精选索引无法消歧：\n${duplicates.join("\n")}`,
    );
  }
  const bySlug = new Map(agentFiles.map((file) => [file.slug, file]));
  const missing = CURATED_SLUGS.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) {
    throw new Error(`以下精选 slug 在 agents/ 中缺失：\n${missing.join("\n")}`);
  }
  const entries = await buildEntries(bySlug, (filePath) => readFile(filePath, "utf8"));
  // 排版属于生成链路的一环（不是"记得顺手跑一次 oxfmt"）：生成物不进 fmt:check 面
  // （.prettierignore 排除），它的规范形态由 checkFormatted 在落盘前实证——"临时目录里
  // 排版与在 src/ 里排版是否等价"这条假设由那一遍实跑变成断言；磁盘产物则由
  // test/gen-defaults.test.ts 的字节锁与重跑对比守住。
  const rendered = [
    { target: GENERATED_FILE, content: formatGenerated(renderGenerated(entries)) },
    { target: GROUP_LABELS_FILE, content: formatGenerated(renderLabels(AGENT_DIR_GROUP_LABELS)) },
  ];
  await mkdir(path.dirname(GENERATED_FILE), { recursive: true });
  await publishAll(rendered);
  console.info(
    `[gen-defaults] 读 ${AGENTS_DIR}，写 ${GENERATED_FILE} 与 ${GROUP_LABELS_FILE}（精选 ${String(entries.length)} 条）`,
  );
}

try {
  await main();
} catch (error) {
  // 入口统一收口：fs/oxfmt 的异常转成稳定退出码与一句话原因，不裸抛堆栈。
  // 用 process.exitCode 而不是 process.exit：后者会截断还没刷完的 stdout/stderr。
  console.error(`[gen-defaults] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
