// test/integration/host-stack.ts —— 真实宿主 HTTP 台的装配夹具（任务 #2/#6 共用）。
//
// 装的全是真件（发布在 npm 上的同一份 0.2.1-alpha.2，版本与本包 peer 面逐条对齐）：
//   WebServer        @deepseek-ai/dsh-host-webserver      真 node:http 监听
//   SessionStore     @deepseek-ai/dsh-session             真会话仓库（cwd 校验、header 冻结）
//   LlmRuntime       @deepseek-ai/dsh-llm                 真适配器注册表 + 真 stream 管线
//   AgentDefaultModel @deepseek-ai/dsh-agent-default-model 真默认模型读面（volatile 引用）
//   DiskFileSystem   ./real-fs.ts                         真磁盘上的 FileSystem 子类
// 只有 `settings` 是一枚**形状合规的桩**：真 `SettingsForms` 硬注入 `configEditor` +
// `profileContext`（packages/settings/settings/src/index.ts:224），属于 Loader 启动层，
// 由 test/integration/settings-boot.test.ts 用真 profile + 真 Loader 专管，不在这里重测。
//
// 契约证据（deepseek-harness @ dsh-v0.2.1-alpha.2）：
//  · `WebServer` 服务名 'webServer'、`Context.webServer` 合并：packages/host/webserver/src/index.ts:302 / :27-30。
//  · `register(route)` 只吃 `{kind:'exact'|'prefix', path, handler(req,res)}`，同 (kind,path)
//    重复即抛，返回 disposer：:44(kind)/:47-53(WebRoute)/:334-341(register)；
//    未命中路径 → 404 空体：:400-404；handler 抛/reject → 400（头已发则 destroy）：:411-425。
//  · `port` 是**实际监听端口**（config.port=0 时由 OS 给），`host` 是配置字面量，
//    `protocol` 带尾冒号（'http:'）：:310-326 —— URL 拼接因此不能再补冒号。
//  · `SessionStore`：服务名 'sessions'（packages/core/session/src/index.ts:1077）、
//    `get(id)` 缺席回 undefined（:1351）、`create(id,{meta:{cwd}})` 只收**绝对** cwd
//    （:112-116），header 冻结后 `cwd` 是只读位（types.ts:104-105）。
//  · `LlmRuntime`：服务名 'llm'（packages/llm/llm/src/index.ts:351）、
//    `stream(options)` 返回 `AsyncIterable<StreamChunk>`（:191/:1143），
//    `registerAdapter(providers, adapter)` 重复路由抛 DUPLICATE_ADAPTER（types :246-253）。
//  · `GenerateOptions` 必填 provider/model/messages，`system` 是 one-shot 专用位
//    （packages/llm/llm/src/types.ts:511-528）——本包 organize 正是 one-shot 形状。
//  · `AgentDefaultModelConfig.currentSelection()` 现读 volatile 引用
//    （packages/agent-default-model/src/index.ts，服务名 'agentDefaultModel'）。
import { Context } from "@deepseek-ai/cordis";
import { request as createHttpRequest } from "node:http";
import type { Fiber } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { SessionStore } from "@deepseek-ai/dsh-session";
import type { Session, SessionId } from "@deepseek-ai/dsh-session";
import { LlmAdapter, LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import AgentDefaultModel from "@deepseek-ai/dsh-agent-default-model";
import { brandString } from "@deepseek-ai/dsh-brand";
import { LOCALE_SETTINGS_NAMESPACE } from "@jayyuen66/dsh-plugin-shared/lib/locale";

import { apply, Config, inject } from "../../host.ts";
import { DiskFileSystem } from "./real-fs.ts";

/** 脚本模型的路由名：`registerAdapter([PROVIDER], …)` 与行 config 的 provider 同一枚值。 */
export const PROVIDER = "organize-integration";

/** 一次流式回复 = 一组官方 StreamChunk（每条占一个 block index，与官方适配器契约同形）。 */
export type ScriptedReply = readonly StreamChunk[];

/** 一段纯文本回复（本包 organize 只需要 text 块）。 */
export function textReply(text: string): ScriptedReply {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** 脚本化模型：每次 `stream()` 消耗一格剧本，并把收到的请求全量记下来。 */
export class ScriptedAdapter extends LlmAdapter {
  public readonly requests: GenerateOptions[] = [];

  private readonly script: readonly ScriptedReply[];

  public constructor(script: readonly ScriptedReply[]) {
    super();
    this.script = script;
  }

  // 官方契约里唯一需要"这台机器上有什么模型"的一位；脚本模型没有这种状态可查。
  // oxlint-disable-next-line eslint/class-methods-use-this -- 覆写的是契约位，无状态可读
  public override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  public async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const entry = this.script[this.requests.length - 1];
    if (entry === undefined) {
      throw new Error("ScriptedAdapter: 剧本用完（模型多跑了一次）");
    }
    for (const chunk of entry) {
      yield chunk;
    }
  }
}

/** `settings` 桩里本包真会调的那两位（形状守卫 `hasFnMember(value,'describe')` 认这个面）。 */
export interface SettingsStub {
  describe: () => { ns: string; value: unknown; revision: number }[];
  configure: (presentation: { auto?: boolean }, owner: unknown) => () => void;
  /** 用例侧读取：本包有没有登记「别自动生成设置页」的页面策略。 */
  readonly configured: { presentation: { auto?: boolean }; owner: unknown }[];
  /** 用例侧读取：每次路由请求都调 describe()，故这条计数即「现读次数」。 */
  described: number;
}

/** 一台装好真件的 HTTP 台。 */
export interface HostStack {
  readonly ctx: Context;
  readonly pluginFiber: Fiber;
  readonly fs: DiskFileSystem;
  readonly adapter: ScriptedAdapter;
  readonly settings: SettingsStub;
  /** 实际监听端口（config.port=0 时由 OS 分配）。 */
  readonly port: number;
  /** 拼 URL 用（`protocol` getter 自带尾冒号，见文件头行号）。 */
  url: (route: string, query?: Record<string, string>) => string;
  /** 打一次请求并解 JSON（非 JSON 时回原文，便于断言 404 空体那类）。 */
  request: (route: string, init?: RequestInit) => Promise<HttpResponse>;
  /** 建一枚真会话（cwd 必须是绝对路径，否则 SessionStore 当场抛）。 */
  session: (id: string, cwd: string) => Session;
  /** 取回 per-apply 的 CSRF 令牌（从 GET model 的回执里读，而不是从内部变量猜）。 */
  csrfToken: () => Promise<string>;
  dispose: () => Promise<void>;
}

/** 一次真请求的回执（status + 已解 JSON + 原文 + 小写化响应头）。 */
export interface HttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly headers: Record<string, string>;
}

