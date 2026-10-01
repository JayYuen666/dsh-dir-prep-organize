// dir-prep-organize host 半：对话输入框"整理"按钮的后端。
//
// 架构（全量源码复核后重写；此前 harness.handle/host.call 方案作废——
// 那是动态插件的闭包 RPC，loader 行插件的 Client 半没有该通道）：
//   Client 半（src/client-entry.ts）→ fetch('/_dsh/dir-prep/*') → 本文件
//   注册的 webServer 路由（session-rescue / memory-insight 同款已验证模式）。
//
// 三个端点：
//   GET  /_dsh/dir-prep/context?sessionId=…   目录上下文（文件名+大小+关键文件摘要）
//   GET  /_dsh/dir-prep/model?sessionId=…      当前默认模型（provider/model/effort）
//   POST /_dsh/dir-prep/organize               用该模型整理优化草稿（LLM 流式聚合）
//   POST /_dsh/dir-prep/import                 角色 .md 导入 → 模板条目（只读，见下方导入节）
//
// 文案双语：本文件产出的固定文案（①「整理」的 system prompt，面向模型；②会回显到设置卡
// 与整理按钮的导入/端点回执，面向用户）集中在 src/host-messages.ts，按官方 locale 插件
// 的偏好现读取表（见 apply 的 localeMessages）；纯函数一律以字典为**入参**、不读设置。
// console.* 日志与注释不随界面语言切换，故留中文；agents/ 角色库与
// src/default-templates.generated.ts 是用户可编辑的数据，不做机翻。
//
// 导入边界（「cwd 内 + 内置角色目录 allowlist」，见 importPathError）：绝对路径**默认
// 拒绝**，只放行三类根——会话 cwd、本包内置角色库 agents/、设置 importAllowRoots 登记的
// 目录；越界回 403 + {ok:false,error}（错误文本点名允许区并回显解析后的路径），
// path 字段非字符串/纯空白回 400，不再静默降级成"导入内置全部"。
//
// 数据源（全部 ctx.get 可选读取，缺服务时端点报 error 而非炸插件）：
//   sessions.get(sessionId).header.cwd   会话 cwd（目录源，用户拍板）
//   fs.resolve/listDir/readText          目录枚举与关键文件首段
//   agentDefaultModel.currentSelection   当前默认模型（composer 选择落此处）
//   llm.stream                           模型调用（GenerateOptions 契约）
//
// 目录粒度：文件名+大小+关键文本文件全文。条目数不设上限（上下文完整性优先），
// 但**单个文件按字节上限整份跳过**：readWholeText 在 harness 侧无上限，一个顶层
// 巨型 .md/.json 就能撑爆响应并把半份内容当"全量摘要"回投，宁可少喂一条并如实
// 计数，也不静默拖垮端点。摘要/导入读取一律走有界并发（fd 打满时 EMFILE 会让
// 片段被静默丢掉而仍报 ok:true）。
// 失败语义（用户拍板）：端点返回 {ok:false,error}，Client 隐藏面板并显示错误。
// 超限/坏流的 HTTP 语义（审计修复）：读 body 与 JSON.parse 分开处理——
// 413（body 超字节上限）/ 400（流中断）/ 400（非法 JSON），不再把超限糊成
// "请求体不是合法 JSON" 的 200 回执。body 读取收敛到 shared/lib/http（本包原
// 自研 readBody 已删）。
//
// 模板设置（0.1.7 起为**隐式注册**）
// 宿主移除了 settings.register/get/installSection：命名空间 = 本包 cordis.patch.yml 里的
// 裸条目 id（dir-prep-organize），可编辑字段 = 下面 Config 上标了 `.volatile()` 的字段。
// 一个 volatile 字段都没有的条目会被宿主 describe() 整条跳过
// （packages/settings/settings/src/index.ts:308-309），写入则抛 `has no volatile fields`（:386），
// 所以「哪些项出现在设置卡上」现在是 schema 自己的事（test/host.test.ts 用宿主同一判据回看）。
// 旧 register 的 `base` 底座也随之取消，逐字段落到 `.default(...)`（见 configSchema 上方注释）：
// importAllowRoots 落 `.default([])`，而 templates **不给默认**——src/default-templates.generated.ts
// 那份精选集（scripts/gen-defaults.mjs 从 agents/ 角色库生成）由 **client 半**持有并作回落，
// host 半不再读它，也不再有把 289 KB 列表当底座交进 settings 的那一步。
// client（设置卡/下拉）直读本条目的配置表单 `ctx.configForms.get(entryId)`（0.1.7 起取代
// 已随宿主移除的 settingsScope），不经 HTTP、零 LLM。数组 set 语义
// 已按 dsh-settings 源码取证：applyPathOp 字段级整体替换 + cloneJsonShaped
// JSON 白名单允许普通对象数组（session-rescue providerExcludes:string[] 先例）。
// host 侧只剩两面用 settings：configure（声明本包自带卡片、别让宿主再生成自动页）
// 与 describe（跨命名空间现读官方 locale 插件的语言偏好）。配置值本身由 cordis 在校验
// 过 Config schema 之后按 volatile 引用交进 apply，取当前值一律 config.<field>.get()——
// 「存量配置坏一段」在装载期就抛、由宿主报装配失败，插件侧不再有可兜的那条 try/catch。

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import type { Context, Volatile } from "@deepseek-ai/cordis";
import type { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";
// 值导入：`brandString` 是官方幻影品牌唯一的合法构造口（用在哪两位上见下面 SessionsService 的
// 注释）。它是恒等函数，且 dsh-brand 自述「不拥有任何具体域值，也不保留任何运行时身份或可变
// 状态，独立安装的副本产出可互换的值」——据此把它落 dependencies、
// 产物留裸说明符；旧写法（放 devDependencies）会让 rolldown 把函数体内联进 host.js，等于
// 每包各持一份官方实现。与 danger-guard 的 `brandNumber`、session-rescue 的 `brandString`
// 同一处、同一理由。
import { brandString } from "@deepseek-ai/dsh-brand";
import type { FsDirEntry, FsTarget, FileSystem } from "@deepseek-ai/dsh-fs";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";
import type {
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  RequestUserInput,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import { guardBody, queryParam, sendJson } from "@jayyuen66/dsh-plugin-shared/lib/http";
// 信任闸门：四条路由 handler 的第一条语句。
import { guardTrust } from "@jayyuen66/dsh-plugin-shared/lib/trust";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
// 字典本身在 src/host-messages.ts（纯数据），本文件只负责取表与注入。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { HOST_MESSAGES } from "./src/host-messages.ts";
import type { HostMessages } from "./src/host-messages.ts";
import {
  DEFAULT_TEMPLATES,
  condenseRoleBody,
  groupLabelOf,
  parseAgentFrontmatter,
} from "./src/templates.ts";
import type { AgentFileInfo, TemplateEntry } from "./src/templates.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

/** 本包送进 `llm.stream({ messages })` 的整理请求帧是 **request-only 输入**：它从不落
 *  任何持久消息位（`runOrganize` 只回 `{ content }`，路由也不把帧身份回投给卡片），所以
 *  按 0.1.7 它既不需要 `id` 也不带 `source`——证据三条：
 *  1. installed `@deepseek-ai/dsh-llm/lib/types/types.d.ts:457-462` 的 `RequestUserInput`
 *     把两面都标成 `?: never`（`readonly id?: never` / `readonly source?: never`），
 *     `GenerateOptions.messages` 收的是 `RequestMessage[] = Message | RequestUserInput`
 *     （同文件 :464，字段注记 "a hand-built one-shot may include identity-free user
 *     inputs"）；
 *  2. 持久那半边 `Message` 要的 `source.kind` 必须是**已声明**进 `MessageSourceMap` 的
 *     kind（installed `dsh-llm/lib/types/message.d.ts:101-133`），本包的
 *     `plugin:dir-prep-organize` 不在其中——旧代码同时带上 `id` 与该 kind，造的正是宿主
 *     没有的第三种形状；
 *  3. 决策记录 dsh 仓 `.agents/notes/implemented/architecture/`
 *     `2026-09-17-persistence-attribution-policy.md`："Request-only prompts need no
 *     durable identity, but constructing them as Session messages adds unnecessary source
 *     alternatives to that union."
 *  故旧的 `ORGANIZE_SOURCE_KIND` 常量（连同只被它和帧 id 用到的 `PLUGIN_NAME`）一并撤下。
 *  本包没有读回侧需要它：`extractRecentTurns` 只认真人 `kind === 'user'` 与模型
 *  `kind === 'model'`，从不按本包 kind 去重或断链，所以删除它不牵动任何 dedupe 配对。
 *  同款 request-only 先例：harness `packages/compaction/compaction-basic/src/summarizer.ts:146-150`。 */
const CONTEXT_PATH = "/_dsh/dir-prep/context";
const MODEL_PATH = "/_dsh/dir-prep/model";
const ORGANIZE_PATH = "/_dsh/dir-prep/organize";
const IMPORT_PATH = "/_dsh/dir-prep/import";
const DEFAULTS_PATH = "/_dsh/dir-prep/default-templates";
/** 插件自带角色库目录（agency-agents-zh 部门目录移入）。导入路径留空 = 全量导入此目录。 */
const AGENTS_DIR = path.join(import.meta.dirname, "agents");

/** 关键文本扩展名（这些文件取首段摘要）。仅代码/文档/结构配置面；
 *  yaml/env 等敏感配置不取摘要（凭据泄露风险，实测 .credentials.yaml 被带出）。 */
const KEY_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".rb",
  ".json",
  ".toml",
  ".md",
  ".sql",
  ".graphql",
  ".proto",
  ".css",
  ".scss",
  ".less",
]);
/** 文件名命中即跳过摘要的模式（凭据/密钥类，大小写不敏感）。 */
const SECRET_MARKERS = [
  "credential",
  "secret",
  "id_rsa",
  ".pem",
  ".p12",
  ".pfx",
  "keystore",
  ".env",
  ".key",
];
/** LLM 整理超时。 */
/** schema .default() 的单源（host 消费走 config 字段，不再直读常量）。 */
const ORGANIZE_TIMEOUT_MS = 120_000;
/** organize/import POST body 物理上限的 schema .default()（内存防爆纵深防御，非功能
 *  截断：两条路由提交的都是整理草稿与模板产物，不是大文件本体；超大输入产物由模型
 *  context 报错反馈用户自行处理）。部署间需要更宽的走 `importBodyMaxBytes` 配置字段。 */
const DEFAULT_IMPORT_BODY_MAX_BYTES = 8 * 1024 * 1024;
/** 单个关键文件的摘要字节上限。harness 的 readWholeText 无上限，超限文件整份
 *  跳过（不截半份——半份摘要会以"全量"的名义喂给模型，比没有更误导），
 *  并计入 skipped.tooLarge 回报。 */
const MAX_SNIPPET_BYTES = 256 * 1024;
/** 文件读取并发上限：Promise.all 一次铺开会在导入内置库（266 个文件）时打满
 *  fd，EMFILE 抛错被单文件 catch 吞掉 → 条目静默丢失而仍报 ok:true。 */
