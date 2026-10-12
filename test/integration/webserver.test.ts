// test/integration/webserver.test.ts —— 任务 #2：真 `dsh-host-webserver` 上的 HTTP 集成。
//
// 与 test/routes.test.ts 的分工：那里用最小 req/res 替身驱动 `createRouteHandlers`
// （快、能把每个回执分支都点一遍）；这里把同一个 handler 交进**真 node:http 监听**，
// 于是只有真件才给得出的东西进入判据：
//   · 路径匹配到底是 exact 还是 prefix（官方 `WebRouteKind`：packages/host/webserver/src/index.ts:44）；
//   · 405 的 `Allow` 头与体能不能同时活过真 ServerResponse；
//   · `sec-fetch-site` / `Origin` / `Host` 三个信任位在真请求上的形状（fetch 不带 Origin，
//     桩里却可以随手写一个）；
//   · **注销语义**：本包 fiber 卸载后路由必须整片消失（disposer 见 host.ts:2173-2179），
//     而监听器还在 → 官方未命中回执是 404 空体（index.ts:400-404）；
//   · 真 LlmRuntime 把本包的 one-shot 请求递到适配器时，`system`/`messages` 到底长什么样。
//
// 装配与逐条行号见 test/integration/host-stack.ts 文件头。
import { afterEach, beforeEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { request as createHttpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { Context } from "@deepseek-ai/cordis";

import { HOST_MESSAGES } from "../../src/host-messages.ts";
import { bootHostStack, textReply, PROVIDER } from "./host-stack.ts";
import type { HostStack } from "./host-stack.ts";

const MESSAGES = HOST_MESSAGES.zh;
const PATHS = {
  defaults: "/_dsh/dir-prep/default-templates",
  context: "/_dsh/dir-prep/context",
  model: "/_dsh/dir-prep/model",
  organize: "/_dsh/dir-prep/organize",
  import: "/_dsh/dir-prep/import",
} as const;

let stack: HostStack | undefined;
let workdir: string | undefined;

/* 三条规则整文件豁免，各有其因：
   · vitest/require-top-level-describe —— 台子是全局的（一枚真 Context + 一台真监听 + 一棵
     临时目录），hooks 属装配而不属任何一族用例；塞进某一族 describe 会让另外几族失去隔离。
   · promise/avoid-new —— rawRequest 要把 node:http 的回调式响应封成 Promise，官方没有 await 版。
   · eslint(no-await-in-loop) —— 逐条路由**串行**打：前一条的断言必须先成立，并发发出去就
     分不清 403 是哪一条给的。 */
/* oxlint-disable vitest/require-top-level-describe, promise/avoid-new, no-await-in-loop */

async function boot(options = {}): Promise<HostStack> {
  workdir = await mkdtemp(path.join(os.tmpdir(), "organize-http-"));
  stack = await bootHostStack(options);
  return stack;
}

beforeEach(() => {
  stack = undefined;
});

afterEach(async () => {
  if (stack !== undefined) {
    await stack.dispose();
    stack = undefined;
  }
  if (workdir !== undefined) {
    await rm(workdir, { recursive: true, force: true });
    workdir = undefined;
  }
});

/** 回执体按「是 JSON 对象」判；404 空体与非 JSON 一律归一成空表。 */
function safeJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 用 node:http 原语发一发，好把 Host 头写成任意值（fetch 递不动这一位）。 */
async function rawRequest(
  port: number,
  route: string,
  headers: Record<string, string>,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = createHttpRequest({
    hostname: "127.0.0.1",
    port,
    path: route,
    method: init.method ?? "GET",
    headers,
  });
  const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    request.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
  return { status: response.status, body: safeJsonObject(response.text) };
}

describe("五条路由在真监听上", () => {
  it("GET 全通：exact 路径逐条命中，尾随一段就落 404 空体", async () => {
    const host = await boot();
    host.session("s1", process.cwd());
    const model = await host.request(PATHS.model, { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(model.status, 200);
    assert.equal(model.body["ok"], true);
    assert.equal(model.body["provider"], PROVIDER);
    assert.equal(model.body["model"], "organize-model");
    assert.match(model.headers["content-type"] ?? "", /application\/json/u);
    assert.equal(
      model.headers["cache-control"],
      "no-store",
      "sendJson 带 no-store（shared/lib/http.ts:34）",
    );

    const context = await host.request(`${PATHS.context}?sessionId=s1`);
    assert.equal(context.status, 200);
    assert.equal(context.body["ok"], true);
    assert.ok(
      typeof context.body["csrf"] === "string" && context.body["csrf"].length > 0,
      "context 下发 CSRF 令牌",
    );

    const defaults = await host.request(PATHS.defaults);
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body["ok"], true);
    assert.ok(
      Array.isArray(defaults.body["templates"]),
      "内置精选表按需载入（真产物 templates.data.mjs）",
    );

    // kind:'exact' 的判据就在这里：官方匹配表把 exact 与 prefix 分家（index.ts:511-520），
    // 尾随一段既不属于本包任何路由，也只可能是宿主自己的 SPA fallback 面。
    const trailing = await host.request(`${PATHS.model}/extra`);
    assert.equal(trailing.status, 404);
    assert.equal(trailing.text, "", "未命中回执是空体（index.ts:400-404）");
  });

  it("方法面：错方法回 405 + Allow + JSON 体，真 ServerResponse 三样都留得住", async () => {
    const host = await boot();
    const wrongOnModel = await host.request(PATHS.model, { method: "POST" });
    assert.equal(wrongOnModel.status, 405);
    assert.equal(wrongOnModel.headers["allow"], "GET");
    assert.deepEqual(wrongOnModel.body, { ok: false, error: "GET only" });

    const wrongOnOrganize = await host.request(PATHS.organize, { method: "GET" });
    assert.equal(wrongOnOrganize.status, 405);
    assert.equal(wrongOnOrganize.headers["allow"], "POST");
    assert.deepEqual(wrongOnOrganize.body, { ok: false, error: "POST only" });

    const wrongOnDefaults = await host.request(PATHS.defaults, { method: "PUT" });
    assert.equal(wrongOnDefaults.status, 405);
  });

  it("import 是无 CSRF 的只读端点：同源 POST 直接产出条目表", async () => {
    const host = await boot();
    const result = await host.request(PATHS.import, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body["ok"], true);
    assert.ok(
      Number(result.body["count"]) > 200,
      `内置角色库应整体可导（实际 ${String(result.body["count"])}）`,
    );
  });
});

describe("信任闸门与 CSRF 在真请求上", () => {
  it("缺 CSRF 的 organize 回 403，补齐 context 下发的令牌即 200", async () => {
    const host = await boot();
    host.session("s1", process.cwd());
    const context = await host.request(`${PATHS.context}?sessionId=s1`);
    const token = String(context.body["csrf"]);

    const bare = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "把这段整理一下", sessionId: "s1" }),
    });
    assert.equal(bare.status, 403);
    assert.equal(bare.body["error"], "invalid csrf token");

    const armed = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dir-prep-csrf": token },
      body: JSON.stringify({ prompt: "把这段整理一下", sessionId: "s1" }),
    });
    assert.equal(armed.status, 200);
    assert.equal(armed.body["ok"], true);
    assert.equal(armed.body["content"], "整理后的正文");
  });

  it("sec-fetch-site=cross-site 与不速 Origin 都拒在闸门，五条路由一条不漏", async () => {
    const host = await boot();
    for (const route of Object.values(PATHS)) {
      const crossSite = await host.request(route, { headers: { "sec-fetch-site": "cross-site" } });
      assert.equal(crossSite.status, 403, `${route} 该被 sec-fetch-site 拦下`);
      assert.equal(crossSite.body["error"], "cross-origin request rejected");

      const forgedOrigin = await host.request(route, {
        headers: { origin: "http://evil.example" },
      });
      assert.equal(forgedOrigin.status, 403, `${route} 该被 Origin 拦下`);
    }
  });

  it("host 权威不是回环 → untrusted host authority（本包不许被 DNS rebinding 喂）", async () => {
    const host = await boot();
    // fetch 递不动 Host（undici 自己接管这一位），故这一条走 node:http 原语：
    // 真要能伪造 Host 的客户端正是这一族，测试面不能比攻击面更弱。
    const rebound = await rawRequest(host.port, PATHS.model, { host: "evil.example" });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.body["error"], "untrusted host authority");
    // 同一台回环服务上，字面量回环仍是放行档（信任闸门的判据在 Host 权威那一位，不是端口）
    const loopback = await rawRequest(host.port, PATHS.model, {
      host: `127.0.0.1:${String(host.port)}`,
    });
    assert.equal(loopback.status, 200);
  });

  it("body 面：超限 413、坏 JSON 400，两条回执不互相糊掉", async () => {
    // 限额走行 config（非 volatile 位），顺带证明"行 config 真进 apply 第二参数"。
    const host = await boot({ row: { importBodyMaxBytes: 256 } });
    host.session("s1", process.cwd());
    const token = await host.csrfToken();
    const oversized = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dir-prep-csrf": token },
      body: JSON.stringify({ prompt: "x".repeat(4096), sessionId: "s1" }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body["error"], "request body too large");

    const brokenJson = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dir-prep-csrf": token },
      body: "{不是 JSON",
    });
    assert.equal(brokenJson.status, 400);
    assert.equal(brokenJson.body["error"], MESSAGES.invalidJsonBody);
  });
});

