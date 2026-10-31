// @vitest-environment happy-dom
// test/integration/roundtrip.test.ts —— 半与半之间的**点对点**回合。
//
// 到这里为止，两半各自都有厚测试：host 侧在 test/routes.test.ts，client 侧在
// test/client.test.ts。但它们共用一套**线协议**（方法名、字段名、回执形状），而这套
// 协议此前只被两侧各自的手搓 body 喂过——host 改了字段名，client 的解析器只要兜底
// 得当就仍然全绿，症状却是界面上「目录读不到」。这里把两半接到同一根真线上：
//   真 SessionStore + 真磁盘 FileSystem + 真 LlmRuntime（脚本适配器）
//   → 官方 Remote 服务方法的真回执 → client 半的导出解析器 → 摘要函数产真 prompt
//   → 再经同一个服务打回 host → 断言模型那端真收到了什么。
import { strict as assert } from "node:assert";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  formatContextSummary,
  parseContextResponse,
  parseOrganizeResponse,
} from "../../src/client-entry.ts";
import { PROVIDER, bootHostStack, textReply } from "./host-stack.ts";
import type { HostStack } from "./host-stack.ts";

/** 工程里那枚关键文件：磁盘上的字节、摘要里的片段、模型收到的 user 帧三处共用同一事实。 */
const INDEX_BODY = "export const target = 1;\n";
const INDEX_SNIPPET = "export const target = 1;";

interface Rig {
  readonly host: HostStack;
  readonly project: string;
}

const rigs: Rig[] = [];

/** 把一条 request 消息里的文本块按顺序拼起来（content 既可能是字符串也可能是 block 数组）。 */
/** `unknown` → 可索引记录（非对象一律 undefined，调用方据此判形状）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageTextOf(frame: { readonly content: unknown }): string {
  const { content } = frame;
  if (typeof content === "string") {
    return content;
  }
  assert.ok(Array.isArray(content), "消息 content 是字符串或 block 数组");
  const blocks: readonly unknown[] = content;
  const texts: string[] = [];
  for (const block of blocks) {
    const text = asRecord(block)?.["text"];
    if (typeof text === "string") {
      texts.push(text);
    }
  }
  return texts.join("\n");
}

/** Remote 读面的本包投影：服务经 ctx.get 取，方法签名与 descriptor 一致。 */
interface DirPrepService {
  context: (request: { sessionId: string }) => Promise<Record<string, unknown>>;
  organize: (request: {
    sessionId: string;
    prompt: string;
    entriesSummary: string;
  }) => Promise<Record<string, unknown>>;
}

function serviceOf(host: HostStack): DirPrepService {
  const service: unknown = host.ctx.get("dirPrepOrganize");
  // 只判 undefined 不够：形状不对（同名服务被别的插件先注册、或导出面改了名）时，
  // `service.context` 会是 undefined，失败点被推到下面某一行并报成 TypeError。
  assert.equal(typeof service, "object", "Remote 服务没注册到上下文");
  assert.ok(service !== null, "Remote 服务是 null");
  const face = service as Record<string, unknown>;
  for (const method of ["context", "organize"] as const) {
    assert.equal(typeof face[method], "function", `Remote 服务缺方法 ${method}`);
  }
  return service as DirPrepService;
}

/** 起一台真宿主，并把会话 s1 的 cwd 指到一个新铺的真工程目录。 */
async function boot(replies: readonly string[], files: Record<string, string>): Promise<Rig> {
  const stamp = await mkdtemp(path.join(os.tmpdir(), "organize-roundtrip-"));
  // macOS 的 /var → /private/var 是软链：断言基准一律用 realpath 后的拼写
  const made = await realpath(stamp);
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(path.join(made, name), body, "utf8")),
  );
  let host: HostStack;
  try {
    host = await bootHostStack({ script: replies.map((reply) => textReply(reply)) });
  } catch (error) {
    // 装配失败时这个目录还没登记进 rigs，afterEach 不会扫到它 —— 就地回收再抛。
    await rm(made, { recursive: true, force: true });
    throw error;
  }
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
  // 一台拆台失败不能让后面的台子留在盘上/进程里：逐台收口，最后一次性抛出全部失败。
  const failures: unknown[] = [];
  for (const { host, project } of pending) {
    try {
      await host.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(project, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} 次集成台回收失败`);
  }
});
/* oxlint-enable vitest/require-top-level-describe, no-await-in-loop */

describe("client↔host 点对点回合", () => {
  it("真目录 → 真 context → client 摘要 → 真 organize → 模型真收到", async () => {
    const { host, project } = await boot(["整理后的正文：请补充目标模块名"], {
      "notes.md": "---\nname: 评审官\n---\n正文\n",
      "index.ts": INDEX_BODY,
    });
    const service = serviceOf(host);
    const context = await service.context({ sessionId: "s1" });

    // 这一步是本用例的全部理由：**host 的真实回执**经 client 半自己的解析器变成视图。
    const view = parseContextResponse(context);
    assert.equal(view.ok, true, view.error ?? "context 应成功");
    assert.equal(view.cwd, project, "cwd 由真会话带来");
    const names = (view.entries ?? []).map((entry) => entry.name);
    assert.deepEqual(names.toSorted(), ["index.ts", "notes.md"]);

    const summary = formatContextSummary(view);
    assert.ok(summary.includes("notes.md"), "目录表进摘要");
    assert.ok(summary.includes(INDEX_SNIPPET), "关键文件正文经真 fs 读进摘要");

    const organized = await service.organize({
      sessionId: "s1",
      prompt: "把上面那份笔记整理成评审要点",
      entriesSummary: summary,
    });
    const parsed = parseOrganizeResponse(organized);
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
    // 断言按结构读，而不是把整帧 stringify 之后做子串查找：后者连 role 字段、
    // 相邻 block 的分隔符都算进搜索面，命中位置与「正文进了模型」不是同一件事。
    const [frame] = request.messages;
    assert.ok(frame !== undefined, "request 里至少有一条消息");
    assert.equal(frame.role, "user", "request-only 帧的角色是 user");
    const userText = messageTextOf(frame);
    assert.ok(userText.includes("notes.md"), "client 产的目录表进了模型");
    assert.ok(userText.includes(INDEX_SNIPPET), "关键文件正文经真 fs 读进模型");
    assert.ok(userText.includes("把上面那份笔记整理成评审要点"), "草稿原文进 user 帧");
    assert.ok(!Object.hasOwn(frame, "id"), "帧不带自造身份（RequestUserInput 的 never 位）");
  });

  it("会话不存在 → 服务回 cwd 不可确定，client 解析器读得回那句错", async () => {
    const { host } = await boot(["不该被调用"], { "a.ts": "export const a = 1;\n" });
    const context = await serviceOf(host).context({ sessionId: "ghost" });
    const view = parseContextResponse(context);
    assert.equal(view.ok, false);
    assert.equal(typeof view.error, "string");
    assert.ok((view.error ?? "").length > 0);
    // 失败路径不能悄悄打到模型：这条负例此前只判回执形状，「服务照样发起 organize」也算绿。
    assert.equal(host.adapter.requests.length, 0, "会话不存在时不该有模型调用");
  });
});