const READ_CONCURRENCY = 8;
/** organize 回填的 CSRF 头名（与 client-entry 侧一致）。 */
const CSRF_HEADER = "x-dir-prep-csrf";

// ── host 服务面（全部绑官方声明，不再本地镜像）────────────────────────────
// 这一族此前是「按源码逐字段核对的最小 interface」——本包当时不声明 @deepseek-ai/dsh-fs /
// dsh-llm / dsh-session 依赖，只能手抄。手抄的代价在这批里最重的一处是 `FsTarget.targetKey`：
// 官方它是品牌串 `FsTargetKey = Branded<'FsTargetKey'>`（installed
// @deepseek-ai/dsh-fs/lib/types/types.d.ts:14 与 :52-60），抄成裸 `string` 之后品牌信息在
// 整条 stream/摘要链上永久丢失（编译器不再拦得住"拿错 targetKey"）。现在本包声明这些官方包为
// devDependency（type-only，运行时仍由 ctx 注入），每个服务面都改成官方成员的 `Pick` 投影：
// 入参、返回、可选性、品牌一律由官方交出，上游改名/加必填位即在此编译不过。

// 下列形状全部 **export**：测试注入的假服务必须是这些形状的合法实现（而非
// `as never` / `as unknown as X` 绕过），类型面同样参与回归锁定。
/** 目标的官方形状直接 re-export（`targetKey` 就此是官方 `FsTargetKey` 品牌，不再降级成 string）。 */
export type { FsDirEntry, FsTarget } from "@deepseek-ai/dsh-fs";

/**
 * 官方 `FileSystem`（installed @deepseek-ai/dsh-fs/lib/types/index.d.ts:61，cordis `Service`
 * 子类 → 名义比较）的方法面投影：本包只用 `resolve`(:94) / `listDir`(:208) / `readText`(:162)。
 * 旧镜像漏抄了官方那三位的可选 `signal?: AbortSignal` 形参（抄本里没有的形参在 TS 里
 * 是"少收一个参数"，调用点不会报错，但真实宿主多一档取消语义）；投影之后它回到官方形状。
 */
export type FsService = Pick<FileSystem, "resolve" | "listDir" | "readText">;

/**
 * 本包从会话消息史的读取面 = **官方 `Message` 的键名投影**（installed
 * @deepseek-ai/dsh-llm/lib/types/message.d.ts:124-133 `MessageBase` 与各变体的 `role`），
 * 三位各自取到"本包能凭运行时守卫负责的那一档"：
 * - `role` 就此是官方 `Message['role']` 的字面量联合（上游加/改角色即在此编译不过，
 *   下面 `role === "user" || role === "assistant"` 的判定跟着动）。
 * - `content` 官方是 `readonly ContentBlock[]`（message.d.ts:128），但本包的职责是
 *   **逐块自证**：只认 `type==='text'` 且 `text` 是字符串的块（`isTextBlock`），其余
 *   （tool-call / reasoning / image / 宿主新版本才有的块）一律跳过。这里留 `unknown`
 *   不是"抹平官方形状"，而是本包**不假设交付**：`Array.isArray(msg.content)` 那道判据
 *   断言的正是"交来的可能根本不是数组"，test/host.test.ts 的「坏形状」用例钉的就是
 *   非数组 content（字符串）与数组里的裸字符串/null 项。把值域收成官方联合等于宣称
 *   "块形状可信"，那几条用例便无法表达，而为了过类型删用例是本仓红线。
 * - `source.kind` 官方是 `MessageSourceMap` 的值联合（installed message.d.ts:101-108 只有
 *   `user`/`model`/`tool`/`system-prompt`，宿主安装里另有 `model-selection` 一枚由
 *   dsh-agent 自己 merge）。**本包要读的恰是这张表里没有的 kind**：真人过滤之外的
 *   `agent-instructions` / `skill-catalog` / `memory-recall-step` / `plugin:<name>` 全是
 *   别的插件在自己模块里 merge 进来的 producer kind，不在本包的编译程序里。收成官方闭合联合
 *   只有两条路：要么在测试里伪造宿主声明（type theater），要么把"过滤注入"这几条用例删掉
 *   ——两条都不接受，故 kind 留 `string`。真人的判据仍是官方那两枚值（`"user"`/`"model"`），
 *   写成 `source?.kind === "user"` 而不是比字符串常量表。
 * 键名一个都不重述：官方给 `MessageBase` 换名，这里立刻红。
 */
export interface DerivedMessageView {
  readonly role?: Message["role"];
  readonly content?: unknown;
  readonly source?: { readonly kind?: string };
}

/**
 * 本包读到的会话面 = 官方 `Session` 两位成员的**边界投影**（installed
 * @deepseek-ai/dsh-session/lib/types/index.d.ts：`readonly header: SessionHeader` :118、
 * `deriveMessages(): Message[]` :292）。
 * 键名一律借自官方（`header` 借 `Session`、`cwd` 借 `SessionHeader`，installed
 * @deepseek-ai/dsh-llm 域内 types.d.ts:69 `readonly cwd?: string`），值域收成"本包真的读的那位
 * + 可缺失"：官方把 header/deriveMessages 记成必选成员，但那句承诺说的是宿主自己 `new`
 * 出来的 Session；跨进程递来的会话是否具备某位只能运行时判（见 `extractSessionConversation`
 * 的 `typeof session.deriveMessages !== "function"` 与 `cwdOfSession` 的 `typeof === "string"`
 * 守卫）。官方类型说宿主**承诺**什么，守卫说**交付**什么，两者并存。
 */
export interface SessionLike {
  readonly header?: Partial<Pick<SessionHeader, "cwd">>;
  readonly deriveMessages?: () => readonly DerivedMessageView[];
}

/**
 * `Context.sessions`（官方 `SessionStore`，installed @deepseek-ai/dsh-session/lib/types/
 * index.d.ts:26-28）的 `get` 一位（:436 `get(id: SessionId): Session | undefined`）在本包的
 * 读法：入参就此是官方品牌的 `SessionId`（边界上递来的是裸 string，构造口只有文件头那枚
 * `brandString<SessionId>`），返回值域换成上面的 `SessionLike` 投影——直接取官方返回的整枚
 * `Session` 类会把名义类一路渗进本包（`private log`/`surfaceManager`，:105-107），那三道运行时
 * 守卫当场在编译器眼里变成死代码，而它们挡的是真实输入。返回 `undefined` 与官方一致。
 * 口径同 danger-guard/host.ts 的 `GuardExecution`（借键名、值域换投影）。
 */
export interface SessionsService {
  get: (id: SessionId) => SessionLike | undefined;
}

/** 会话 id 的官方品牌构造：把边界上读来的裸 string 送进 `SessionStore.get`。 */
const sessionIdOf = (value: string): SessionId => brandString<SessionId>(value);
/** `ReasoningEffortId` 取官方真品牌（`Branded<'ReasoningEffortId'>`，以 dsh-brand 的
 *  `unique symbol` 为键）。原先本地重述成 `string & { effortBrand: ... }` 是**假品牌**：
 *  键不同名即不同型，宿主真值塞不进来、任何带该属性的字符串反倒能通过，注释里那句
 *  「转换点为 0」并不成立。取官方类型后模型选择与 stream 入参两侧共用同一真值。 */
export type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
/** 默认模型选择直接取官方成员的返回形状（`AgentDefaultModelConfig.currentSelection()`
 *  的返回类型，installed @deepseek-ai/dsh-agent-default-model/lib/types/index.d.ts:41）。
 *  旧镜像自己抄了 `{ provider, model, reasoningEffort? }` 三位——其中 `reasoningEffort` 是
 *  `ReasoningEffortId` 品牌（本文件上面已按官方 re-export），抄本一旦与官方漂开，
 *  品牌值塞不进 stream 入参就是静默丢字段。取 ReturnType 之后本包不再裁定它的形状。 */
export type ModelSelection = ReturnType<AgentDefaultModelConfig["currentSelection"]>;

/** 官方 `AgentDefaultModelConfig`（同文件 :24，cordis `Service` 子类 → 名义比较）的
 *  方法面投影：本包只 `currentSelection()`（:41），不写回（`saveSelection` :48 归 composer）。 */
export type AgentDefaultModel = Pick<AgentDefaultModelConfig, "currentSelection">;
/** 文本块与 request-only user 输入均取官方声明：`TextBlock` 与 `RequestUserInput`
 *  （后者的 `content` 真值是 `UserMessage["content"]` 全块集，`id`/`source` 是
 *  `?: never`——本包只发单条 user 文本消息，形状由官方约束而不是自己抄一半）。 */
export type { RequestUserInput, TextBlock } from "@deepseek-ai/dsh-llm";

/** 流块与终态取官方判别联合（`switch (chunk.type)` 即收窄载荷，不再把 `type` 写成
 *  裸 `string` + 全可选成员）。 */
export type { FinishReason, StreamChunk } from "@deepseek-ai/dsh-llm";

/** stream 入参：官方 `GenerateOptions` 的本包用到的子集。此前这里在 `Pick` 之外**另加**
 *  了一枚 `signal?: AbortSignal`，注释写着"本包附加的取消位"——官方其实**就有**这一位
 *  （installed @deepseek-ai/dsh-llm/lib/types/types.d.ts:494），另写一次等于凭空多出一个
 *  与官方并行的形状声明；现在连同 `signal` 一起 `Pick`，一处来源。 */
export type LlmStreamOptions = Pick<
  GenerateOptions,
  "provider" | "model" | "reasoningEffort" | "messages" | "system" | "signal"
>;

/** 官方 `LlmRuntime`（`Context.llm` 的类型，installed @deepseek-ai/dsh-llm/lib/types/
 *  index.d.ts:29-31）的方法面投影：本包只 `stream`。旧镜像把返回抄成
 *  `AsyncIterable<StreamChunk>`——官方那一位的真实返回域由成员自己交出，重述一次就多一处
 *  会漂移的判决（`stream` 在 installed index.d.ts 上有数枚同名成员，本包用的是 runtime 那枚）。 */
export type LlmService = Pick<LlmRuntime, "stream">;
/**
 * 官方 `WebServer`（@deepseek-ai/dsh-host-webserver，installed
 * `lib/types/index.d.ts:67` 起：cordis `Service` 子类 + 一整套 private 路由表字段
 * `exact`/`prefixes`/`upgrades`/`fallback`/`server`… → TS 对类按名义比，测试替身永远满足
 * 不了整类型）的**方法面投影**：本包只调 `register()`（installed `:90`），路由字面量因此
 * 受官方 `WebRoute`（installed `:33-39`）约束——旧镜像自己抄了一份 `WebRoute`，`kind` 的
 * `"exact" | "prefix"` 联合与 handler 的 `(IncomingMessage, ServerResponse)` 形参都是手抄
 * 的，现在全部由官方交出，disposer 亦按官方 `() => void` 收。
 * ⚠ 本包 `register` 之外仍镜像了 `registerFallback`（installed `:106`）吗：**没有**，类型上
 * 只剩 `register` 一位。但 `isWebServerService` 的**运行时**判据仍是两条（register +
 * registerFallback），理由与旧注释一致：只看 `register` 就分不出 webServer 与 settings，
 * 服务装错会静默通过。守卫入参是 `unknown`，故第二条判据不依赖类型里有这个成员。
 */