describe("真 LLM 管线与本包的 organize 契约", () => {
  it("one-shot 请求：角色正文进 user 消息的 &lt;data&gt; 围栏，绝不进 system", async () => {
    const host = await boot({
      script: [textReply("整理版：请补充目标目录")],
      localePreference: "en",
    });
    host.session("s1", process.cwd());
    const token = await host.csrfToken();
    const result = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dir-prep-csrf": token },
      body: JSON.stringify({ prompt: "把需求理一理", sessionId: "s1", roleText: "资深产品经理" }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body["content"], "整理版：请补充目标目录");

    const [request] = host.adapter.requests;
    assert.ok(request !== undefined, "适配器收到了一次请求");
    assert.equal(request.provider, PROVIDER);
    assert.equal(request.model, "organize-model");
    // `system` 是 GenerateOptions 的独立位（packages/llm/llm/src/types.ts:524-528）。
    // 本包的信任序（host.ts:1265-1288 buildOrganizeUser + :1442 一侧的 buildOrganizeSystem
    // 文档块）把 system 只留给宿主自己产生的内容：角色正文是**用户仓库里可控的文本**，
    // 进了 system 就等于让克隆仓库的人拿到最高信任位。
    assert.doesNotMatch(String(request.system), /资深产品经理/u);
    assert.match(String(request.system), /Current working directory/u);
    assert.equal(request.messages.length, 1);
    const userText = JSON.stringify(request.messages[0]);
    assert.match(userText, /资深产品经理/u, "角色正文必须真的递到模型");
    assert.match(userText, /<data>/u, "不可信块走围栏，与草稿同层");
    // 英文 locale 偏好（真 describe() 里那一条）→ host 文案整表切英
    assert.match(String(request.system), /drafting assistant/u);
  });

  it("会话缺席：真 SessionStore.get 回 undefined，路由降级成 cwdUnknown 而不是 500", async () => {
    const host = await boot();
    const token = await host.csrfToken();
    const missing = await host.request(`${PATHS.context}?sessionId=no-such`);
    assert.equal(missing.status, 200);
    assert.equal(missing.body["ok"], false);
    assert.equal(missing.body["error"], MESSAGES.cwdUnknown);

    const organize = await host.request(PATHS.organize, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dir-prep-csrf": token },
      body: JSON.stringify({ prompt: "x", sessionId: "no-such" }),
    });
    assert.equal(organize.status, 200);
    assert.equal(organize.body["error"], MESSAGES.cwdUnknown);
    assert.equal(host.adapter.requests.length, 0, "拿不到 cwd 就不该花一次模型调用");
  });
});

