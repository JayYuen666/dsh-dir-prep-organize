// @vitest-environment happy-dom
// test/integration/roundtrip.test.ts —— 半与半之间的**点对点**回合。
//
// 到这里为止，两半各自都有厚测试：host 侧的分支在 test/routes.test.ts，client 侧的交互在
// test/client.test.ts。但它们共用一套**线协议**（URL、字段名、CSRF 头名、回执形状），
// 而这套协议此前只被两侧各自的**手搓 body** 喂过——host 改了字段名，client 的解析器只要
// 兜底得当就仍然全绿，症状却是界面上「目录读不到」。这里把两半接到同一根真线上：
//   真 node:http 监听 + 真 SessionStore + 真磁盘 FileSystem + 真 LlmRuntime（脚本适配器）
//   → client 半的**导出解析器**吃真回执 → client 半的**摘要函数**产真 prompt
//   → 再经真 HTTP 打回 host → 断言模型那端真收到了什么。
// 任何一环字段漂移，这条用例都会红，而红的位置就是漂移的那一半。
import { strict as assert } from "node:assert";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  formatContextSummary,
  parseContextResponse,
  parseOrganizeResponse,
} from "../../src/client-entry.ts";
import { PROVIDER, bootHostStack, textReply, wireRequest } from "./host-stack.ts";
import type { HostStack } from "./host-stack.ts";

/** client 半发的 CSRF 头名必须与 host 半校验的那一枚同名（两半各写一遍，正是漂移点）。 */
const CSRF_HEADER = "x-dir-prep-csrf";
const CONTEXT_ROUTE = "/_dsh/dir-prep/context";
const ORGANIZE_ROUTE = "/_dsh/dir-prep/organize";
/** 只用得上第一格剧本的台子：其余用例不该碰到模型，碰到了就红在这一句上。 */
const UNREACHED = ["不该被调用"];
/** 工程里那枚关键文件：磁盘上的字节、摘要里的片段、模型收到的 user 帧三处共用同一事实。 */
const INDEX_BODY = "export const target = 1;\n";
const INDEX_SNIPPET = "export const target = 1;";

/** 一台台子：真宿主 + 它服务的那个真工程目录（断言两侧都得引用同一份路径）。 */
interface Rig {
  readonly host: HostStack;
  readonly project: string;
}

const rigs: Rig[] = [];

/** 起一台真宿主，并把会话 s1 的 cwd 指到一个新铺的真工程目录。 */
async function boot(replies: readonly string[], files: Record<string, string>): Promise<Rig> {
  const stamp = await mkdtemp(path.join(os.tmpdir(), "organize-roundtrip-"));
  // macOS 的 /var → /private/var 是软链：断言基准一律用 realpath 后的拼写
  const made = await realpath(stamp);
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(path.join(made, name), body, "utf8")),
  );
  const host = await bootHostStack({ script: replies.map((reply) => textReply(reply)) });
  host.session("s1", made);
  const rig: Rig = { host, project: made };
  rigs.push(rig);
  return rig;
}

// 台子是全局的（每次 boot 起一台真监听 + 一个真目录），hooks 属装配不属任何一族用例；
// 回收按登记序**串行** dispose，并发拆台会把失败归因混在一起。
/* oxlint-disable vitest/require-top-level-describe, no-await-in-loop */
afterEach(async () => {
  const pending = rigs.splice(0);
  for (const { host, project } of pending) {
    await host.dispose();
    await rm(project, { recursive: true, force: true });
  }
});
/* oxlint-enable vitest/require-top-level-describe, no-await-in-loop */