type WebServerService = Pick<WebServer, "register">;

// ── 守卫（session-rescue 同款防御：typeof 收窄为 Record / 具名方法，不经 as 断言）────

/** 服务形状守卫：value 是对象且具名成员是函数（绕开 `as Service` 断言）。 */
function hasFnMember(value: unknown, member: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  // 动态键读：dot-notation 禁字面量索引、tsc 禁索引签名点访问（互斥）。
  return typeof value[member] === "function";
}

// 各服务的最小形状守卫（apply 里从 ctx 取出后投影，替代 `svc.get(name) as X`）。
// 0.1.7 起 settings 不再暴露 register，与 webServer 的判据天然分家：本包只用
// describe（跨命名空间读）与 configure（页面策略），probe 宿主独有的 describe 即可；
// webServer 仍用「register + 独有成员 registerFallback」两条。
/**
 * 官方 `SettingsForms`（installed @deepseek-ai/dsh-settings/lib/types/index.d.ts:62，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations` → 名义
 * 比较）的方法面投影：本包只用 `describe`（跨命名空间读官方 locale 偏好，:96）与 `configure`
 * （页面策略，:80）。此前守卫的谓词类型写的是**整个类**，那是一条对本包需求的过度声明——
 * 它宣称「宿主必须给我一枚完整的 settings 服务」，而下面每个服务守卫都只点名自己用到的成员。
 */
type SettingsFormsService = Pick<SettingsForms, "describe" | "configure">;

function isSettingsService(value: unknown): value is SettingsFormsService {
  return hasFnMember(value, "describe");
}
function isWebServerService(value: unknown): value is WebServerService {
  return hasFnMember(value, "register") && hasFnMember(value, "registerFallback");
}
function isSessionsService(value: unknown): value is SessionsService {
  return hasFnMember(value, "get");
}
function isFsService(value: unknown): value is FsService {
  return hasFnMember(value, "resolve");
}
function isLlmService(value: unknown): value is LlmService {
  return hasFnMember(value, "stream");
}
function isAgentDefaultModel(value: unknown): value is AgentDefaultModel {
  return hasFnMember(value, "currentSelection");
}

/** apply 内从 ctx 取服务的 getter 面守卫（绕开 `ctx as unknown as { get }`）。
 *  ctx 由 cordis 保证是对象，只核 `get` 面即可（isRecord 已在 hasFnMember 内判过，
 *  这里再判一次会留下永远走不到的分支）。 */
interface ServiceGetter {
  get: (name: string) => unknown;
}
function isServiceGetter(value: unknown): value is ServiceGetter {
  return hasFnMember(value, "get");
}

// ── 通用工具 ───────────────────────────────────────────────────────────────

/** 字典里的 `{name}` 占位填充（与卡片侧官方 Translate 同语义，host 侧没有官方 translator
 *  故自带）。用 split/join 而不是 replace：路径与模型回文里可能带 `$`，而字符串版
 *  replace 会把 `$&` / `$1` 当替换模式解释。 */
function fillTemplate(template: string, tokens: readonly (readonly [string, string])[]): string {
  let text = template;
  for (const [token, value] of tokens) {
    text = text.split(token).join(value);
  }
  return text;
}

/** 有界并发的 map：批内并行、批间串行等待，从而把同时在打开的文件数压在 limit 以内。
 *  不用 `Promise.all(items.map(...))` 一次铺开——导入内置库（266 个 .md）会把
 *  进程 fd 打满，EMFILE 抛错被单文件 catch 吞掉 → 条目静默丢失而仍报 ok:true。
 *  分片用**递归**而非 for+await：批间等待是并发上限的实现手段，而 await-in-loop
 *  在本包严格档里是 error（不用 disable 注释换取绿灯）。
 *  worker 自己负责错误降级（不抛），否则一个失败会让整批 reject、把已完成结果全丢掉。 */
async function mapBounded<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const batch = await Promise.all(items.slice(0, limit).map((item) => worker(item)));
  return [...batch, ...(await mapBounded(items.slice(limit), limit, worker))];
}

