// test/integration/host-stack.ts —— 真实宿主服务的装配夹具（任务 #2/#6 共用）。
//
// 装的全是真件（发布在 npm 上的同一份 0.2.1-alpha.2，版本与本包 peer 面逐条对齐）：
//   SessionStore      @deepseek-ai/dsh-session             真会话仓库（cwd 校验、header 冻结）
//   LlmRuntime        @deepseek-ai/dsh-llm                 真适配器注册表 + 真 stream 管线
//   AgentDefaultModel @deepseek-ai/dsh-agent-default-model 真默认模型读面（volatile 引用）
//   DiskFileSystem    ./real-fs.ts                         真磁盘上的 FileSystem 子类
// 宿主 HTTP 层不在这里装配：本仓数据面已交给 Typert Remote（服务名 dirPrepOrganize），
// 没有任何 /_dsh/dir-prep/* 路由可挂；插件的路由装配面由 test/routes.test.ts 直接驱动 apply 覆盖。
// 曾有一整套 node:http 探针（wireRequest / csrfToken / url），随路由面删除后已无消费方 —— 留着
// 只会让读者以为 HTTP 层仍被这组用例覆盖，故一并删除。
//
// 只有 `settings` 是一枚**形状合规的桩**：真 `SettingsForms` 硬注入 `configEditor` +
// `profileContext`（packages/settings/settings/src/index.ts），属于 Loader 启动层，
// 由 test/integration/settings-boot.test.ts 用真 profile + 真 Loader 专管，不在这里重测。
//
// 契约证据（deepseek-harness @ dsh-v0.2.1-alpha.2）：
//  · `SessionStore`：服务名 'sessions'（packages/core/session/src/index.ts）、
//    `get(id)` 缺席回 undefined、`create(id,{meta:{cwd}})` 只收**绝对** cwd
//    header 冻结后 `cwd` 是只读位（types.ts）。
//  · `LlmRuntime`：服务名 'llm'（packages/llm/llm/src/index.ts）、
//    `stream(options)` 返回 `AsyncIterable<StreamChunk>`，
//    `registerAdapter(providers, adapter)` 重复路由抛 DUPLICATE_ADAPTER（错误码在 types）。
//  · `GenerateOptions` 必填 provider/model/messages，`system` 是 one-shot 专用位
//    （packages/llm/llm/src/types.ts）——本包 organize 正是 one-shot 形状。
//  · `AgentDefaultModelConfig.currentSelection()` 现读 volatile 引用
//    （packages/agent-default-model/src/index.ts，服务名 'agentDefaultModel'）。
import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import type Schema from "@deepseek-ai/schemastery";
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
  /** 用例侧读取：每次请求都调 describe()，故这条计数即「现读次数」。 */
  described: number;
}

/** 一台装好真件的服务栈。 */
export interface HostStack {
  readonly ctx: Context;
  readonly pluginFiber: Fiber;
  readonly fs: DiskFileSystem;
  readonly adapter: ScriptedAdapter;
  readonly settings: SettingsStub;
  /** 建一枚真会话（cwd 必须是绝对路径，否则 SessionStore 当场抛）。 */
  session: (id: string, cwd: string) => Session;
  dispose: () => Promise<void>;
}

/** 一次装配的可选面。 */
export interface BootOptions {
  /** 行 config（cordis 校验+填默认后进 `apply` 的第二参数）。 */
  row?: Record<string, unknown>;
  /** 剧本模型：organize 回合的回复序列。 */
  script?: readonly ScriptedReply[];
  /** 宿主 locale 偏好（真 describe() 里那一条的形状）；undefined 即不投影 locale 条目。 */
  localePreference?: string;
  /** 插件模块（name/inject/Config/apply 四件）。缺省装本仓源码；产物态 e2e 传构建产物。
   *  apply 的形状与 cordis Loader 插件同宽（ctx + 行 config），Config 交 Schemastery schema。 */
  module?: {
    name: string;
    inject: readonly string[];
    Config: Schema<any, any>;
    apply: (ctx: Context, config: any) => any;
  };
}

// 宿主 alpha.3 的 dsh-app-boot 在模块顶层静态 import 这枚 peer，而本仓的 pnpm 配置是
// `autoInstallPeers: false`——没人装它时，失败会落在 boot 链深处一句 Cannot find package 上。
// 夹具先在这里点名解析一次：缺件就在这里说清缺的是谁，而不是让十几层栈去猜。
const HOST_BOOT_PEER = "@deepseek-ai/cordis-plugin-group";

function requireHostBootPeer(): void {
  try {
    import.meta.resolve(HOST_BOOT_PEER);
  } catch (error) {
    throw new Error(
      `集成夹具起不了宿主的 boot 链：peer ${HOST_BOOT_PEER} 解析不到（${String(error)}）`,
      { cause: error },
    );
  }
}

export async function bootHostStack(options: BootOptions = {}): Promise<HostStack> {
  requireHostBootPeer();
  const ctx = new Context();
  // 装配链要原子：任何一枚 plugin 抛错时，已装的 service / 插件 fiber 不能留在 Context 上，
  // 否则调用方拿到 rejection 却仍握着一个半装配的 ctx（进程不退出、重新装配还会撞重复服务）。
  try {
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
    await ctx.plugin(SessionStore);
    await ctx.plugin(LlmRuntime);
    const adapter = new ScriptedAdapter(options.script ?? [textReply("整理后的正文")]);
    ctx.llm.registerAdapter([PROVIDER], adapter);
    await ctx.plugin(AgentDefaultModel, { provider: PROVIDER, model: "organize-model" });

    const pluginFiber = await ctx.plugin(
      options.module ?? { name: "dir-prep-organize", inject, Config, apply },
      options.row ?? {},
    );

    return {
      ctx,
      pluginFiber,
      fs,
      adapter,
      settings: stub,
      session: (id: string, cwd: string) =>
        ctx.sessions.create(brandString<SessionId>(id), { meta: { cwd } }),
      dispose: async () => {
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    // 释放半装配的 Context：dispose 自己的失败不能盖住原始失败，故吞掉并保留原始 error。
    await ctx.fiber.dispose().catch(() => {
      /* 释放失败不能盖住原始装配错误：保留最初那条更有诊断价值 */
    });
    throw error;
  }
}