describe("client↔host 点对点回合", () => {
  it("真目录 → 真 context → client 摘要 → 真 organize → 模型真收到", async () => {
    const { host, project } = await boot(["整理后的正文：请补充目标模块名"], {
      "notes.md": "---\nname: 评审官\n---\n正文\n",
      "index.ts": INDEX_BODY,
    });
    const context = await wireRequest(host.port, `${CONTEXT_ROUTE}?sessionId=s1`);
    assert.equal(context.status, 200);

    // 这一步是本用例的全部理由：**host 的真实回执**经 client 半自己的解析器变成视图。
    const view = parseContextResponse(context.body);
    assert.equal(view.ok, true, view.error ?? "context 应成功");
    assert.equal(view.cwd, project, "cwd 由真会话带来");
    const { csrf } = view;
    assert.ok(typeof csrf === "string" && csrf.length > 0, "CSRF 令牌随回执下发");
    const names = (view.entries ?? []).map((entry) => entry.name);
    assert.deepEqual(names.toSorted(), ["index.ts", "notes.md"]);

    const summary = formatContextSummary(view);
    assert.ok(summary.includes("notes.md"), "目录表进摘要");
    assert.ok(summary.includes(INDEX_SNIPPET), "关键文件正文经真 fs 读进摘要");

    const organized = await wireRequest(host.port, ORGANIZE_ROUTE, {
      method: "POST",
      headers: { [CSRF_HEADER]: csrf, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "把上面那份笔记整理成评审要点",
        sessionId: "s1",
        entriesSummary: summary,
      }),
    });
    assert.equal(organized.status, 200);
    const parsed = parseOrganizeResponse(organized.body);
    assert.equal(parsed.ok, true, parsed.error ?? "organize 应成功");
    assert.equal(parsed.content, "整理后的正文：请补充目标模块名", "脚本模型的回执原样递回 client");

    // 模型那端到底收到了什么：两半的字段名只要有一处对不上，这里就会是空串。
    // 分工按 host.ts 的 buildOrganizeSystem / buildOrganizeUser——cwd 留在 system，
    // **目录摘要进 user 的围栏**，所以 client 半那份摘要必须落在 messages。
    const [request] = host.adapter.requests;
    assert.ok(request !== undefined, "真 LlmRuntime 把请求交到了适配器");
    assert.equal(request.provider, PROVIDER);
    assert.ok((request.system ?? "").includes(project), "会话 cwd 进 system");
    assert.equal(request.messages.length, 1, "request-only 帧：一条 user 输入");
    const userText = JSON.stringify(request.messages);
    assert.ok(userText.includes("notes.md"), "client 产的目录表进了模型");
    assert.ok(userText.includes(INDEX_SNIPPET), "关键文件正文经真 fs 读进模型");
    assert.ok(userText.includes("把上面那份笔记整理成评审要点"), "草稿原文进 user 帧");
    assert.ok(!userText.includes('"id"'), "帧不带自造身份（RequestUserInput 的 never 位）");
  });

  it("CSRF 头名或令牌任一不对 → 真 403，client 解析器读得回那句错", async () => {
    const { host } = await boot(UNREACHED, { "a.ts": "export const a = 1;\n" });
    const context = await wireRequest(host.port, `${CONTEXT_ROUTE}?sessionId=s1`);
    const { csrf } = parseContextResponse(context.body);
    assert.ok(typeof csrf === "string");

    const wrongHeader = await wireRequest(host.port, ORGANIZE_ROUTE, {
      method: "POST",
      headers: { "x-wrong-csrf": csrf, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "整理", sessionId: "s1" }),
    });
    assert.equal(wrongHeader.status, 403, "头名是两半的约定，写错必须被拒");
    const rejected = parseOrganizeResponse(wrongHeader.body);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, "invalid csrf token");

    const wrongToken = await wireRequest(host.port, ORGANIZE_ROUTE, {
      method: "POST",
      headers: { [CSRF_HEADER]: "not-the-token", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "整理", sessionId: "s1" }),
    });
    assert.equal(wrongToken.status, 403);
  });

  it("符号链接逃逸在整条线路上都收口：摘要里读不到根外正文", async () => {
    const { host, project } = await boot(UNREACHED, { "keep.md": "# keep\n" });
    const outsideName = `organize-roundtrip-outside-${String(Date.now())}.md`;
    const outsideFile = path.join(os.tmpdir(), outsideName);
    await writeFile(outsideFile, "---\nname: 外部\n---\nLEAKED-BODY\n", "utf8");
    try {
      await symlink(outsideFile, path.join(project, "link.md"));
      const context = await wireRequest(host.port, `${CONTEXT_ROUTE}?sessionId=s1`);
      const view = parseContextResponse(context.body);
      const summary = formatContextSummary(view);
      assert.ok(summary.includes("link.md"), "链接的名字照常列在目录表里");
      assert.ok(!summary.includes("LEAKED-BODY"), "但根外正文不得经摘要进模型");
      assert.equal(view.truncated, true, "被排除的项要让 truncated 为真");
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it("没有会话就没有 cwd：真回执的中文原因经 client 解析器原样递到界面", async () => {
    const { host } = await boot(UNREACHED, { "a.md": "# a\n" });
    const context = await wireRequest(host.port, CONTEXT_ROUTE);
    const view = parseContextResponse(context.body);
    assert.equal(view.ok, false);
    assert.equal(typeof view.error, "string");
    assert.ok((view.error ?? "").length > 0, "回执必须带一句可读的原因，不能是一张空表");
    assert.equal(formatContextSummary(view).startsWith("当前目录: (未提供)"), true);
  });
});