function isKeyFile(name: string): boolean {
  const lower = name.toLowerCase();
  // 敏感面排除优先：命中凭据/密钥模式的文件永不取摘要
  for (const marker of SECRET_MARKERS) {
    if (lower.includes(marker)) {
      return false;
    }
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return KEY_EXT.has(name.slice(dot));
}

/** 关键文件摘要：全量正文（用户拍板不截断——上下文完整性优先，
 *  模型 context 超限由模型报错提示用户自行处理）。仅 trim 去头尾空白。 */
function makeSnippet(content: string): string {
  const trimmed = content.trim();
  return trimmed.length === 0 ? "" : trimmed;
}

/** cwd 提取：sessions.get(id).header.cwd，非字符串视为缺。 */
function cwdOfSession(
  sessions: SessionsService | undefined,
  sessionId: string | null,
): string | undefined {
  // 单 return 满足 consistent-return；sessionId 空时 cwd 保持 undefined。
  let cwd: string | undefined;
  if (sessionId !== null && sessionId.length > 0) {
    const session = sessions?.get(sessionIdOf(sessionId));
    const value = session?.header?.cwd;
    if (typeof value === "string" && value.length > 0) {
      cwd = value;
    }
  }
  return cwd;
}

// ── 目录上下文（收集逻辑，纯函数便于测试）─────────────────────────────────

export interface DirEntry {
  name: string;
  isDir: boolean;
  sizeBytes: number;
  /** 关键文本文件首段摘要；非关键文件/目录为 undefined。 */
  snippet: string | undefined;
}

/** 静默丢数据的记账（审计修复：原先"读失败即 undefined、超限即忽略"完全没有
 *  回执，界面与 host 都显示成功）。dir context 与 import 两端点共用此形状。 */
export interface SkipCounts {
  /** 字节超限、整份跳过的文件数。 */
  tooLarge: number;
  /** 读取失败（含 EMFILE / 权限 / 非 UTF-8）的文件数。 */
  unreadable: number;
  /** 只在更深一层、被扫描深度限制造漏掉的 .md 数（仅导入端点用）。 */
  deeper: number;
  /** 读到了但解析不出角色 name（非角色文件）而被跳过的文件数（仅导入端点用）。 */
  unnamed: number;
}

function skipCounts(): SkipCounts {
  return { tooLarge: 0, unreadable: 0, deeper: 0, unnamed: 0 };
}

export interface CollectResult {
  cwd: string;
  entries: DirEntry[];
  /** 有任一文件被跳过即为 true（不再硬编码 false）。 */
  truncated: boolean;
  skipped: SkipCounts;
  error?: string;
}

/** 单文件摘要读取结果：undefined 表示无摘要，附带计数归属。 */
interface SnippetRead {
  snippet: string | undefined;
  tooLarge: boolean;
  unreadable: boolean;
}

/** 关键文件 → 摘要（字节上限 + 未知大小一律跳过：readWholeText 无上限，
 *  没有 size 就无法在不 OOM 的前提下决定读不读，宁缺不盲读）。 */
async function readSnippetBounded(
  fs: Pick<FsService, "readText">,
  entry: FsDirEntry,
  maxBytes: number,
): Promise<SnippetRead> {
  const { size } = entry;
  if (size === undefined || size > maxBytes) {
    return { snippet: undefined, tooLarge: true, unreadable: false };
  }
  try {
    const content = await fs.readText(entry.target);
    return { snippet: makeSnippet(content), tooLarge: false, unreadable: false };
  } catch {
    /* 单个关键文件读取失败 → 该文件无摘要，但计数必须留下 */
    return { snippet: undefined, tooLarge: false, unreadable: true };
  }
}

/** host 路由实际用的收集函数：fs 服务 → DirEntry[]（含关键文件全文摘要）。
 *  条目数不设上限（用户拍板），但单文件按 MAX_SNIPPET_BYTES 整份跳过、
 *  读取按 READ_CONCURRENCY 有界并发；跳过项计入 skipped 并让 truncated 反映事实。
 *  回执文案取自注入的字典（纯函数不读设置）。 */
export interface DirScanLimits {
  /** 单文件摘要字节上限（超出整份跳过）。 */
  maxSnippetBytes: number;
  /** 有界并发读取度。 */
  readConcurrency: number;
}

/** 缺省部署值（schema .default 的同源常量）；limitsOf()/collect* 的回落单源。 */
const DEFAULT_LIMITS = {
  organizeTimeoutMs: ORGANIZE_TIMEOUT_MS,
  maxSnippetBytes: MAX_SNIPPET_BYTES,
  readConcurrency: READ_CONCURRENCY,
  importBodyMaxBytes: DEFAULT_IMPORT_BODY_MAX_BYTES,
};

export async function collectDirContext(
  fs: Pick<FsService, "resolve" | "listDir" | "readText">,
  cwd: string | undefined,
  messages: HostMessages,
  limits?: DirScanLimits,
): Promise<CollectResult> {
  const scan = limits ?? { maxSnippetBytes: MAX_SNIPPET_BYTES, readConcurrency: READ_CONCURRENCY };
  if (cwd === undefined || cwd.length === 0) {
    return {
      cwd: "",
      entries: [],
      truncated: false,
      skipped: skipCounts(),
      error: messages.cwdEmpty,
    };
  }
  try {
    const dirTarget = await fs.resolve(cwd);
    const raw = await fs.listDir(dirTarget);
    // 关键文件摘要：有界并发预取，失败/超限静默降级 undefined（并计数）。
    const keyFiles = raw.filter((item) => item.type === "file" && isKeyFile(item.name));
    const skipped = skipCounts();
    const reads = await mapBounded(keyFiles, scan.readConcurrency, async (item) => ({
      targetKey: item.target.targetKey,
      ...(await readSnippetBounded(fs, item, scan.maxSnippetBytes)),
    }));
    const snippetByTarget = new Map<string, string | undefined>();
    for (const read of reads) {
      if (read.tooLarge) {
        skipped.tooLarge += 1;
      } else if (read.unreadable) {
        skipped.unreadable += 1;
      }
      snippetByTarget.set(read.targetKey, read.snippet);
    }
    const entries: DirEntry[] = raw.map((item) => ({
      name: item.name,
      isDir: item.type === "directory",
      sizeBytes: item.size ?? 0,
      snippet: item.type === "directory" ? undefined : snippetByTarget.get(item.target.targetKey),
    }));
    return {
      cwd,
      entries,
      truncated: skipped.tooLarge + skipped.unreadable > 0,
      skipped,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      cwd,
      entries: [],
      truncated: false,
      skipped: skipCounts(),
      error: fillTemplate(messages.readDirFailed, [["{reason}", msg]]),
    };
  }
}

// ── 角色导入（从 agency-agents-zh 式角色 .md 导入为模板条目）─────────

export interface ImportResult {
  entries: TemplateEntry[];
  truncated: boolean;
  skipped: SkipCounts;
  error?: string;
}

/**
 * 导入路径安全策略（只读端点，无副作用：不调 LLM、不写盘，返回给同源页面）。
 * 规则名：「cwd 内 + 内置角色目录 allowlist」。
 *
 * 允许根只有三类（除此之外**一律拒绝**，含所有绝对路径）：
 * - 会话 cwd（本次请求能解析出 sessionId 且会话有 cwd 时）；
 * - 插件内置角色库 AGENTS_DIR（本包 agents/，即「路径留空导入全部」的那个目录）；
 * - 用户在设置 `importAllowRoots` 里逐条登记的目录。
 *
 * 拒绝规则（确定性，测试锁死）：
 * - 空串/纯空白不是路径 → 拒（路由把「精确空串」当作"导入内置库"的哨兵并在调用前
 *   拦掉，走到这里说明调用方没做归一，绝不静默降级成"全量导入"）；
 * - **先查原始串的段**再查解析结果：path.resolve 会把 `..` 归一掉，只查解析后的
 *   绝对路径等于放行 `../../etc/passwd.md`（审计复现）；原始串只判 `.` / `..`，
 *   隐藏段留到「命中根之后」再判（内置库就装在 ~/.dsh 下，隐藏段是安装位置）；
 * - 相对路径仅在会话 cwd 可用时以 cwd 为基准解析，否则报错（设置卡无 session →
 *   提示改用绝对路径）；
 * - 解析结果必须落在某个允许根**之内**：逐段比较（`/home/dev/project-two/x.md`
 *   不得被 `/home/dev/project` 的字符串前缀放行），越界即拒并回显解析后的绝对路径；
 * - 命中根后，「根以内的剩余部分」仍逐段校验：`.` / `..` / 以 `.` 开头的隐藏段一律
 *   拒绝（cwd 里的 `.ssh/` 不因"在 cwd 之内"就可读）。根前缀本身不参与该判断，
 *   因此装在 ~/.dsh 下的项目也能导入自己 cwd 内的角色（旧版把这类 cwd 整体拦死）。
 * - 请求路径以 `.md` 结尾 → 单文件导入；否则按目录导入（顶层 *.md + 一层子目录
 *   *.md，跳过隐藏项），目录扫描不递归更深层，但漏掉的必须计数回报。
 *
 * 门禁后仍要求每个文件能解析出非空 frontmatter name（parseAgentFrontmatter），
 * 否则跳过并计数——绝不返回任意文件原文，只产出模板条目形状。
 */
/** 逐段校验：段为 "." / ".." 一律拒（归一前必须先拦，否则 path.resolve 吃掉 `..`）；
 *  checkHidden=true 时额外拒隐藏段（凭据/敏感目录，如 `.ssh`）。 */
function pathTokensError(
  absolute: string,
  checkHidden: boolean,
  messages: HostMessages,
): string | undefined {
  // 单 return 满足 consistent-return；命中非法段只记错误并 break。
  let errorMessage: string | undefined;
  for (const token of absolute.split("/")) {
    if (
      token.length > 0 &&
      (token === "." || token === ".." || (checkHidden && token.startsWith(".")))
    ) {
      errorMessage = messages.illegalPathSegment;
      break;
    }
  }
  return errorMessage;
}

/** 路径拆段（**逐段**比较而非字符串前缀：`/home/dev/project-two/x.md` 会骗过
 *  `startsWith("/home/dev/project")`，前缀式包含判断等于放行兄弟目录）。 */
function pathSegments(absolute: string): string[] {
  return absolute.split("/").filter((token) => token.length > 0);
}

/** child 段序列是否落在 root 之内（含"child 就是 root 本身"= 导入根目录）。 */
function withinRoot(child: readonly string[], root: readonly string[]): boolean {
  return child.length >= root.length && root.every((token, index) => child[index] === token);
}

/** 一个允许根：解析后的绝对路径 + 段序列（比较用）+ 人话标签（越界回执用）。 */
interface ImportRoot {
  readonly absolute: string;
  readonly segments: readonly string[];
  readonly label: string;
}

function toImportRoot(rawPath: string, label: string): ImportRoot {
  const absolute = path.resolve(rawPath);
  return { absolute, segments: pathSegments(absolute), label };
}

/** 本次请求的允许根集合：会话 cwd（有则算）+ 内置角色库 + 设置登记的允许目录。
 *  标签取自字典（越界回执会回显它们）。 */
function importRootsOf(
  cwd: string | undefined,
  allowRoots: readonly string[],
  messages: HostMessages,
): ImportRoot[] {
  const roots: ImportRoot[] = [];
  if (cwd !== undefined) {
    roots.push(toImportRoot(cwd, messages.rootLabelCwd));
  }
  roots.push(toImportRoot(AGENTS_DIR, messages.rootLabelBuiltin));
  for (const root of allowRoots) {
    roots.push(toImportRoot(root, messages.rootLabelAllowed));
  }
  return roots;
}

/** 越界回执文本：点名每一类允许区并回显解析后的绝对路径——越界不做静默降级，
 *  必须让模型/人一眼看清"规则是什么、这次解析到了哪里"。 */
function outsideRootsError(
  absolute: string,
  roots: readonly ImportRoot[],
  messages: HostMessages,
): string {
  const zones = roots.map((root) => `${root.label} ${root.absolute}`);
  return fillTemplate(messages.outsideRoots, [
    ["{zones}", zones.join(messages.zoneSeparator)],
    ["{absolute}", absolute],
  ]);
}

export function importPathError(
  requested: string,
  cwd: string | undefined,
  allowRoots: readonly string[],
  messages: HostMessages,
): string | undefined {
  const trimmed = requested.trim();
  // ① 空串/纯空白不是路径（留空的语义由路由按"导入内置库"处理，不经本函数）
  if (trimmed.length === 0) {
    return messages.emptyImportPath;
  }
  // ② 先查**原始串**的段：path.resolve 会把 `..` 归一掉，只查归一结果等于放行
  //    `../../etc/passwd.md`（审计复现）。绝对/相对两路共用这一道。
  const rawError = pathTokensError(trimmed, false, messages);
  if (rawError !== undefined) {
    return rawError;
  }
  // ③ 相对路径以会话 cwd 为基准；缺 cwd 直接拒（不猜进程 cwd 作为降级基准）
  if (!path.isAbsolute(trimmed) && cwd === undefined) {
    return messages.relativeNeedsCwd;
  }
  const absolute = path.resolve(cwd ?? "", trimmed);
  const roots = importRootsOf(cwd, allowRoots, messages);
  const child = pathSegments(absolute);
  const matched = roots.find((root) => withinRoot(child, root.segments));
  if (matched === undefined) {
    return outsideRootsError(absolute, roots, messages);
  }
  // ④ 归一后再判一次（命中根以内的剩余段，含隐藏段）：`..` 与 `.ssh` 这类段
  //    两侧都拦得住，win32 跨盘符/反斜杠形状同样落在这里而不是靠系统兜底。
  return pathTokensError(path.relative(matched.absolute, absolute), true, messages);
}

/** 角色文件 → 模板条目（正文提炼 + 目录分组标签 + 确定性 id 去重）。
 *  正文提炼不设字符上限。 */
function agentEntryFromFile(
  slug: string,
  dirName: string,
  info: AgentFileInfo,
  collided: Set<string>,
): TemplateEntry | undefined {
  // 单 return 满足 consistent-return；正文为空则 result 保持 undefined。
  const text = condenseRoleBody(info.body);
  let result: TemplateEntry | undefined;
  if (text.length > 0) {
    let id = slug;
    while (collided.has(id)) {
      id = `${slug}-${String(collided.size + 1)}`;
    }
    collided.add(id);
    result = {
      id,
      name: info.name,
      description: info.description,
      text,
      group: groupLabelOf(dirName),
      emoji: info.emoji,
    };
  }
  return result;
}

/** 导入候选文件（文件名 + 所属目录名 + fs target + 字节大小，未知为 undefined）。 */
interface ImportCandidate {
  name: string;
  dirName: string;
  target: FsTarget;
  size: number | undefined;
}

/** 单个候选 → 解析结果（失败原因用判别字段回传，不再 null 一把抓）。 */
type CandidateRead =
  | { readonly kind: "ok"; readonly file: ImportCandidate; readonly info: AgentFileInfo }
  | { readonly kind: "too-large" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unnamed" };

/** 目录项是「可见子目录」？（顶层与子层两处同一判据：隐藏项不进扫描面）。 */
function isVisibleDirectory(child: FsDirEntry): boolean {
  return child.type === "directory" && !child.name.startsWith(".");
}

/** 目录项是「可见 .md 文件」？（候选收集与第三层清点同一判据，两处必须数到同一批）。 */
function isVisibleMdFile(child: FsDirEntry): boolean {
  return child.type === "file" && child.name.endsWith(".md") && !child.name.startsWith(".");
}

/** 一层目录内容 → 顶层 .md 候选（跳过隐藏项，按名排序保确定性）。 */
function mdCandidates(children: FsDirEntry[], dirName: string): ImportCandidate[] {
  return children
    .filter((child) => isVisibleMdFile(child))
    .map((child) => ({
      name: child.name,
      dirName,
      target: child.target,
      size: child.size,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** 候选 → 解析结果：字节超限整份跳过（单条模板 = 一整个角色正文，超限就放弃该
 *  条目），读失败/无 name 各自归类，供上层计数。 */
async function readCandidate(
  fs: Pick<FsService, "readText">,
  file: ImportCandidate,
  maxBytes: number,
): Promise<CandidateRead> {
  if (file.size === undefined || file.size > maxBytes) {
    return { kind: "too-large" };
  }
  try {
    const info = parseAgentFrontmatter(await fs.readText(file.target));
    return info === undefined ? { kind: "unnamed" } : { kind: "ok", file, info };
  } catch {
    return { kind: "unreadable" };
  }
}

/** 导入策略前置闸：skipPolicy=true（内置角色库自检路径）跳过判定；其余按
 *  importPathError 判越界/坏输入。独立成函数既收敛复杂度，也让"自检跳过策略"
 *  这条特殊语义有自己的名字与测试锚点。 */
function importGate(
  requested: string,
  cwd: string | undefined,
  allowRoots: readonly string[],
  messages: HostMessages,
  skip: boolean,
): string | undefined {
  return skip ? undefined : importPathError(requested, cwd, allowRoots, messages);
}

/** 单文件导入（路径直指一个角色 .md）：解析不出 name → 记 unnamed 并回原因；
 *  读到了但正文提炼为空 → 空条目列表（agentEntryFromFile 返回 undefined 的形状）。 */
async function importFromFile(
  fs: Pick<FsService, "readText">,
  absolute: string,
  target: FsTarget,
  skipped: SkipCounts,
  messages: HostMessages,
): Promise<ImportResult> {
  const info = parseAgentFrontmatter(await fs.readText(target));
  if (info === undefined) {
    skipped.unnamed = 1;
    return { entries: [], truncated: false, skipped, error: messages.missingRoleName };
  }
  const entry = agentEntryFromFile(
    path.basename(absolute, ".md"),
    path.basename(path.dirname(absolute)),
    info,
    new Set(),
  );
  return { entries: entry === undefined ? [] : [entry], truncated: false, skipped };
}

/** 更深层（第三层）目录：只清点可见 .md 数、不读正文——扫描深度是设计上限，
 *  但静默省略是 bug（内置库 game-development/<engine>/*.md 曾整批消失）。 */
async function countDeeperMdFiles(
  fs: Pick<FsService, "listDir">,
  deepDirs: readonly FsTarget[],
  readConcurrency: number,
): Promise<number> {
  const counts = await mapBounded(deepDirs, readConcurrency, async (dir) => {
    const children = await fs.listDir(dir);
    return children.filter((child) => isVisibleMdFile(child)).length;
  });
  let total = 0;
  for (const count of counts) {
    total += count;
  }
  return total;
}

/** 一条读取结果 → 条目或计数：坏读归入 `skipped`，好读装配进 `entries`
 *  （id 碰撞由 `collided` 记账，确定性改写）。 */
function pushReadResult(
  read: CandidateRead,
  entries: TemplateEntry[],
  collided: Set<string>,
  skipped: SkipCounts,
): void {
  if (read.kind === "too-large") {
    skipped.tooLarge += 1;
    return;
  }
  if (read.kind === "unreadable") {
    skipped.unreadable += 1;
    return;
  }
  if (read.kind === "unnamed") {
    skipped.unnamed += 1;
    return;
  }
  const entry = agentEntryFromFile(
    path.basename(read.file.name, ".md"),
    read.file.dirName,
    read.info,
    collided,
  );
  if (entry === undefined) {
    skipped.unnamed += 1;
    return;
  }
  entries.push(entry);
}

/** 目录路径扫描（顶层 + 一层子目录的 .md，第三层只清点）→ 条目列表。
 *  跳过计数**就地累加进调用方持有的 `skipped`**（而不是返回一份新表）：中途抛错时
 *  上层 catch 仍要报出已经数到的那部分。 */
async function importFromDirectory(
  fs: Pick<FsService, "listDir" | "readText">,
  absolute: string,
  target: FsTarget,
  limits: DirScanLimits,
  skipped: SkipCounts,
): Promise<TemplateEntry[]> {
  const rootChildren = await fs.listDir(target);
  const rootFiles = mdCandidates(rootChildren, path.basename(absolute));
  const subDirs = rootChildren
    .filter((child) => isVisibleDirectory(child))
    .map((child) => child.target)
    .toSorted((left, right) => left.displayPath.localeCompare(right.displayPath));
  // 子目录 listDir 有界并发（避免 await-in-loop，也避免 266 个并发打开打满 fd）：
  // 一次遍历同时产出「该层 .md 候选」与「更深一层的目录」（后者只清点不读）。
  const subScans = await mapBounded(subDirs, limits.readConcurrency, async (sub) => {
    const children = await fs.listDir(sub);
    return {
      files: mdCandidates(children, path.basename(sub.displayPath)),
      deeper: children.filter((child) => isVisibleDirectory(child)).map((child) => child.target),
    };
  });
  const subFiles: ImportCandidate[] = [];
  const deepDirs: FsTarget[] = [];
  for (const scan of subScans) {
    subFiles.push(...scan.files);
    deepDirs.push(...scan.deeper);
  }
  const deeperMdCount = await countDeeperMdFiles(fs, deepDirs, limits.readConcurrency);
  skipped.deeper += deeperMdCount;
  const candidates: ImportCandidate[] = [...rootFiles, ...subFiles];
  const reads = await mapBounded(candidates, limits.readConcurrency, (file) =>
    readCandidate(fs, file, limits.maxSnippetBytes),
  );
  // 不设条目上限：能解析出的候选全部装配
  const entries: TemplateEntry[] = [];
  const collided = new Set<string>();
  for (const read of reads) {
    pushReadResult(read, entries, collided, skipped);
  }
  return entries;
}

/** 收集导入模板条目（纯逻辑，注入假 fs 可测；单文件/目录两路）。
 *  目录路径扫描两层（顶层 *.md + 一层子目录 *.md），排序固定保证确定性；
 *  第三层不扫描但**清点**（deeper 计数），读失败/超限/非角色同样计数回报，
 *  truncated 反映"确实有东西没进来"，不再硬编码 false。
 *  skipPolicy 用于内置角色库自检（AGENTS_DIR 是策略里的允许根，用户输入路径正常
 *  不需要它；保留这个开关只为让"内置全量导入"不依赖安装位置是否命中隐藏段判断）。
 *  allowRoots = 设置 importAllowRoots 登记的额外允许目录（由路由注入）。 */
export async function collectAgentTemplates(
  fs: Pick<FsService, "resolve" | "listDir" | "readText">,
  requested: string,
  cwd: string | undefined,
  messages: HostMessages,
  opts?: {
    skipPolicy?: boolean;
    allowRoots?: readonly string[];
    limits?: DirScanLimits;
  },
): Promise<ImportResult> {
  const limits: DirScanLimits = opts?.limits ?? DEFAULT_LIMITS;
  const policyError = importGate(
    requested,
    cwd,
    opts?.allowRoots ?? [],
    messages,
    opts?.skipPolicy === true,
  );
  if (policyError !== undefined) {
    return { entries: [], truncated: false, skipped: skipCounts(), error: policyError };
  }
  // 与 importPathError **同一套解析**（策略判定的形状 = 实际读取的形状）：相对路径
  // 在上面已保证 cwd 存在，绝对路径 path.resolve 只做归一，不做第二份语义。
  const absolute = path.resolve(cwd ?? "", requested);
  const skipped = skipCounts();
  try {
    const target = await fs.resolve(absolute);
    if (absolute.endsWith(".md")) {
      const single = await importFromFile(fs, absolute, target, skipped, messages);
      return single;
    }
    const entries = await importFromDirectory(fs, absolute, target, limits, skipped);
    return {
      entries,
      truncated: skipped.tooLarge + skipped.unreadable + skipped.deeper > 0,
      skipped,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      entries: [],
      truncated: false,
      skipped,
      error: fillTemplate(messages.importFailed, [["{reason}", msg]]),
    };
  }
}

// ── organize（LLM 整理，纯函数便于测试）──────────────────────────────────

export interface OrganizeInput {
  prompt: string;
  cwd: string;
  entriesSummary?: string;
  /** 会话最近对话文本（user/assistant 交替，host 侧从 deriveMessages 提取）。 */
  recentTurns?: string;
  /** 参考角色上下文（提炼自模板正文；可选）。提供时整理以其角色视角重写需求。 */
  roleText?: string;
  model?: ModelSelection;
}

/** 构造 system 提示（导出供测试）。规则正文与各段标题全部取自注入的字典——
 *  面向模型的 prompt 也随官方 locale 偏好切语言，zh 输出与迁移前逐字一致。 */
export function buildOrganizeSystem(
  input: Omit<OrganizeInput, "prompt">,
  messages: HostMessages,
): string {
  return [
    messages.sysRole,
    messages.sysRulesHeading,
    messages.sysRuleOutputOnly,
    messages.sysRuleNoExecution,
    messages.sysRuleNoAnswer,
    messages.sysRuleKeepIntent,
    messages.sysRuleResolveRefs,
    messages.sysRuleNoListing,
    messages.sysRuleRoleView,
    fillTemplate(messages.sysCwdLine, [["{cwd}", input.cwd || messages.sysCwdMissing]]),
    input.entriesSummary !== undefined && input.entriesSummary !== ""
      ? fillTemplate(messages.sysSummaryLine, [["{summary}", input.entriesSummary]])
      : "",
    input.recentTurns !== undefined && input.recentTurns !== ""
      ? fillTemplate(messages.sysRecentTurnsLine, [["{turns}", input.recentTurns]])
      : "",
    input.roleText !== undefined && input.roleText !== ""
      ? fillTemplate(messages.sysRoleLine, [["{roleText}", input.roleText]])
      : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/** 文本块守卫（content 数组里 type==='text' 且 text 是 string 的块；替代 as 断言）。 */
function isTextBlock(block: unknown): block is { type: string; text: string } {
  if (!isRecord(block)) {
    return false;
  }
  const { type, text } = block;
  return type === "text" && typeof text === "string";
}

/** 行首角色 → 该角色"出自真人/模型"的 source.kind（注入过滤的判据表：
 *  user 只认 kind==='user'，assistant 只认 kind==='model'；表里没有的形状一律是注入）。 */
const REAL_TURN_SOURCE_KIND: Readonly<Record<"user" | "assistant", string>> = {
  user: "user",
  assistant: "model",
};

/** 一条消息 → 一行 `role: 文本`；框架注入、非真人/非模型角色、无文本内容 → undefined
 *  （调用方跳过）。每条消息只取 text block（tool-call/reasoning/image 块跳过）。 */
function recentTurnLine(msg: DerivedMessageView): string | undefined {
  const role = msg.role === "user" || msg.role === "assistant" ? msg.role : null;
  // 单 return 满足 consistent-return（见 parseAgentFrontmatter）：不匹配则不赋值。
  let result: string | undefined;
  if (role !== null && msg.source?.kind === REAL_TURN_SOURCE_KIND[role]) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((block): block is { type: string; text: string } => isTextBlock(block))
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length > 0) {
      result = `${role}: ${text}`;
    }
  }
  return result;
}

/**
 * 会话最近真人对话提取（deriveMessages → "user:/assistant:" 文本串）。
 * 不设条数/字符上限（用户拍板不截断：上下文完整性优先，模型
 * context 超限由模型报错提示用户自行处理）。
 *
 * 注入过滤（隐藏 bug 复查 实测确认：真实会话 log 里 user 角色
 * 混有大量框架注入——agent-instructions / skill-catalog / 插件自己的
 * `plugin:<条目 id>`（本体系即 plugin:auto-recall / -step / -subagent），
 * 这些都不带 source.kind==='user'，内容也不该进指代解析）：
 * - role==='user' 且 source.kind==='user' → 真人输入，保留
 * - role==='assistant' 且 source.kind==='model' → 模型回复，保留
 * - 其余（注入类 user 消息 / tool-result 消息 / 空消息）全部跳过——
 *   注入内容会污染指代解析、把记忆库全文带给 LLM。
 * - 每条消息只取 text block（tool-call/reasoning/image 块跳过）。 */
export function extractRecentTurns(messages: readonly DerivedMessageView[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const line = recentTurnLine(msg);
    if (line !== undefined) {
      lines.push(line);
    }
  }
  return lines.join("\n");
}

/** 流式聚合 text-delta 为完整文本；终态非 stop 视为失败（失败文本取自注入字典）。 */
export async function drainStreamToText(
  stream: AsyncIterable<StreamChunk>,
  messages: HostMessages,
): Promise<string> {
  let text = "";
  let finish: FinishReason | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "text-delta" && typeof chunk.text === "string") {
      text += chunk.text;
    } else if (chunk.type === "finish") {
      finish = chunk.reason;
    }
  }
  if (finish === undefined) {
    throw new Error(messages.missingFinishChunk);
  }
  if (finish.kind !== "stop") {
    // 官方 FinishReasonMap 只在 aborted/error 两个变体上带 failure（必选），
    // 按变体收窄读取；其余 kind 无失败详情，直接用 kind 作文案。
    const failureMessage =
      finish.kind === "aborted" || finish.kind === "error" ? finish.failure.message : undefined;
    // 官方 `FinishReason` 把判别位 `kind` 声明成**必选**（FinishReasonMap 每个变体都带），
    // 但 chunk 是外部流数据：坏形状 `{ type: "finish", reason: {} }` 实测能一路走到这里
    // （test/host.test.ts 的 badChunk 用例锁住 /unknown/ 回落）⇒ 本地把该位投影成可选，
    // 守卫保留；不改官方类型面，也不因"类型说非空"就删掉运行时兜底。
    const kind = (finish as { kind?: string }).kind ?? "unknown";
    const reason =
      failureMessage !== undefined && failureMessage !== ""
        ? fillTemplate(messages.failureReason, [
            ["{kind}", kind],
            ["{message}", failureMessage],
          ])
        : kind;
    throw new Error(fillTemplate(messages.streamNotFinished, [["{reason}", reason]]));
  }
  return text.trim();
}

/** 整理入口（host 路由调用；导出供测试注入假 stream）。失败文案与 system 提示都来自
 *  注入的字典，本函数不读设置。 */
export async function runOrganize(
  llm: LlmService,
  input: OrganizeInput,
  messages: HostMessages,
  timeoutMs: number = ORGANIZE_TIMEOUT_MS,
): Promise<{ content: string }> {
  const { prompt } = input;
  // prompt 在 OrganizeInput 里是必选 string（organize 路由已用 `typeof === "string"` 收敛成
  // 字符串再传入），故无需可选链；空判用显式比较而非真值折叠。
  if (prompt.trim() === "") {
    throw new Error(messages.emptyPrompt);
  }
  const { model } = input;
  // model 可选（未选模型/读不到服务 → undefined）：三个分支都写成显式比较。
  if (model === undefined || model.provider === "" || model.model === "") {
    throw new Error(messages.noModelSelected);
  }
  // request-only 输入：不带 id / source（见文件上方那条注释的三条证据）。曾经的
  // `id: dir-prep-organize-<timestamp>` 是自造身份，宿主侧无人读回。
  const llmMessages: RequestUserInput[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      messages: llmMessages,
      // roleText 必须进 system：漏传时「以角色视角整理」退化成直接整理，
      // 而界面仍报成功（审计复现：system.includes("纵深防御") === false）。
      system: buildOrganizeSystem(
        {
          cwd: input.cwd,
          ...(input.entriesSummary === undefined ? {} : { entriesSummary: input.entriesSummary }),
          ...(input.recentTurns === undefined ? {} : { recentTurns: input.recentTurns }),
          ...(input.roleText === undefined ? {} : { roleText: input.roleText }),
        },
        messages,
      ),
      signal: controller.signal,
    });
    const content = await drainStreamToText(stream, messages);
    if (content.length === 0) {
      throw new Error(messages.emptyOrganizeResult);
    }
    return { content };
  } finally {
    clearTimeout(timer);
  }
}

// ── 模板 settings（0.1.7：隐式注册 + volatile 字段）─────────────────────────

/** 单条模板的 settings schema 形状（与 src/templates.ts 的 TemplateEntry 对齐：
 *  description/group/emoji 收敛为空串默认，旧存量条目（无新字段）写入时也能过校验）。 */
const TemplateEntrySchema = Schema.object({
  id: Schema.string(),
  name: Schema.string(),
  description: Schema.string().default(""),
  text: Schema.string(),
  group: Schema.string().default(""),
  emoji: Schema.string().default(""),
});

/** settings 命名空间与 loader 行 config 共用同一 schema（单源，防漂移）。
 *  值名退避为 configSchema：避免与同名 interface Config 触发 no-redeclare；
 *  外部仍以 `Config` 名导入（export as），公开 API 不变。
 *  写入校验由 dsh-settings 在持久化前按此 schema 完成；两个字段都必须 `.volatile()`
 *  ——没有任何 volatile 字段的条目会被宿主 describe() 整条跳过
 *  （packages/settings/settings/src/index.ts:308-309），设置卡读不到、写入则抛
 *  `has no volatile fields`（:386）。
 *
 *  旧 `settings.register(ns, Config, { base })` 的 base 底座取消，逐字段落到 `.default(...)`：
 *  - importAllowRoots：`.default([])`。**空表是策略不是缺省占位**——登记目录是用户的
 *    显式信任动作，除会话 cwd 与内置角色库外默认不放行任何绝对路径（fail-closed，
 *    见 importPathError）；
 *  - templates：**标 volatile、不给默认**。内置精选集（scripts/gen-defaults.mjs 从
 *    agents/ 角色库生成的 src/default-templates.generated.ts，~640 KB）由 **host 半**
 *    持有、经 default-templates 端点按需下发，client 拉到后作回落：⚠ 不给默认**不等于**读回 undefined——schemastery 对 array 字段把缺失
 *    值 cast 成 `[]`（实测 `configSchema["~standard"].validate({})` 之后 `templates` 引用
 *    `.get() === []`），宿主 describe() 又只丢 undefined 位（index.ts:141-147 projectForm），
 *    所以「未设置」递到客户端看到的就是一张空表。回落判据因此落在 client 半
 *    （client-entry.ts 的 `fromSettings`：空表按未设置处理），设置卡「恢复默认」=
 *    `unset("templates")` 且复读空值按已回落处理，故「缺失」「空表」「内置」三者同义。
 *    写成 `.default(...)` 会让宿主每次 describe() 都重新序列化这 640 KB（index.ts:313 对
 *    `JSON.stringify([uid, schema.toJSON(), entry.options.config])` 取指纹，schema.ts:24
 *    的 plainSchema 保留 meta.default），所以内置集不进 schema、由 host 半端点按需下发；而既然空表就是
 *    「未设置」的运行时形状，回落判据仍由 client 半出。 */
const configSchema = Schema.object({
  templates: Schema.array(TemplateEntrySchema).volatile(),
  importAllowRoots: Schema.array(Schema.string()).default([]).volatile(),
  // ── Config 化（默认与原模块常量同值；config.md:78-92：部署间可能想配不同值的
  // 必须是配置字段）。organizeTimeoutMs **volatile 上卡**：客户端 fetch 超时要与它
  // 保持同源（host 先超时、客户端留 5s 余量），而 client 半唯一能读到的就是
  // configForms 快照的 volatile 位；另两位是 host 侧部署假定值（非 volatile，不占卡）。
  organizeTimeoutMs: Schema.natural().default(ORGANIZE_TIMEOUT_MS).volatile(),
  maxSnippetBytes: Schema.natural().default(MAX_SNIPPET_BYTES),
  readConcurrency: Schema.natural().default(READ_CONCURRENCY),
  importBodyMaxBytes: Schema.natural().default(DEFAULT_IMPORT_BODY_MAX_BYTES),
});

/** cordis 校验过 configSchema 后交进 apply 的那份配置：volatile 字段以 Volatile 引用
 *  形态进来，读当前值一律 `.get()`（改设置不必重挂载插件）。
 *  ⚠ templates 的形参写 `| undefined` 只是留口：实测**未设置时 `.get()` 给的是 `[]`**
 *  （schemastery 对 array 的 cast，见上方 configSchema 注释），而 host 半从不读这一位
 *  （它只把 schema 交给设置卡），回落由 client 半判。 */
export interface Config {
  templates: Volatile<TemplateEntry[] | undefined>;
  importAllowRoots: Volatile<string[]>;
  /** LLM 整理中止时限（volatile：客户端经 configForms 快照同源读取）。 */
  organizeTimeoutMs: Volatile<number>;
  /** 关键文件摘要的单文件字节上限（超出整份跳过）。 */
  maxSnippetBytes: number;
  /** 目录扫描/读取的有界并发度。 */
  readConcurrency: number;
  /** organize/import POST body 的物理字节上限（内存防爆纵深防御）。 */
  importBodyMaxBytes: number;
}

export { configSchema as Config };

/** volatile 引用读出的值 → importAllowRoots 字符串列表（纯函数，测试锁死）。
 *  引用背后可能是存量脏配置：非数组一律空表（fail-closed），非字符串/纯空白项逐个
 *  丢弃——绝不能把非字符串塞进路径校验，也不能让空串变成"允许 process.cwd()"。 */
export function importAllowRootsOf(raw: unknown): string[] {
  const roots: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim().length > 0) {
        roots.push(item.trim());
      }
    }
  }
  return roots;
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