describe("注销语义", () => {
  it("插件 fiber 卸载 → 五条路由整片 404，监听器仍在", async () => {
    const host = await boot();
    const armed = await host.request(PATHS.model);
    assert.equal(armed.status, 200);
    await host.pluginFiber.dispose();
    for (const route of Object.values(PATHS)) {
      const gone = await host.request(route);
      assert.equal(gone.status, 404, `${route} 该随插件卸载注销`);
      assert.equal(gone.text, "");
    }
    // 服务器还活着：换一枚新路由照样能挂、能打（证 404 不是"连接被拒"）
    const opened = host.ctx.webServer.register({
      kind: "exact",
      path: "/after-unload",
      handler: (_req, res) => {
        res.end("alive");
      },
    });
    const probe = await fetch(host.url("/after-unload"));
    assert.equal(probe.status, 200);
    assert.equal(await probe.text(), "alive");
    opened();
  });

  it("同 (kind,path) 重复注册即抛：本包卸载不彻底会被下一次装载当场炸穿", async () => {
    const host = await boot();
    assert.throws(
      () =>
        host.ctx.webServer.register({
          kind: "exact",
          path: PATHS.model,
          handler: (_req, res) => {
            res.end("dup");
          },
        }),
      /duplicate exact route/u,
    );
    // prefix 表与 exact 表分家（index.ts:334-341）：同一路径以 prefix 再挂一次是合法的
    const prefixed = host.ctx.webServer.register({
      kind: "prefix",
      path: PATHS.model,
      handler: (_req, res) => {
        res.end("prefixed");
      },
    });
    const hit = await fetch(host.url(`${PATHS.model}/nested`));
    assert.equal(await hit.text(), "prefixed", "longest-prefix-wins（index.ts:511-520）");
    prefixed();
  });

  it("整台卸载（WebServer 自己的 fiber 收摊）后端口不再应答", async () => {
    const ctx = new Context();
    await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0 });
    const { port } = ctx.webServer;
    assert.equal(ctx.webServer.protocol, "http:", "protocol 自带尾冒号（index.ts:324-326）");
    const before = await fetch(`http://127.0.0.1:${String(port)}/anything`);
    assert.equal(before.status, 404);
    await ctx.fiber.dispose();
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${String(port)}/anything`),
      /fetch failed|ECONNREFUSED|ECONNRESET/u,
    );
  });
});