/** 响应体只能按「是 JSON 对象」判：404 空体、纯文本错误都归一成空表，断言侧不必再 try。 */
function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 走 node:http 原语打一发，好把任意头（Host / sec-fetch-* / CSRF）写成任何值。
 * 两半的点对点用例必须用真 socket：happy-dom 的 fetch 会按浏览器同源策略拒绝这台
 * 随机端口上的临时服务器，而浏览器里 client 打的是同源相对路径、本就没有这一层拦截。
 */
export async function wireRequest(
  port: number,
  route: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  const request = createHttpRequest({
    hostname: "127.0.0.1",
    port,
    path: route,
    method: init.method ?? "GET",
    headers: init.headers,
  });
  // node:http 的请求是事件式的，官方没有 await 版：这一枚 Promise 包装是必须的（故就地豁免）
  // oxlint-disable-next-line promise/avoid-new
  const response = await new Promise<{
    status: number;
    text: string;
    headers: Record<string, string>;
  }>((resolve, reject) => {
    request.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          headers,
        });
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
  return {
    status: response.status,
    body: safeJson(response.text),
    text: response.text,
    headers: response.headers,
  };
}

/** 一次装配的可选面。 */
export interface BootOptions {
  /** 行 config（cordis 校验+填默认后进 `apply` 的第二参数）。 */
  row?: Record<string, unknown>;
  /** 剧本模型：organize 回合的回复序列。 */
  script?: readonly ScriptedReply[];
  /** 宿主 locale 偏好（真 describe() 里那一条的形状）；undefined 即不投影 locale 条目。 */
  localePreference?: string;
  /** 绑定地址：默认回环；给非回环字面量即进入信任闸门的局域网档。 */
  host?: string;
}

/** 装配一台真 HTTP 台（不 it()：共享夹具自带用例会让结构类 lint 规则落到夹具头上）。 */
export async function bootHostStack(options: BootOptions = {}): Promise<HostStack> {
  const ctx = new Context();
  const configured: { presentation: { auto?: boolean }; owner: unknown }[] = [];
  const stub: SettingsStub = {
    describe: () => {
      stub.described += 1;
      return options.localePreference === undefined
        ? []
        : [
            {
              ns: LOCALE_SETTINGS_NAMESPACE,
              value: { preference: options.localePreference },
              revision: 0,
            },
          ];
    },
    configure: (presentation: { auto?: boolean }, owner: unknown) => {
      configured.push({ presentation, owner });
      return () => {
        /* 桩：disposer 无副作用，页面策略的登记事实已经进了 configured */
      };
    },
    configured,
    described: 0,
  };
  ctx.provide("settings", stub);

  const fs = new DiskFileSystem(ctx);
  await ctx.plugin(WebServer, { host: options.host ?? "127.0.0.1", port: 0 });
  await ctx.plugin(SessionStore);
  await ctx.plugin(LlmRuntime);
  const adapter = new ScriptedAdapter(options.script ?? [textReply("整理后的正文")]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  await ctx.plugin(AgentDefaultModel, { provider: PROVIDER, model: "organize-model" });

  const pluginFiber = await ctx.plugin(
    { name: "dir-prep-organize", inject, Config, apply },
    options.row ?? {},
  );

  const { port } = ctx.webServer;
  const origin = `http://127.0.0.1:${String(port)}`;

  const urlOf = (route: string, query?: Record<string, string>): string => {
    const url = new URL(route, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.href;
  };

  /** 打一次请求：route 可以自带 query（`new URL` 原样保留），init 交给 fetch。 */
  const request = async (route: string, init?: RequestInit): Promise<HttpResponse> => {
    const response = await fetch(urlOf(route), init);
    const text = await response.text();
    const body = safeJson(text);
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers) {
      headers[key] = value;
    }
    return { status: response.status, body, text, headers };
  };

  return {
    ctx,
    pluginFiber,
    fs,
    adapter,
    settings: stub,
    port,
    url: urlOf,
    request,
    session: (id: string, cwd: string) =>
      ctx.sessions.create(brandString<SessionId>(id), { meta: { cwd } }),
    csrfToken: async () => {
      const taken = await request("/_dsh/dir-prep/model");
      const { csrf } = taken.body;
      return typeof csrf === "string" ? csrf : "";
    },
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}