/** 注入的服务面：webServer + settings 为硬依赖（cordis 等两者就绪才 apply）。
 *  0.1.7 起命名空间是隐式的（= 本条目在 cordis.patch.yml 里的裸 id，可编辑字段取自
 *  导出的 Config），所以 settings 不再是「注册的前提」而是「页面策略（configure）与
 *  跨命名空间读（describe）」的载体；设置页只派发「host 已 serve 的命名空间 ∩
 *  settings.plugin.item 卡」（dsh-client-ui-settings-plugins 源码语义），configure 必须
 *  发生在 apply 期，故仍硬注入。sessions/fs/llm/agentDefaultModel 仍可选读。 */
export const inject = ["settings"];

/** 路由处理器的可测提取：apply 用 ctx.get 的惰性 getter 调用（服务可能在
 *  路由注册后才就绪），测试直接注入静态假服务 + 假 req/res 驱动。
 *  csrf 为 per-apply 令牌：context/model GET 下发，organize POST 回填校验。 */
export interface RouteDeps {
  sessions?: () => SessionsService | undefined;
  fs?: () => FsService | undefined;
  llm?: () => LlmService | undefined;
  agentDefaultModel?: () => AgentDefaultModel | undefined;
  /** 设置里登记的额外导入允许根（每次请求现读，改设置无需重启）。 */
  importAllowRoots?: () => readonly string[];
  /** 部署值（Config 化）：整理超时 / 摘要字节上限 / 读取并发。
   *  缺省回落原模块常量（与 schema .default 同值）——测试与旧调用方不必逐一改。 */
  limits?: () => DirScanLimits & { organizeTimeoutMs: number; importBodyMaxBytes: number };
}

