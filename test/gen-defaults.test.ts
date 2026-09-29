// 生成脚本 ↔ src/templates.ts 的全量漂移锁（替代旧的"抽样 6 条"）。
//
// 为什么必须有：DEFAULT_TEMPLATES 是**生成物**（scripts/gen-defaults.mjs 用一份
// 镜像实现解析 agents/ 角色库），而镜像与真实实现只在人眼里一致——没有机器锁时，
// 改了 templates.ts 忘了脚本，生成的默认集就静默失真，且 85 条里只抽 6 条比对，
// 漂移几乎不可能被抓到。这里锁四件事：
//   1. 两张镜像常量表（AGENT_DIR_GROUP_LABELS / CURATED_SLUGS）与 templates.ts
//      及生成文件的**键序 + 值**逐项一致（顺序 = 下拉展示顺序，旧版完全不比）；
//   2. 全部 85 条精选逐字段与源文件重算结果一致；
//   3. 镜像函数（parse/condense/groupLabel）与 templates.ts 真函数对每个源文件
//      输出逐字节相同 —— 这才是"两份实现没分叉"的证明；
//   4. 生成器 formatGenerated(renderGenerated()) 的输出（即含 oxfmt 排版步骤的完整生成链路）
//      与仓库里的 default-templates.generated.ts 字节级相同 —— 即"忘跑 gen:defaults"也会红。

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import {
  AGENT_DIR_GROUP_LABELS as MIRROR_LABELS,
  buildEntries,
  condenseRoleBody as mirrorCondense,
  CURATED_SLUGS,
  GENERATED_FILE,
  formatGenerated,
  groupLabelOf as mirrorGroupLabel,
  parseAgentFrontmatter as mirrorParse,
  renderGenerated,
  scanAgentFiles,
} from "../scripts/gen-defaults-lib.mjs";
import {
  condenseRoleBody,
  DEFAULT_TEMPLATES,
  groupLabelOf,
  parseAgentFrontmatter,
} from "../src/templates.ts";
import { AGENT_DIR_GROUP_LABELS } from "../src/group-labels.generated.ts";

/** 全量源文件表（slug → 路径/目录名），多组断言共用一次扫描。 */
async function scanMap(): Promise<
  Map<string, { slug: string; dirName: string; filePath: string }>
> {
  const files = await scanAgentFiles();
  return new Map(files.map((file) => [file.slug, file]));
}

describe("gen-defaults 镜像常量表", () => {
  it("AGENT_DIR_GROUP_LABELS：键序与值都与生成表逐项一致", () => {
    assert.deepEqual(
      Object.keys(MIRROR_LABELS),
      Object.keys(AGENT_DIR_GROUP_LABELS),
      "分组表键顺序不能漂（下拉分组按此顺序展示）",
    );
    assert.deepEqual(MIRROR_LABELS, AGENT_DIR_GROUP_LABELS, "分组表值不能漂");
  });

  it("CURATED_SLUGS：顺序与生成文件里的 DEFAULT_TEMPLATES id 序列完全一致", () => {
    assert.deepEqual(
      CURATED_SLUGS,
      DEFAULT_TEMPLATES.map((entry) => entry.id),
      "精选 slug 顺序 = 生成集顺序 = 展示顺序",
    );
    assert.ok(CURATED_SLUGS.length >= 80, `精选集规模，实际 ${String(CURATED_SLUGS.length)}`);
  });

  it("每个精选 slug 都能在 agents/ 里找到源文件", async () => {
    const bySlug = await scanMap();
    const missing = CURATED_SLUGS.filter((slug) => !bySlug.has(slug));
    assert.deepEqual(missing, [], "缺失 slug 会让 gen:defaults 直接退出，测试同步锁住");
  });
});

describe("gen-defaults 全量漂移（85 条逐字段，不再抽样）", () => {
  it("每条 DEFAULT_TEMPLATES 都等于按源文件重算的结果", async () => {
    const bySlug = await scanMap();
    const rebuilt = await buildEntries(bySlug, (filePath) => readFile(filePath, "utf8"));
    assert.equal(rebuilt.length, DEFAULT_TEMPLATES.length, "条数一致");
    for (const [index, entry] of rebuilt.entries()) {
      const committed = DEFAULT_TEMPLATES[index];
      assert.ok(committed, `${String(index)} 位有生成条目`);
      assert.deepEqual(entry, committed, `第 ${String(index)} 条（${entry.id}）逐字段一致`);
    }
  });

  it("镜像解析/提炼与 src/templates.ts 真实现对每个源文件输出相同", async () => {
    const bySlug = await scanMap();
    // 源文件一次读完再逐项比对：断言循环里不留 await（no-await-in-loop）。
    const sources = await Promise.all(
      CURATED_SLUGS.map(async (slug) => {
        const file = bySlug.get(slug);
        assert.ok(file, `${slug} 有源文件`);
        return { slug, dirName: file.dirName, text: await readFile(file.filePath, "utf8") };
      }),
    );
    for (const source of sources) {
      const info = parseAgentFrontmatter(source.text);
      if (info === undefined) {
        assert.fail(`${source.slug} 必须可解析`);
      }
      assert.deepEqual(
        mirrorParse(source.text),
        info,
        `${source.slug}：parseAgentFrontmatter 两份实现一致`,
      );
      assert.equal(
        mirrorCondense(info.body),
        condenseRoleBody(info.body),
        `${source.slug}：condenseRoleBody 两份实现一致`,
      );
      assert.equal(
        mirrorGroupLabel(source.dirName),
        groupLabelOf(source.dirName),
        `${source.slug}：groupLabelOf 两份实现一致`,
      );
    }
  });

  it("生成文件内容 = formatGenerated(renderGenerated(重算条目))（字节级，忘跑 gen:defaults 即红）", async () => {
    const bySlug = await scanMap();
    const rebuilt = await buildEntries(bySlug, (filePath) => readFile(filePath, "utf8"));
    const committed = await readFile(GENERATED_FILE, "utf8");
    // 比对必须过同一道排版步骤：fmt:check 把生成物算在排版面上，字节锁与排版同源才不打架。
    assert.equal(
      formatGenerated(renderGenerated(rebuilt)),
      committed,
      "生成物与生成器输出（含 oxfmt 排版）必须逐字节相同",
    );
  });
});