/** 路由 handler 形状（本包自己的路由表投影）。官方 `WebRoute["handler"]` 的返回是
 *  `void | Promise<void>`（installed `@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts:38`），
 *  dispatcher 侧写成 `await route.handler(req, res)`（installed lib/index.js:235）——
 *  await 对同步返回同样成立，而外层 `handle` 本身是 async，故同步抛与 reject 在调用方
 *  观察上等价：**没有调用方依赖 handler 返回 promise**。于是投影按实现拆成两枚，
 *  让 createRouteHandlers 的返回值继续自证——确有 await 的三枚是 AsyncRouteHandler，
 *  纯同步的两枚是 SyncRouteHandler，不再为凑类型套假 async。 */
export type SyncRouteHandler = (req: IncomingMessage, res: ServerResponse) => void;
export type AsyncRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** 回执字典的现读 getter：每个请求取一次，用户在「设置 → 常规」改语言后下一个请求即
 *  切文案（不重启、不加插件自己的 locale 设置项；与 importAllowRoots 的现读同构）。 */
export type MessagesOf = () => HostMessages;

/** 405 回执（四个端点同形，抽出来避免重复）。 */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow);
  // 405 也回 JSON 体，与 zvec-grep/ocr-review 既有形态统一（原先"空体 405"是全仓最大的一族，
  // 11 处；没有任何测试断过它的体，所以这一改动不会翻红任何既有断言——体本身由新针钉住）。
  sendJson(res, 405, { ok: false, error: `${allow} only` });
}

/** JSON.parse 失败回执（读 body 与解析分离：超限/坏流由 guardBody 回 413/400，
 *  这里只对"确实读到了但不是 JSON"回 400）。文案取自字典，故由调用方现读后传入。 */
function sendBadRequestJson(res: ServerResponse, error: string): void {
  sendJson(res, 400, { ok: false, error });
}

/** 当前默认模型解析（缺服务/抛错 → undefined）。 */
function resolveModel(deps: RouteDeps): ModelSelection | undefined {
  // 单 return 满足 consistent-return；取不到/抛错则 result 保持 undefined。
  const current = deps.agentDefaultModel?.();
  let result: ModelSelection | undefined;
  if (current !== undefined) {
    try {
      const sel = current.currentSelection();
      result = {
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
      };
    } catch {
      /* 读取模型选择失败 → 按未选模型处理（organize 路由会据此报错） */
    }
  }
  return result;
}

/** 会话最近对话文本提取（deriveMessages 尾部；缺会话/无方法/抛错 → 空串）。 */
function resolveRecentTurns(
  sessions: SessionsService | undefined,
  sessionId: string | null,
): string {
  const session = sessionId === null ? undefined : sessions?.get(sessionIdOf(sessionId));
  if (session === undefined || typeof session.deriveMessages !== "function") {
    return "";
  }
  try {
    return extractRecentTurns(session.deriveMessages());
  } catch {
    return "";
  }
}

/** importAgent 请求体的输入面（纯函数，测试锁死）：坏输入的判别顺序与旧版逐守卫
 *  完全一致——path 非字符串先于"纯空白 path"，两者各带自己的状态码与文案。 */
type ImportRequest =
  | { readonly rejected: true; readonly status: number; readonly error: string }
  | {
      readonly rejected: false;
      /** 留空 = 导入插件内置角色库全部（agents/）的哨兵位。 */
      readonly isBuiltin: boolean;
      readonly requested: string;
      /** 非字符串 = null（无会话上下文，cwd 也就取不到）。 */
      readonly sessionId: string | null;
    };

/** 已解析的请求体 → 导入目标（拒绝时带回执的状态码与文案，由调用方原样发出）。
 *  path 缺失/非字符串 → 直接拒（旧版把它悄悄当成"留空"，于是一个写坏字段的请求会
 *  静默导入整个内置库——越界与坏输入都不许降级成"更多权限"）；只含空白字符的串同样
 *  是坏输入，不给降级空间（**精确空串**才是内置全量那个哨兵）。 */
function importRequestOf(parsed: unknown, messages: HostMessages): ImportRequest {
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const { path: importPathRaw, sessionId } = body;
  if (typeof importPathRaw !== "string") {
    return { rejected: true, status: 400, error: messages.importPathNotString };
  }
  const isBuiltin = importPathRaw.length === 0;
  const requested = importPathRaw.trim();
  if (!isBuiltin && requested.length === 0) {
    return { rejected: true, status: 400, error: messages.importPathBlank };
  }
  return {
    rejected: false,
    isBuiltin,
    requested,
    sessionId: typeof sessionId === "string" ? sessionId : null,
  };
}

/** createRouteHandlers 五个 handler 体的共享面。handler 体按规模判据抽成模块级具名
 *  函数后，原来的自由变量（deps/csrf/现读取表与现读 limits）改为显式传入；每次请求
 *  现读的语义不变（scope 只持有 getter，不缓存值）。 */
interface RouteScope {
  readonly deps: RouteDeps;
  readonly csrf: string;
  readonly messagesOf: MessagesOf;
  readonly limitsOf: () => DirScanLimits & {
    organizeTimeoutMs: number;
    importBodyMaxBytes: number;
  };
}

/** GET context 的正文（信任闸门之后）：缺 fs / 缺 cwd / 扫描报错各回一句，成功才下发条目表。 */
async function sendContextResponse(
  scope: RouteScope,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const messages = scope.messagesOf();
  if (req.method !== "GET") {
    methodNotAllowed(res, "GET");
    return;
  }
  // 自家 isCrossOrigin 支在信任闸门之后不可达：trust 的 sec-fetch-site 白名单更严、错误文本同一句
  // （既有的「跨域 → 403」用例仍然通过，拒它的是闸门）。
  try {
    const fs = scope.deps.fs?.();
    const sessionId = queryParam(req, "sessionId");
    const cwd = cwdOfSession(scope.deps.sessions?.(), sessionId);
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: messages.fsUnavailable });
      return;
    }
    if (cwd === undefined) {
      sendJson(res, 200, { ok: false, error: messages.cwdUnknown });
      return;
    }
    const result = await collectDirContext(fs, cwd, messages, scope.limitsOf());
    if (result.error !== undefined) {
      sendJson(res, 200, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      csrf: scope.csrf,
      cwd: result.cwd,
      truncated: result.truncated,
      skipped: result.skipped,
      entries: result.entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDir,
        sizeBytes: entry.sizeBytes,
        snippet: entry.snippet,
      })),
    });
  } catch (error: unknown) {
    sendJson(res, 200, {
      ok: false,
      error: fillTemplate(messages.collectFailed, [["{reason}", errorText(error)]]),
    });
  }
}

/** GET model 的正文（信任闸门之后）。 */
function sendModelResponse(scope: RouteScope, req: IncomingMessage, res: ServerResponse): void {
  const messages = scope.messagesOf();
  if (req.method !== "GET") {
    methodNotAllowed(res, "GET");
    return;
  }
  // 自家 isCrossOrigin 支在信任闸门之后不可达：trust 的 sec-fetch-site 白名单更严、错误文本同一句
  // （既有的「跨域 → 403」用例仍然通过，拒它的是闸门）。
  const agentDefaultModel = scope.deps.agentDefaultModel?.();
  if (agentDefaultModel === undefined) {
    sendJson(res, 200, { ok: false, error: messages.modelServiceUnavailable });
    return;
  }
  try {
    const sel = agentDefaultModel.currentSelection();
    sendJson(res, 200, {
      ok: true,
      csrf: scope.csrf,
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
    });
  } catch (error: unknown) {
    sendJson(res, 200, {
      ok: false,
      error: fillTemplate(messages.readModelFailed, [["{reason}", errorText(error)]]),
    });
  }
}

/** organize 请求体的输入面：JSON.parse 已成功的 unknown → 整理入参（非字符串一律按空值处理）。 */
function organizeRequestOf(body: Record<string, unknown>): {
  readonly prompt: string;
  readonly entriesSummary: string;
  readonly roleText: string;
  readonly sessionId: string | null;
} {
  const { prompt, sessionId, entriesSummary, roleText } = body;
  return {
    prompt: typeof prompt === "string" ? prompt : "",
    entriesSummary: typeof entriesSummary === "string" ? entriesSummary : "",
    roleText: typeof roleText === "string" ? roleText.trim() : "",
    sessionId: typeof sessionId === "string" ? sessionId : null,
  };
}

/** POST organize 的正文（信任闸门 + 405 + guardBody + JSON.parse 之后）：LLM 调用与两层
 *  错误回执。内层 catch 是「整理过程本身失败」（回裸 errorText），外层是「装配入参时炸」。
 *  `messages` 由 handler 现读后传入：字典取表仍是每请求一次，不在此处二次现读。 */
async function sendOrganizeResponse(
  scope: RouteScope,
  res: ServerResponse,
  messages: HostMessages,
  parsed: unknown,
): Promise<void> {
  try {
    const llm = scope.deps.llm?.();
    if (llm === undefined) {
      sendJson(res, 200, { ok: false, error: messages.llmUnavailable });
      return;
    }
    // JSON.parse 返回 any：经 unknown 后用 isRecord 投影，不经 `as typeof body` 断言。
    const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const {
      prompt,
      entriesSummary,
      roleText: roleTextRaw,
      sessionId: sessionIdText,
    } = organizeRequestOf(body);
    const sessions = scope.deps.sessions?.();
    // 会话最近对话（deriveMessages 尾部，供解析指代；缺会话/无方法 → 空）。
    // 先取对话再判 cwd：否则 sessionId 非字符串的请求根本走不到该函数，
    // 其"无会话"分支永远测不到。
    const recentTurns = resolveRecentTurns(sessions, sessionIdText);
    const cwd = cwdOfSession(sessions, sessionIdText);
    if (cwd === undefined) {
      sendJson(res, 200, { ok: false, error: messages.cwdUnknown });
      return;
    }
    const model = resolveModel(scope.deps);
    try {
      const result = await runOrganize(
        llm,
        {
          prompt,
          cwd,
          entriesSummary,
          recentTurns,
          ...(roleTextRaw.length === 0 ? {} : { roleText: roleTextRaw }),
          ...(model === undefined ? {} : { model }),
        },
        messages,
        scope.limitsOf().organizeTimeoutMs,
      );
      sendJson(res, 200, { ok: true, content: result.content });
    } catch (error: unknown) {
      sendJson(res, 200, { ok: false, error: errorText(error) });
    }
  } catch (error: unknown) {
    sendJson(res, 200, {
      ok: false,
      error: fillTemplate(messages.organizeFailed, [["{reason}", errorText(error)]]),
    });
  }
}

/** POST import 的正文（信任闸门 + 405 + guardBody + JSON.parse 之后）：路径策略拒绝单独回
 *  4xx，导入过程本身失败回 200 + {ok:false}（界面读同一句原因）。
 *  `messages` 同 organize：字典取表留在 handler，一次请求一次。 */
async function sendImportResponse(
  scope: RouteScope,
  res: ServerResponse,
  messages: HostMessages,
  parsed: unknown,
): Promise<void> {
  try {
    const fs = scope.deps.fs?.();
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: messages.fsUnavailable });
      return;
    }
    const request = importRequestOf(parsed, messages);
    if (request.rejected) {
      sendJson(res, request.status, { ok: false, error: request.error });
      return;
    }
    const allowRoots = scope.deps.importAllowRoots?.() ?? [];
    const cwd = cwdOfSession(scope.deps.sessions?.(), request.sessionId);
    // 越界/非法段单独回 4xx（策略拒绝不是"导入过程失败"，让调用方与日志能按
    // 状态码区分；响应体仍是 {ok:false,error}，界面读得到同一句原因）。
    if (!request.isBuiltin) {
      const policyError = importPathError(request.requested, cwd, allowRoots, messages);
      if (policyError !== undefined) {
        sendJson(res, 403, { ok: false, error: policyError });
        return;
      }
    }
    const result = await collectAgentTemplates(
      fs,
      request.isBuiltin ? AGENTS_DIR : request.requested,
      cwd,
      messages,
      {
        skipPolicy: request.isBuiltin,
        allowRoots,
        limits: scope.limitsOf(),
      },
    );
    if (result.error !== undefined) {
      sendJson(res, 200, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      count: result.entries.length,
      truncated: result.truncated,
      skipped: result.skipped,
      entries: result.entries,
    });
  } catch (error: unknown) {
    sendJson(res, 200, {
      ok: false,
      error: fillTemplate(messages.importException, [["{reason}", errorText(error)]]),
    });
  }
}

export function createRouteHandlers(
  deps: RouteDeps,
  csrf: string,
  messagesOf: MessagesOf,
  // 信任闸门的非回环档：缺省 false（只认字面回环）。调用方从 webServer.host 取，
  // 测试侧不传即是保守档——这也是"171 个手搓构造点不必改"的同一条口径。
  servingNonLoopback = false,
): {
  defaults: SyncRouteHandler;
  context: AsyncRouteHandler;
  model: SyncRouteHandler;
  organize: AsyncRouteHandler;
  importAgent: AsyncRouteHandler;
} {
  // 每次请求现读（与 importAllowRoots 同一口径）：cordis 行 config 改了无须重启。
  const limitsOf = (): DirScanLimits & { organizeTimeoutMs: number; importBodyMaxBytes: number } =>
    deps.limits?.() ?? DEFAULT_LIMITS;
  const scope: RouteScope = { deps, csrf, messagesOf, limitsOf };

  return {
    /** 内置精选角色表（DEFAULT_TEMPLATES）的按需读面。表只在 host 侧：
     *  src/default-templates.generated.ts 有 640KB，打包进 client 半等于每次开页都
     *  传输+解析它（本包曾因此 711KB）。client 首次打开「模板」下拉时拉这一发。 */
    defaults(req, res) {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      if (req.method !== "GET") {
        methodNotAllowed(res, "GET");
        return;
      }
      sendJson(res, 200, { ok: true, templates: DEFAULT_TEMPLATES });
    },
    async context(req, res) {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      await sendContextResponse(scope, req, res);
    },
    model(req, res) {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      sendModelResponse(scope, req, res);
    },
    async organize(req, res) {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      const messages = messagesOf();
      if (req.method !== "POST") {
        methodNotAllowed(res, "POST");
        return;
      }
      // 跨域 → CSRF → 读 body（413 超限 / 400 坏流由 guardBody 直接回执）
      const raw = await guardBody(req, res, {
        maxBytes: scope.limitsOf().importBodyMaxBytes,
        csrf: { token: csrf, headerName: CSRF_HEADER },
      });
      if (raw === null) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendBadRequestJson(res, messages.invalidJsonBody);
        return;
      }
      await sendOrganizeResponse(scope, res, messages, parsed);
    },
    async importAgent(req, res) {
      // 信任闸门（shared/lib/trust）：必须是 handler 体的第一条语句。
      if (!guardTrust(req, res, { servingNonLoopback })) {
        return;
      }
      const messages = messagesOf();
      if (req.method !== "POST") {
        methodNotAllowed(res, "POST");
        return;
      }
      // 只读端点（不调 LLM、不写盘、响应不可跨域读取）：同源 + 路径策略即最终防线，
      // 不经 CSRF token——设置卡无会话上下文，无法像 organize 那样先拉 token
      // （设计取舍：导入不产生副作用，跨站伪造无法读回结果，风险面为零）。
      const raw = await guardBody(req, res, { maxBytes: scope.limitsOf().importBodyMaxBytes });
      if (raw === null) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendBadRequestJson(res, messages.invalidJsonBody);
        return;
      }
      await sendImportResponse(scope, res, messages, parsed);
    },
  };
}

/** settings 注册的占位清理（无额外拆卸动作，注册随插件生命周期存续）。 */
function noopDisposer(): void {
  /* 占位：无需清理 */
}

/** host apply：登记设置页策略 + 四个 webServer 路由（全在 effect 内，卸载即注销）。
 *  0.1.7 起模板设置是**隐式注册**的（导出的 Config + 字段上的 .volatile()），本函数
 *  不再向 settings 注册任何东西；配置值由 cordis 校验并填过默认后按 volatile 引用交进来
 *  （第二参数 config），读当前值一律 `.get()`。 */
export function apply(ctx: Context, config: Config): void {
  // ctx.get 经守卫取服务（替代 `ctx as unknown as { get }`：把 getter 抽成独立
  // 函数，避免 Context 交集让 `.get` 回落 any → no-unsafe-assignment）。
  const getService = (name: string): unknown => {
    // 单 return 满足 consistent-return；守卫不通过时 result 保持 undefined。
    let result: unknown;
    if (isServiceGetter(ctx)) {
      result = ctx.get(name);
    }
    return result;
  };
  // host 文案的语言：每次取表时现读官方 locale 命名空间（用户在「设置 → 常规」改语言后，
  // 下一个请求即切文案；不重启、也不加本插件自己的 locale 设置项）。0.1.7 里跨命名空间
  // 读只剩 describe() 一条路：全部条目的表单投影里挑 ns === 'locale' 那条的 value。
  // 没装官方 locale 插件（该条目未被投影）或 settings 形状不符 → 取到 undefined →
  // resolveLocalePreference 落中文默认，不抛。
  // describe() 也是迁移后**唯一还会抛**的宿主调用面（旧的 settings.register 已消失），
  // 而它落在每个请求的取表路径上：不兜住就是把一句没来由的 500 甩回界面，与文件头
  // "插件不炸"的承诺相反 → 大声 error 后回落中文默认（ctx-observe 对同一调用同口径）。
  const localeMessages = (): HostMessages => {
    const rawSettings = getService("settings");
    // 单 return 满足 consistent-return；describe 抛错/缺服务时 described 保持 undefined。
    let described: unknown;
    try {
      described = isSettingsService(rawSettings)
        ? rawSettings.describe().find((row) => row.ns === LOCALE_SETTINGS_NAMESPACE)?.value
        : undefined;
    } catch (error: unknown) {
      console.error(
        `[dir-prep-organize] settings.describe() 失败，本轮文案回落中文默认：${errorText(error)}`,
        error,
      );
    }
    return messagesFor(HOST_MESSAGES, resolveLocalePreference(described));
  };
  // 页面策略：本包自带设置卡，别让宿主再生成一份自动表单页。ctx.inject(['settings'])
  // 保证回调只在 settings 就绪时运行、且随该服务重新装配重跑（configure 对同一 fiber
  // 重复登记会抛），效应挂在注入子上下文的 effect 上以便随之回收；owner 必须显式带
  // **本插件** fiber（缺省是 settings 服务自己的 fiber，传错就等于给别人的页面定策略）。
  // 服务仍经 getService + 形状守卫取（与 localeMessages 同一判据，src 侧不开断言）。
  ctx.inject(["settings"], (child) => {
    child.effect(() => {
      const rawSettings = getService("settings");
      const settings = isSettingsService(rawSettings) ? rawSettings : undefined;
      if (settings === undefined) {
        console.warn(
          "[dir-prep-organize] settings 服务不可用：设置卡页面策略未登记（宿主会按 Config 自动生成表单页）",
        );
        return noopDisposer;
      }
      return settings.configure({ auto: false }, ctx.fiber);
    }, "dir-prep-organize: settings presentation");
  });
  // webServer 走子 fiber（inject 依赖），不写进插件级 inject：没有 webServer 的宿主
  // （TUI、纯 SDK 嵌入）不该让整包失活——模板整理、目录整理、沉淀这些能力只需要
  // settings 与 fs。依赖换实例时 cordis 先卸后装，disposer 随子 fiber 回收。
  ctx.inject(["webServer"], (child) => {
    child.effect(() => {
      const rawWebServer = getService("webServer");
      const webServer = isWebServerService(rawWebServer) ? rawWebServer : undefined;
      if (webServer === undefined) {
        return noopDisposer;
      }
      // per-apply 写操作令牌；context/model GET 下发，organize POST 回填校验
      const csrf = randomUUID();
      // host 不在这条形状守卫的检查面里（它查的是 register / registerFallback 两枚函数），
      // 故按 unknown 逐位读；缺位就当"只绑回环"，那是保守档。
      const servingNonLoopback = isRecord(rawWebServer) && rawWebServer["host"] === "0.0.0.0";
      // 惰性 getter：服务可能在路由注册之后才就绪（inject 只声明 webServer 硬依赖）
      // 各服务经形状守卫投影（替代 `svc.get(...) as X` 断言）。
      const deps: RouteDeps = {
        sessions: () => {
          const service = getService("sessions");
          return isSessionsService(service) ? service : undefined;
        },
        fs: () => {
          const service = getService("fs");
          return isFsService(service) ? service : undefined;
        },
        llm: () => {
          const service = getService("llm");
          return isLlmService(service) ? service : undefined;
        },
        agentDefaultModel: () => {
          const service = getService("agentDefaultModel");
          return isAgentDefaultModel(service) ? service : undefined;
        },
        // 导入允许根：每次请求现读 volatile 引用（改设置不必重启插件）。引用背后仍可能
        // 是存量脏配置，故过 importAllowRootsOf 收成字符串表——读不到就是空表，绝不因为
        // 缺配置就放开绝对路径（只剩「会话 cwd + 内置角色库」两个根）。
        importAllowRoots: () => importAllowRootsOf(config.importAllowRoots.get()),
        // 部署值：每次请求现读（volatile 位 .get()；非 volatile 位直读普通值）。
        limits: () => ({
          organizeTimeoutMs: config.organizeTimeoutMs.get(),
          maxSnippetBytes: config.maxSnippetBytes,
          readConcurrency: config.readConcurrency,
          importBodyMaxBytes: config.importBodyMaxBytes,
        }),
      };
      const handlers = createRouteHandlers(deps, csrf, localeMessages, servingNonLoopback);
      const disposeDefaults = webServer.register({
        kind: "exact",
        path: DEFAULTS_PATH,
        handler: (req, res) => {
          handlers.defaults(req, res);
        },
      });
      const disposeContext = webServer.register({
        kind: "exact",
        path: CONTEXT_PATH,
        handler: (req, res) => handlers.context(req, res),
      });
      const disposeModel = webServer.register({
        kind: "exact",
        path: MODEL_PATH,
        handler: (req, res) => {
          handlers.model(req, res);
        },
      });
      const disposeOrganize = webServer.register({
        kind: "exact",
        path: ORGANIZE_PATH,
        handler: (req, res) => handlers.organize(req, res),
      });
      const disposeImport = webServer.register({
        kind: "exact",
        path: IMPORT_PATH,
        handler: (req, res) => handlers.importAgent(req, res),
      });
      return () => {
        disposeDefaults();
        disposeContext();
        disposeModel();
        disposeOrganize();
        disposeImport();
      };
    }, "dir-prep-organize: webServer routes");
  });
}
