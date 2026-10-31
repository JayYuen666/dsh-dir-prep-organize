// dir-prep-organize host 半：对话输入框「润色」按钮的后端。
//
// 架构：Client 半（src/client-entry.ts）经官方 Typert Remote 的 `dirPrepOrganize`
// 命名空间调用本文件的五个方法。认证、Host/DNS 重绑定/Origin 判据与 body 上限由
// 宿主 `/api` 网关承担，本包不注册 HTTP 路由。
//
// 五个方法：
//   defaults()                                  内置精选模板表（按需载入）
//   context({ sessionId })                      目录上下文（文件名+大小+关键文件摘要）
//   model({ sessionId })                        当前默认模型（provider/model/effort）
//   organize({ sessionId, prompt, … })          用该模型润色草稿（LLM 流式聚合）
//   importTemplates({ path, sessionId })        角色 .md 导入 → 模板条目（只读，见导入节）
//
// 文案双语：本文件产出的固定文案（①「润色」的 system prompt，面向模型；②会回显到设置卡
// 与润色按钮的导入/读面回执，面向用户）集中在 src/host-messages.ts，按官方 locale 插件
// 的偏好现读取表（见 apply 的 localeMessages）；纯函数一律以字典为**入参**、不读设置。
// console.* 日志与注释不随界面语言切换，故留中文；agents/ 角色库与
// src/default-templates.generated.ts 是用户可编辑的数据，不做机翻。
//
// 导入边界（「cwd 内 + 内置角色目录 allowlist」，见 importPathError）：绝对路径**默认
// 拒绝**，只放行三类根——会话 cwd、本包内置角色库 agents/、设置 importAllowRoots 登记的
// 目录；越界回 403 + {ok:false,error}（错误文本点名允许区并回显解析后的路径），
// path 字段非字符串/纯空白回 400，不再静默降级成"导入内置全部"。
//
// 数据源（全部 ctx.get 可选读取，缺服务时读面报 error 而非炸插件）：
//   sessions.get(sessionId).header.cwd   会话 cwd（目录源，用户拍板）
//   fs.resolve/listDir/readText          目录枚举与关键文件首段
//   agentDefaultModel.currentSelection   当前默认模型（composer 选择落此处）
//   llm.stream                           模型调用（GenerateOptions 契约）
//
// 目录粒度：文件名+大小+关键文本文件全文。条目数不设上限（上下文完整性优先），
// 但**单个文件按字节上限整份跳过**：readWholeText 在 harness 侧无上限，一个顶层
// 巨型 .md/.json 就能撑爆响应并把半份内容当"全量摘要"回投，宁可少喂一条并如实
// 计数，也不静默拖垮读面。摘要/导入读取一律走有界并发（fd 打满时 EMFILE 会让
// 片段被静默丢掉而仍报 ok:true）。
// 失败语义（用户拍板）：读面返回 {ok:false,error}，Client 隐藏面板并显示错误。
// 传输层已交给官方 Typert Remote：认证、body 上限与方法分派由宿主 /api 网关负责，
// 本文件不再解析请求体，也没有自建的信任闸门或 CSRF 令牌。
//
// 模板设置（**隐式注册**）
// 宿主移除了 settings.register/get/installSection：命名空间 = 本包 cordis.patch.yml 里的
// 裸条目 id（dir-prep-organize），可编辑字段 = 下面 Config 上标了 `.volatile()` 的字段。
// 一个 volatile 字段都没有的条目会被宿主 describe() 整条跳过
// （packages/settings/settings/src/index.ts），写入则抛 `has no volatile fields`，
// 所以「哪些项出现在设置卡上」由 schema 自己决定（test/host.test.ts 用宿主同一判据回看）。
// 旧 register 的 `base` 底座也随之取消，逐字段落到 `.default(...)`（见 configSchema 上方注释）：
// importAllowRoots 落 `.default([])`，而 templates **不给默认**——src/default-templates.generated.ts
// 那份精选集（scripts/gen-defaults.mjs 从 agents/ 角色库生成）由 **client 半**持有并作回落，
// host 半不再读它，也没有把整份精选集当底座交进 settings 的那一步。
// client（设置卡/下拉）直读本条目的配置表单 `ctx.configForms.get(entryId)`（宿主已移除
// settingsScope 这一层），不经 HTTP、零 LLM。数组 set 语义
// 已按 dsh-settings 源码取证：applyPathOp 字段级整体替换 + cloneJsonShaped
// JSON 白名单允许普通对象数组（session-rescue providerExcludes:string[] 先例）。
// host 侧只剩两面用 settings：configure（声明本包自带卡片、别让宿主再生成自动页）
// 与 describe（跨命名空间现读官方 locale 插件的语言偏好）。配置值本身由 cordis 在校验
// 过 Config schema 之后按 volatile 引用交进 apply，取当前值一律 config.<field>.get()——
// 「存量配置坏一段」在装载期就抛、由宿主报装配失败，插件侧不再有可兜的那条 try/catch。

import path from "node:path";
import Schema from "@deepseek-ai/schemastery";
import type { Context, Volatile } from "@deepseek-ai/cordis";
// 值导入：`brandString` 是官方幻影品牌唯一的合法构造口（用在哪两位上见下面 SessionsService 的
// 注释）。它是恒等函数，且 dsh-brand 自述「不拥有任何具体域值，也不保留任何运行时身份或可变
// 状态，独立安装的副本产出可互换的值」——据此把它落 peerDependencies（并在 devDependencies
// 里同版再写一份供本仓编译与测试）、产物留裸说明符。只放 devDependencies 会让 rolldown 把函数体
// 内联进 host.js，等于每包各持一份官方实现；写进 dependencies 更糟——消费方的 profile 是 hoisted
// 安装且 autoInstallPeers: false，它会在那棵树里物化成**第二份真实目录**，与宿主进程已加载的那份
// 并存，见 test/publish-manifest.test.ts 的那条门禁。与 danger-guard 的 `brandNumber`、
// session-rescue 的 `brandString` 同一处、同一理由。
import { brandString } from "@deepseek-ai/dsh-brand";
import type { FsDirEntry, FsTarget, FileSystem } from "@deepseek-ai/dsh-fs";
import type {
  FinishReason,
  GenerateOptions,
  LlmRuntime,
  Message,
  ReasoningEffortId,
  RequestUserInput,
  StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SettingsForms } from "@deepseek-ai/dsh-settings";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
// host 侧文案语言跟官方 locale 插件的偏好同源：读它拥有的 settings 命名空间（未注册即中文）。
// 字典本身在 src/host-messages.ts（纯数据），本文件只负责取表与注入。
import {
  LOCALE_SETTINGS_NAMESPACE,
  messagesFor,
  resolveLocalePreference,
} from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { HOST_MESSAGES } from "./src/host-messages.ts";
import type { HostMessages } from "./src/host-messages.ts";
import { groupLabelOf, parseAgentFrontmatter, tryCondenseRoleBody } from "./src/templates.ts";
import type { AgentFileInfo, TemplateEntry } from "./src/templates.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";

/** 本包送进 `llm.stream({ messages })` 的润色请求帧是 **request-only 输入**：它从不落
 *  任何持久消息位（`runOrganize` 只回 `{ content }`，读面也不把帧身份回投给卡片），所以
 *  它既不需要 `id` 也不带 `source`——证据三条：
 *  1. installed `@deepseek-ai/dsh-llm/lib/types/types.d.ts` 的 `RequestUserInput`
 *     把两面都标成 `?: never`（`readonly id?: never` / `readonly source?: never`），
 *     `GenerateOptions.messages` 收的是 `RequestMessage[] = Message | RequestUserInput`
 *     （`GenerateOptions` 的字段注记 "a hand-built one-shot may include identity-free user
 *     inputs"）；
 *  2. 持久那半边 `Message` 要的 `source.kind` 必须是**已声明**进 `MessageSourceMap` 的
 *     kind（installed `dsh-llm/lib/types/message.d.ts`），本包的
 *     `plugin:dir-prep-organize` 不在其中——旧代码同时带上 `id` 与该 kind，造的正是宿主
 *     没有的第三种形状；
 *  3. 宿主的持久化归属策略是「request-only 输入不需要持久身份」：把一次性提示构造成
 *     Session 消息只会给 source 联合类型平白增加分支（"Request-only prompts need no
 *     durable identity, but constructing them as Session messages adds unnecessary source
 *     alternatives to that union."）。
 *  故旧的 `ORGANIZE_SOURCE_KIND` 常量（连同只被它和帧 id 用到的 `PLUGIN_NAME`）一并撤下。
 *  本包没有读回侧需要它：`extractRecentTurns` 只认真人 `kind === 'user'` 与模型
 *  `kind === 'model'`，从不按本包 kind 去重或断链，所以删除它不牵动任何 dedupe 配对。
 *  同款 request-only 先例：harness `packages/compaction/compaction-basic/src/summarizer.ts`。 */
/** 插件自带角色库目录（agency-agents-zh 部门目录移入）。导入路径留空 = 全量导入此目录。 */
const AGENTS_DIR = path.join(import.meta.dirname, "agents");

/**
 * 内置精选模板表的数据产物入口（templates.data.mjs，由 build-host.mjs 单独产出）。
 *
 * 用 `import.meta.url` 相对定位，与上面 AGENTS_DIR 同一套理由：产物落**包根**，所以运行时
 * 落点必须跟着产物走，而不是跟着构建时的 cwd 或源码目录走。
 *
 * 说明符走变量而不是字符串字面量，是刻意的：rolldown 见到字面量会去解析它，而这个名字在
 * 源码树里并不存在（它是上一次构建的产物）。变量形态让打包器原样留下，由 Node 在运行期解析。
 */
const DEFAULT_TEMPLATES_URL = new URL("templates.data.mjs", import.meta.url);

/**
 * 首次读取时才 import 模板表，之后复用同一个 promise（失败也不重试——同一个坏包反复 import
 * 只会重复报同一个错，缓存住失败反而让症状稳定）。
 */
let defaultTemplatesPromise: Promise<readonly TemplateEntry[]> | undefined;

/**
 * 产物导出值的守卫：只认「是数组」这一条。
 *
 * 元素级校验刻意不在这一层做——读面把这张表原样 JSON 序列化下发，渲染侧的兜底在 client
 * 半；在这里逐条断言字段只会让守卫和生成脚本的字段集耦在一起，改一个字段要动两处。
 * `Array.isArray` 本身会把 unknown 收窄成 `any[]`，经类型谓词再收一次，返回值才不是
 * 不安全返回（no-unsafe-return）。
 */
function isTemplateEntryList(value: unknown): value is readonly TemplateEntry[] {
  return Array.isArray(value);
}

/**
 * 从 import 到的模块命名空间里取出内置精选模板表；形状不对就抛。
 *
 * 说明符是变量 ⇒ import() 的返回类型退化成 any，所以这一步必须自己验形状：产物发错、发旧、
 * 或被别的构建覆盖，症状都会是「模板下拉空着」，而带原因的报错比一张空列表好定位得多。
 * 提成纯函数是为了能脱离磁盘与模块缓存单测它——产物 URL 一旦被加载过就进了 Node 的 ESM
 * 缓存，改磁盘上的内容对后续 import 是无效的。
 *
 * @param raw - import 得到的模块命名空间
 * @returns 内置精选模板表
 */
export function defaultTemplatesFrom(raw: unknown): readonly TemplateEntry[] {
  const value = isRecord(raw) ? raw["DEFAULT_TEMPLATES"] : undefined;
  if (!isTemplateEntryList(value)) {
    throw new Error("templates.data.mjs 的导出形状不对：期望具名的 DEFAULT_TEMPLATES 数组");
  }
  return value;
}

/** 真正去 import 产物的那一步；单独立一个函数，缓存就只认「进行中/已完成」这一个 promise。 */
async function importDefaultTemplates(): Promise<readonly TemplateEntry[]> {
  const raw: unknown = await import(DEFAULT_TEMPLATES_URL.href);
  return defaultTemplatesFrom(raw);
}

/**
 * 内置精选模板表：按需载入，永不静态导入。
 *
 * 静态导入会让整张精选表随宿主载入插件一起进内存，而它们只有一个消费者——default-templates
 * 读面，而客户端本来就是首次打开下拉时才拉这一发。两边都按需，才是同一件事的同一口径。
 *
 * @param load - 载入器，缺省即真实 import 产物；单测靠它把「首读失败」那一档做成可复跑
 *   的判据（产物 URL 一旦被成功加载就进 ESM 缓存，改磁盘内容对后续 import 无效，所以失败路径
 *   只能从这一个缝注入）。
 * @returns 内置精选模板表
 */
export async function loadDefaultTemplates(
  load: () => Promise<readonly TemplateEntry[]> = importDefaultTemplates,
): Promise<readonly TemplateEntry[]> {
  defaultTemplatesPromise ??= load();
  try {
    return await defaultTemplatesPromise;
  } catch (error) {
    // 失败的 promise 不能留在缓存里：读面的 Retry 会拿同一个 rejection 重放，一次瞬时失败
    // （例如产物还在落盘）就把整次会话钉死成「永远失败」。清掉缓存，下一次调用重新尝试。
    defaultTemplatesPromise = undefined;
    throw error;
  }
}

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
/** 文件名命中即跳过摘要的模式（凭据/密钥类，大小写不敏感）。
 *
 * 为什么不是朴素子串表：子串匹配把两类错误混在一起，而它们的代价完全不对等。漏匹配
 * （`api-keys.json`、`token.json`、`auth.json`）= 凭据全文进 system prompt 发给第三方
 * 模型；过度匹配（`monkey.js`、`AUTHORS.md`）= 一份正常文档凭空消失。前者是安全事故，
 * 后者是使用摩擦——但过度匹配会让排查变得莫名其妙，所以这里按**分隔符边界**收：
 * 命中词的前后必须是串首串尾或非字母数字字符，于是 `api-keys.json`/`api_key.json`/
 * `db-password.json` 命中，而 `monkey.js`（key 前是 n）、`AUTHORS.md`（auth 后是 o）不命中。
 * 复数形式一并收进来：`tokens.json`、`accounts.json` 是真实存在的凭据文件名。 */
const SECRET_PATTERN =
  /(?:^|[^a-z0-9])(?:credentials?|secrets?|id_rsa|pem|p12|pfx|keystore|env|keys?|tokens?|auth|passwd|password|accounts?)(?:[^a-z0-9]|$)/u;
/** LLM 润色超时。 */
/** schema .default() 的单源（host 消费走 config 字段，不再直读常量）。 */
const ORGANIZE_TIMEOUT_MS = 120_000;
/** 单个关键文件的摘要字节上限。harness 的 readWholeText 无上限，超限文件整份
 *  跳过（不截半份——半份摘要会以"全量"的名义喂给模型，比没有更误导），
 *  并计入 skipped.tooLarge 回报。 */
const MAX_SNIPPET_BYTES = 256 * 1024;
/** 单次润色带进模型的全部摘要的**总量**上限。
 *
 *  为什么需要总量而单文件上限不够：`maxSnippetBytes` 只管每个文件，而条目数不设上界
 *  （用户拍板）。于是 client 把所有摘要拼成 `entriesSummary` 原样回投 organize，请求
 *  仍要过宿主 /api 网关的请求体上限，摘要一多就顶得过它，结果是 context 读面成功、
 *  UI 正常列出文件树，用户点「润色」才在网关处失败。这里给总量封顶，让「context 成功」
 *  不再意味着「organize 必然失败」。留足余量：JSON 转义与 client 侧的拼接还会再放大一截。 */
const MAX_CONTEXT_TOTAL_BYTES = 2 * 1024 * 1024;
/** 文件读取并发上限：Promise.all 一次铺开会在导入内置角色库（整棵 agents/）时打满
 *  fd，EMFILE 抛错被单文件 catch 吞掉 → 条目静默丢失而仍报 ok:true。 */
const READ_CONCURRENCY = 8;
/** `readConcurrency` 的上界。再往上只是更快撞上 fd 上限——而那正是这个字段存在的
 *  理由；schema 的 `natural()` 无上界，所以上界只能在这里补。 */
const MAX_READ_CONCURRENCY = 64;
/** Node `setTimeout` 的延时上限（2^31-1 ms）。** 超过它 V8 会打一条
 *  TimeoutOverflowWarning 然后把延时静默夹成 1 ms**——于是「把超时调大」这个配置意图
 *  被反转成「立刻失败」，且只在 stderr 留一行警告。`Schema.natural()` 不挡这个值。 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * 把一个部署来的数夹进 `[min, max]`，非有限值回落到 `fallback`。
 *
 * 为什么单独要一个函数：`Math.min(Math.max(NaN, 1), MAX)` 的结果是 `NaN`——两个 clamp
 * 都会把 NaN 原样放过去，于是「看起来夹过了」的代码对最危险的那个输入恰好无效。
 *
 * @param value - 待夹的数（可能非有限）
 * @param min - 下界（含）
 * @param max - 上界（含）
 * @param fallback - `value` 非有限时用的默认值
 * @returns `[min, max]` 区间内的整数
 */
export function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// ── host 服务面（全部绑官方声明，不再本地镜像）────────────────────────────
// 这一族此前是「按源码逐字段核对的最小 interface」——本包当时不声明 @deepseek-ai/dsh-fs /
// dsh-llm / dsh-session 依赖，只能手抄。手抄的代价在这批里最重的一处是 `FsTarget.targetKey`：
// 官方它是品牌串 `FsTargetKey = Branded<'FsTargetKey'>`（installed
// @deepseek-ai/dsh-fs/lib/types/types.d.ts），抄成裸 `string` 之后品牌信息在
// 整条 stream/摘要链上永久丢失（编译器不再拦得住"拿错 targetKey"）。现在本包声明这些官方包为
// devDependency（type-only，运行时仍由 ctx 注入），每个服务面都改成官方成员的 `Pick` 投影：
// 入参、返回、可选性、品牌一律由官方交出，上游改名/加必填位即在此编译不过。

// 下列形状全部 **export**：测试注入的假服务必须是这些形状的合法实现（而非
// `as never` / `as unknown as X` 绕过），类型面同样参与回归锁定。
/** 目标的官方形状直接 re-export（`targetKey` 就此是官方 `FsTargetKey` 品牌，不再降级成 string）。 */
export type { FsDirEntry, FsTarget } from "@deepseek-ai/dsh-fs";

/**
 * 官方 `FileSystem`（installed @deepseek-ai/dsh-fs/lib/types/index.d.ts，cordis `Service`
 * 子类 → 名义比较）的方法面投影：本包用 `resolve` / `listDir` / `readText`
 * / `contains` / `stat`。旧镜像漏抄了官方那几位的可选 `signal?: AbortSignal`
 * 形参（抄本里没有的形参在 TS 里是"少收一个参数"，调用点不会报错，但真实宿主多一档取消
 * 语义）；投影之后它回到官方形状。
 *
 * `stat`（installed `@deepseek-ai/dsh-fs/lib/types/index.d.ts`，返回 `{version,type,size?}`）是**单文件导入**那条
 * 路径唯一的字节上限来源：目录分支的每个候选都自带 `listDir` 给的 `size`，而单文件导入
 * 只有一个 `resolve` 出来的 target，不 stat 就无从判断该不该读——而官方 `readText`
 * 自述"读整份文本"、**没有任何上限**。缺了它，一个几 MB 的 .md 就能把整份读进宿主内存。
 */
export type FsService = Pick<FileSystem, "resolve" | "listDir" | "readText" | "contains" | "stat">;

/**
 * 本包从会话消息史的读取面 = **官方 `Message` 的键名投影**（installed
 * @deepseek-ai/dsh-llm/lib/types/message.d.ts `MessageBase` 与各变体的 `role`），
 * 三位各自取到"本包能凭运行时守卫负责的那一档"：
 * - `role` 就此是官方 `Message['role']` 的字面量联合（上游加/改角色即在此编译不过，
 *   下面 `role === "user" || role === "assistant"` 的判定跟着动）。
 * - `content` 官方是 `readonly ContentBlock[]`（message.d.ts），但本包的职责是
 *   **逐块自证**：只认 `type==='text'` 且 `text` 是字符串的块（`isTextBlock`），其余
 *   （tool-call / reasoning / image / 宿主新版本才有的块）一律跳过。这里留 `unknown`
 *   不是"抹平官方形状"，而是本包**不假设交付**：`Array.isArray(msg.content)` 那道判据
 *   断言的正是"交来的可能根本不是数组"，test/host.test.ts 的「坏形状」用例钉的就是
 *   非数组 content（字符串）与数组里的裸字符串/null 项。把值域收成官方联合等于宣称
 *   "块形状可信"，那几条用例便无法表达，而为了过类型删用例是本仓红线。
 * - `source.kind` 官方是 `MessageSourceMap` 的值联合（installed message.d.ts 只有
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
 * @deepseek-ai/dsh-session/lib/types/index.d.ts：`readonly header: SessionHeader`、
 * `deriveMessages(): Message[]`）。
 * 键名一律借自官方（`header` 借 `Session`、`cwd` 借 `SessionHeader`，installed
 * @deepseek-ai/dsh-session 域内 types.d.ts `readonly cwd?: string`），值域收成"本包真的读的那位
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
 * index.d.ts）的 `get` 一位（`Sessions.get(id: SessionId)`）在本包的
 * 读法：入参就此是官方品牌的 `SessionId`（边界上递来的是裸 string，构造口只有文件头那枚
 * `brandString<SessionId>`），返回值域换成上面的 `SessionLike` 投影——直接取官方返回的整枚
 * `Session` 类会把名义类一路渗进本包（`private log`/`surfaceManager`），那三道运行时
 * 守卫当场在编译器眼里变成死代码，而它们挡的是真实输入。返回 `undefined` 与官方一致。
 * 口径同 danger-guard/host.ts 的 `GuardExecution`（借键名、值域换投影）。
 */
export interface SessionsService {
  get: (id: SessionId) => SessionLike | undefined;
}

/** 活 Agent 的模型选择面（新版 `model.current()`；旧版只有 `options`）。 */
export interface LiveModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ModelSelection["reasoningEffort"];
}
/** 活 Agent 的只读投影：本包只碰模型这两位。 */
export interface LiveAgent {
  readonly model?: { readonly current: () => LiveModelSelection | undefined } | null;
  readonly options?: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: ModelSelection["reasoningEffort"];
  };
}
/** 宿主 agent 注册表读面：按会话 id 取活 Agent。 */
export interface AgentsService {
  get: (id: SessionId) => LiveAgent | undefined;
}

/** 会话 id 的官方品牌构造：把边界上读来的裸 string 送进 `SessionStore.get`。 */
const sessionIdOf = (value: string): SessionId => brandString<SessionId>(value);
/** `ReasoningEffortId` 取官方真品牌（`Branded<'ReasoningEffortId'>`，以 dsh-brand 的
 *  `unique symbol` 为键）。本地重述成 `string & { effortBrand: ... }` 是**假品牌**：
 *  键不同名即不同型，宿主真值塞不进来、任何带该属性的字符串反倒能通过，注释里那句
 *  「转换点为 0」并不成立。取官方类型后模型选择与 stream 入参两侧共用同一真值。 */
export type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
/** 默认模型选择的三位形状：与官方 `ModelSelection`（`@deepseek-ai/dsh-agent` 的
 *  model-selection.d.ts）同形。`reasoningEffort` 用官方真品牌 `ReasoningEffortId`（上面已按
 *  dsh-llm 的 peer 面 re-export），品牌值塞不进 stream 入参的静默丢字段风险仍在类型面上。
 *
 *  为什么不直接 import/re-export 官方类型：那会在 `types/host.d.ts` 里留下裸说明符
 *  `@deepseek-ai/dsh-agent`，按本仓门禁它只能落进 peer 表，而本包运行期并不 import 它——
 *  为此扩一条 peer 是发布契约变更，归用户裁决；在此之前用结构等价类型。 */
export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffortId;
}

/** 默认模型服务的读面投影：本包只 `currentSelection()`，不写回（`saveSelection` 归 composer）。
 *
 *  刻意不 `Pick<AgentDefaultModelConfig, …>`：那个声明文件 import 了它自己没声明的
 *  `@deepseek-ai/dsh-agent`，干净检出里这条链会退化成 error 类型，类型感知的 oxlint 在 CI
 *  上整片报 `no-unsafe-*`（伞根里经 hoist 解析得开，本机门禁看不见）。返回值用本仓的
 *  结构等价 `ModelSelection`，与真实服务的官方类型在成员面上相容。 */
export interface AgentDefaultModel {
  readonly currentSelection: () => ModelSelection;
}
/** 文本块与 request-only user 输入均取官方声明：`TextBlock` 与 `RequestUserInput`
 *  （后者的 `content` 真值是 `UserMessage["content"]` 全块集，`id`/`source` 是
 *  `?: never`——本包只发单条 user 文本消息，形状由官方约束而不是自己抄一半）。 */
export type { RequestUserInput, TextBlock } from "@deepseek-ai/dsh-llm";

/** 流块与终态取官方判别联合（`switch (chunk.type)` 即收窄载荷，不再把 `type` 写成
 *  裸 `string` + 全可选成员）。 */
export type { FinishReason, StreamChunk } from "@deepseek-ai/dsh-llm";

/** stream 入参：官方 `GenerateOptions` 的本包用到的子集。在 `Pick` 之外**另加**
 *  一枚 `signal?: AbortSignal` 是不行的——官方本来**就有**这一位
 *  （installed @deepseek-ai/dsh-llm/lib/types/types.d.ts），另写一次等于凭空多出一个
 *  与官方并行的形状声明；连同 `signal` 一起 `Pick`，一处来源。 */
export type LlmStreamOptions = Pick<
  GenerateOptions,
  "provider" | "model" | "reasoningEffort" | "messages" | "system" | "signal"
>;

/** 官方 `LlmRuntime`（`Context.llm` 的类型，installed @deepseek-ai/dsh-llm/lib/types/
 *  index.d.ts）的方法面投影：本包只 `stream`。旧镜像把返回抄成
 *  `AsyncIterable<StreamChunk>`——官方那一位的真实返回域由成员自己交出，重述一次就多一处
 *  会漂移的判决（`stream` 在 installed index.d.ts 上有数枚同名成员，本包用的是 runtime 那枚）。 */
export type LlmService = Pick<LlmRuntime, "stream">;
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
// settings 不再暴露 register：本包只用 describe（跨命名空间读）与
// configure（页面策略），probe 宿主独有的 describe 即可。
/**
 * 官方 `SettingsForms`（installed @deepseek-ai/dsh-settings/lib/types/index.d.ts，
 * `Service` 子类 + private `ownerContext/revisions/closed/scheduled/presentations` → 名义
 * 比较）的方法面投影：本包只用 `describe`（跨命名空间读官方 locale 偏好）与 `configure`
 * （页面策略）。守卫的谓词类型若写成**整个类**，那是一条对本包需求的过度声明——
 * 它宣称「宿主必须给我一枚完整的 settings 服务」，而下面每个服务守卫都只点名自己用到的成员。
 */
type SettingsFormsService = Pick<SettingsForms, "describe" | "configure">;

function isSettingsService(value: unknown): value is SettingsFormsService {
  // 两个成员都要核：谓词类型是 Pick<…, "describe" | "configure">，只核 describe 时
  // 一枚「有 describe、没 configure」的残形会过闸，随后 configure() 直接把 TypeError
  // 甩在装配期（实测 s.configure({auto:false}) → "s.configure is not a function"）。
  return hasFnMember(value, "describe") && hasFnMember(value, "configure");
}
function isSessionsService(value: unknown): value is SessionsService {
  return hasFnMember(value, "get");
}
function isAgentsService(value: unknown): value is AgentsService {
  return hasFnMember(value, "get");
}
// stat 与 resolve 同为硬依赖：单文件导入的字节上限只有 stat 能给（见 FsService 注释）。
// 守卫漏掉它，缺 stat 的服务会以 "resolve is not a function" 的形态炸在请求中途，
// 而不是读面回一句「fs 服务不可用」。
function isFsService(value: unknown): value is FsService {
  return (
    hasFnMember(value, "resolve") &&
    hasFnMember(value, "stat") &&
    hasFnMember(value, "listDir") &&
    hasFnMember(value, "readText") &&
    hasFnMember(value, "contains")
  );
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
/** 换行与控制字符（`Cc` 含 \r\n\t，`Zl`/`Zp` 是 Unicode 行分隔与段分隔）。 */
const LINE_BREAKERS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** 把一段宿主文本压成单行。
 *
 *  system 槽里每条内容独占一行，模型按行读它——任何能从外部带的换行都能在 system 里凭空
 *  造出下一行，而那正是最高信任位。cwd 取自会话工作目录，是文件名，POSIX 允许目录名带换行。
 *  这里不改成转义序列：读的人只需要知道「这一行就是那个路径」，多出来的字节不必还原。 */
function singleLine(text: string): string {
  return text.replaceAll(LINE_BREAKERS, " ");
}

function fillTemplate(template: string, tokens: readonly (readonly [string, string])[]): string {
  let text = template;
  for (const [token, value] of tokens) {
    text = text.split(token).join(value);
  }
  return text;
}

/** 有界并发的 map：批内并行、批间串行等待，从而把同时在打开的文件数压在 limit 以内。
 *  不用 `Promise.all(items.map(...))` 一次铺开——导入内置库（整棵 agents/ 的 .md）会把
 *  进程 fd 打满，EMFILE 抛错被单文件 catch 吞掉 → 条目静默丢失而仍报 ok:true。
 *  分片用**递归**而非 for+await：批间等待是并发上限的实现手段，而 await-in-loop
 *  在本包严格档里是 error（不用 disable 注释换取绿灯）。
 *  worker 自己负责错误降级（不抛），否则一个失败会让整批 reject、把已完成结果全丢掉。
 *
 *  ⚠ limit 必须在这里自守，不能指望上游都夹过：`limit<=0` 时 `slice(0, limit)` 恒为
 *  空数组而 `slice(limit)` 恒为**原数组**，于是递归参数原地不动 = 无限自递归。它不是
 *  栈溢出——`async` 递归不涨调用栈——而是每轮 `Promise.all([])` 累积一个微任务，
 *  内存单调增长直到 V8 上限，进程被 OOM killer 直接带走（实测 exit 134）。宿主里
 *  其他插件和当前会话跟着一起没，而触发它只需要一个配置值。 */
async function mapBounded<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }
  const batchSize = clampInt(limit, 1, MAX_READ_CONCURRENCY, READ_CONCURRENCY);
  const batch = await Promise.all(items.slice(0, batchSize).map((item) => worker(item)));
  if (items.length <= batchSize) {
    return batch;
  }
  return [...batch, ...(await mapBounded(items.slice(batchSize), batchSize, worker))];
}

function isKeyFile(name: string): boolean {
  const lower = name.toLowerCase();
  // 敏感面排除优先：命中凭据/密钥模式的文件永不取摘要
  if (SECRET_PATTERN.test(lower)) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  // 扩展名比对着 lower 取，不对着的后果是**静默丢数据**：`README.MD`/`config.JSON`
  // 既拿不到摘要，又不计入任何 skip 计数——LLM 收到一份「该文件没有内容」的目录表，
  // UI 上也看不出少了东西。密钥面早就用的是 lower，只有这一面漏了。
  return KEY_EXT.has(lower.slice(dot));
}

/** 关键文件摘要：全量正文（用户拍板不截断——上下文完整性优先，
 *  模型 context 超限由模型报错提示用户自行处理）。仅 trim 去头尾空白。
 *  ⚠ 行尾先归一：官方 readText 承诺 byte-for-byte（**不归一 CRLF**，宿主 fs-local
 *  源码注明），于是 Windows 仓库里的 `\r` 会原样进摘要；client 侧的折行压平只换
 *  `\n`，`\r` 就留在发给模型的 prompt 里（既污染文本又让行数统计失真）。
 *  归一放在这一层而不是 client：host 是「真实字节 → 模型文本」的唯一转换点。 */
function makeSnippet(content: string): string {
  const trimmed = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  return trimmed.length === 0 ? "" : trimmed;
}

/** 单个关键文件摘要的取舍结果：留不留、留多大。 */
interface ReadDecision {
  /** 留则给正文，丢则 undefined。 */
  readonly snippet: string | undefined;
  /** 留则计入累计字节。 */
  readonly keptBytes: number;
  /** 该不该记进 skipped.tooLarge（单份太大，或累计预算装不下）。 */
  readonly countTooLarge: boolean;
}

/**
 * 一次读取的取舍：单文件上限之外再加一道**总量**上限。
 *
 * 抽成独立函数而不是塞在循环里，是因为这段有三类互斥的判定（单份过大 / 读失败 /
 * 累计超预算），内联进 collectDirContext 会把那个函数的认知复杂度顶穿。
 *
 * @param read - 单文件读取结果
 * @param usedBytes - 本次收集已累计的字节
 * @param maxTotalBytes - 总量上限
 * @returns 取舍结果
 */
function classifyRead(
  read: { tooLarge?: boolean; unreadable?: boolean; snippet: string | undefined },
  usedBytes: number,
  maxTotalBytes: number,
): ReadDecision {
  const bytes = read.snippet === undefined ? 0 : Buffer.byteLength(read.snippet, "utf8");
  if (read.tooLarge === true || read.unreadable === true || read.snippet === undefined) {
    // unreadable 的计数由调用方单独记（两类计数口径不同，不能合并）
    return { snippet: undefined, keptBytes: 0, countTooLarge: read.tooLarge === true };
  }
  if (usedBytes + bytes > maxTotalBytes) {
    return { snippet: undefined, keptBytes: 0, countTooLarge: true };
  }
  return { snippet: read.snippet, keptBytes: bytes, countTooLarge: false };
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

/** 静默丢数据的记账（"读失败即 undefined、超限即忽略"的话没有任何回执，
 *  界面与 host 都显示成功）。dir context 与 import 两个读面共用此形状。 */
export interface SkipCounts {
  /** 字节超限、整份跳过的文件数。 */
  tooLarge: number;
  /** 读取失败（含 EMFILE / 权限 / 非 UTF-8）的文件数。 */
  unreadable: number;
  /** 只在更深一层、被扫描深度限制造漏掉的 .md 数（仅导入读面用）。 */
  deeper: number;
  /** 读到了但解析不出角色 name（非角色文件）而被跳过的文件数（仅导入读面用）。 */
  unnamed: number;
  /** 真实目标落在允许根之外（符号链接指向根外文件）而被策略排除的文件数。
   *  必须单列：它既不是读失败也不是超限，把「凭据文件被链接进工作目录」这类事
   *  混进 unreadable，用户就看不出是安全闸门拦的还是目录本身坏了。 */
  escaped: number;
}

function skipCounts(): SkipCounts {
  return { tooLarge: 0, unreadable: 0, deeper: 0, unnamed: 0, escaped: 0 };
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

/** 读面实际用的收集函数：fs 服务 → DirEntry[]（含关键文件全文摘要）。
 *  条目数不设上限（用户拍板），但单文件按 MAX_SNIPPET_BYTES 整份跳过、
 *  读取按 READ_CONCURRENCY 有界并发；跳过项计入 skipped 并让 truncated 反映事实。
 *  回执文案取自注入的字典（纯函数不读设置）。 */
export interface DirScanLimits {
  /** 单文件摘要字节上限（超出整份跳过）。 */
  maxSnippetBytes: number;
  /** 有界并发读取度。 */
  readConcurrency: number;
  /** 单次收集的全部摘要的字节总量上限。 */
  maxTotalBytes?: number;
}

/** 缺省部署值（schema .default 的同源常量）；limitsOf()/collect* 的回落单源。 */
const DEFAULT_LIMITS = {
  organizeTimeoutMs: ORGANIZE_TIMEOUT_MS,
  maxSnippetBytes: MAX_SNIPPET_BYTES,
  readConcurrency: READ_CONCURRENCY,
};

/** 读面实际用的 limits 全集。 */
type RouteLimits = DirScanLimits & { organizeTimeoutMs: number };

/**
 * 部署值的唯一收口：把会致命的几个数夹进安全区间，再交给读面。
 *
 * 为什么放在这里而不是各消费点：`limitsOf()` 是 context/organize/importTemplates
 * 三个读面读 limits 的**唯一入口**，一处收口就不会漏掉将来新增的读面；而散在
 * 各消费点夹，哪天新增一个调用点就等于新增一个漏洞。
 *
 * 夹哪两个、为什么：
 * - `readConcurrency` → `[1, 64]`。**下界 0 是致命的**：`mapBounded` 拿到 0 会无限
 *   自递归直到 OOM，**整个 DSH 宿主进程被带走**，而不只是这一次请求失败（见 mapBounded
 *   的注释）。schema 的 `natural()` 下界恰好是 0 且无上界，两个方向都得夹。
 * - `organizeTimeoutMs` → `[1, 2^31-1]`。上界超了会被 `setTimeout` 静默夹成 1 ms，
 *   「调大超时」变成「立刻失败」。
 *
 * 剩下 `maxSnippetBytes` **故意不夹**：schema 已经挡住 NaN/±Infinity/负数/小数，
 *  唯一还能配出来的越界值 `0` 有确定且已记账的行为（全跳过并计 tooLarge），那是用户
 *  的显式意图，不该被悄悄改写。
 *
 * @param limits - 未经夹位的部署值
 * @returns 两项关键值已夹位、其余原样透传的新对象
 */
export function sanitizeLimits(limits: RouteLimits): RouteLimits {
  return {
    ...limits,
    readConcurrency: clampInt(limits.readConcurrency, 1, MAX_READ_CONCURRENCY, READ_CONCURRENCY),
    organizeTimeoutMs: clampInt(limits.organizeTimeoutMs, 1, MAX_TIMER_MS, ORGANIZE_TIMEOUT_MS),
  };
}

export async function collectDirContext(
  fs: Pick<FsService, "resolve" | "listDir" | "readText" | "contains">,
  cwd: string | undefined,
  messages: HostMessages,
  limits?: DirScanLimits,
): Promise<CollectResult> {
  const scan = limits ?? { maxSnippetBytes: MAX_SNIPPET_BYTES, readConcurrency: READ_CONCURRENCY };
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_CONTEXT_TOTAL_BYTES;
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
    // contains 复判（与 mdCandidates 同一道门）：后端的 listDir 会把符号链接**报成目标的
    // 类型并给出目标的 size**，于是 cwd 里一个 `notes.md -> ~/.aws/credentials` 会连名字
    // 带正文一起进 system prompt，发给第三方模型。策略判的是 cwd 这个字符串，读取走的是
    // realpath 之后的真实对象，两者之间必须由后端复判一次。
    const keyFiles = raw.filter(
      (item) => item.type === "file" && isKeyFile(item.name) && fs.contains(dirTarget, item.target),
    );
    const skipped = skipCounts();
    skipped.escaped = raw.filter(
      (item) =>
        item.type === "file" && isKeyFile(item.name) && !fs.contains(dirTarget, item.target),
    ).length;
    const reads = await mapBounded(keyFiles, scan.readConcurrency, async (item) => ({
      targetKey: item.target.targetKey,
      ...(await readSnippetBounded(fs, item, scan.maxSnippetBytes)),
    }));
    const snippetByTarget = new Map<string, string | undefined>();
    let totalBytes = 0;
    for (const read of reads) {
      const decision = classifyRead(read, totalBytes, maxTotalBytes);
      if (decision.countTooLarge) {
        skipped.tooLarge += 1;
      }
      if (read.unreadable) {
        skipped.unreadable += 1;
      }
      if (decision.keptBytes > 0) {
        totalBytes += decision.keptBytes;
      }
      snippetByTarget.set(read.targetKey, decision.snippet);
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
      truncated: skipped.tooLarge + skipped.unreadable + skipped.escaped > 0,
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
 * 导入路径安全策略（只读读面，无副作用：不调 LLM、不写盘，结果回给设置卡）。
 * 规则名：「cwd 内 + 内置角色目录 allowlist」。
 *
 * 允许根只有三类（除此之外**一律拒绝**，含所有绝对路径）：
 * - 会话 cwd（本次请求能解析出 sessionId 且会话有 cwd 时）；
 * - 插件内置角色库 AGENTS_DIR（本包 agents/，即「路径留空导入全部」的那个目录）；
 * - 用户在设置 `importAllowRoots` 里逐条登记的目录。
 *
 * 拒绝规则（确定性，测试锁死）：
 * - 空串/纯空白不是路径 → 拒（读面把「精确空串」当作"导入内置库"的哨兵并在调用前
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
 *   因此装在 ~/.dsh 下的项目也能导入自己 cwd 内的角色。
 * - 请求路径以 `.md` 结尾 → 单文件导入；否则按目录导入（顶层 *.md + 一层子目录
 *   *.md，跳过隐藏项），目录扫描不递归更深层，但漏掉的必须计数回报。
 *
 * 门禁后仍要求每个文件能解析出非空 frontmatter name（parseAgentFrontmatter），
 * 否则跳过并计数——绝不返回任意文件原文，只产出模板条目形状。
 */
/** 两种路径分隔符（win32 与 POSIX）。 */
const PATH_SEPARATOR = /[\\/]/u;

/** 路径拆段（**逐段**比较而非字符串前缀：`/home/dev/project-two/x.md` 会骗过
 *  `startsWith("/home/dev/project")`，前缀式包含判断等于放行兄弟目录）。
 *  两种分隔符都拆：win32 的 `path.resolve`/`path.relative` 产出 `\`，只按 `/` 拆会
 *  把整条路径当成一段，于是合法子路径被判成越界、`..\` 也漏过逐段校验。 */
function pathSegments(absolute: string): string[] {
  return absolute.split(PATH_SEPARATOR).filter((token) => token.length > 0);
}

/** 逐段校验：段为 "." / ".." 一律拒（归一前必须先拦，否则 path.resolve 吃掉 `..`）；
 *  checkHidden=true 时额外拒隐藏段（凭据/敏感目录，如 `.ssh`）。 */
function pathTokensError(
  absolute: string,
  checkHidden: boolean,
  messages: HostMessages,
): string | undefined {
  // 单 return 满足 consistent-return；命中非法段只记错误并 break。
  let errorMessage: string | undefined;
  for (const token of pathSegments(absolute)) {
    if (token === "." || token === ".." || (checkHidden && token.startsWith("."))) {
      errorMessage = messages.illegalPathSegment;
      break;
    }
  }
  return errorMessage;
}

/** child 是否落在 root 之内（含"child 就是 root 本身"= 导入根目录）。
 *  包含关系交给 `path.relative`：win32 的盘符大小写由它的平台语义收口
 *  （实测 `path.win32.relative("C:\\Users\\Me\\Roles", "c:\\users\\me\\roles\\x.md")`
 *  给出 `x.md`），而兄弟目录仍以 `..` 开头被拒。 */
function isWithinRoot(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  if (relative === "") {
    return true;
  }
  return !path.isAbsolute(relative) && pathSegments(relative)[0] !== "..";
}

/** 一个允许根：解析后的绝对路径 + 人话标签（越界回执用）。 */
interface ImportRoot {
  readonly absolute: string;
  readonly label: string;
}

function toImportRoot(rawPath: string, label: string): ImportRoot {
  return { absolute: path.resolve(rawPath), label };
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

/** 真实目标是否落在**每一个**允许根之外。判据交给后端（`contains` 用它自己的世界判
 *  包含关系），而不是再写第二条字符串规则：符号链接让「路径长得合法」与「读的是哪个
 *  对象」分叉，只有后端能收这个叉。一个根命中即放行；全落空即为逃逸。 */
async function escapesAllRoots(
  fs: Pick<FsService, "resolve" | "contains">,
  target: FsTarget,
  roots: readonly ImportRoot[],
): Promise<boolean> {
  // 先把根解析成后端身份再逐个判包含：`for + await` 在这里既是 await-in-loop，
  // 也让「命中即返回」省掉后续 resolve——但根只有两三枚，一并 resolve 更简单，
  // 也不用在循环里背着取消语义。
  // 逐根降级：一条过期的 importAllowRoots 目录（已删/已卸载的盘）让 resolve 抛错时，
  // 若让整批 reject，外层只会把它折成一句泛化的「导入失败」，**其它合法根**也一并
  // 打死。解析不出来的根按「不命中」处理（它确实没在本次判包含里起作用），而全都不
  // 命中仍然判逃逸 —— 这是 fail-closed 的方向：解析不出就不放行。
  const resolved = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.resolve(root.absolute);
      } catch {
        // 用 null 而不是 undefined：本函数要「返回一个值」参与后面的逐根判包含，
        // undefined 会同时被 consistent-return 与 no-useless-undefined 判成没返回。
        return null;
      }
    }),
  );
  let anyHit = false;
  for (const root of resolved) {
    if (root !== null && fs.contains(root, target)) {
      anyHit = true;
    }
  }
  return !anyHit;
}

export function importPathError(
  requested: string,
  cwd: string | undefined,
  allowRoots: readonly string[],
  messages: HostMessages,
): string | undefined {
  const trimmed = requested.trim();
  // ① 空串/纯空白不是路径（留空的语义由读面按"导入内置库"处理，不经本函数）
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
  const matched = roots.filter((root) => isWithinRoot(root.absolute, absolute));
  if (matched.length === 0) {
    return outsideRootsError(absolute, roots, messages);
  }
  // ④ 归一后再判一次（命中根以内的剩余段，含隐藏段）：`..` 与 `.ssh` 这类段
  //    两侧都拦得住，win32 跨盘符/反斜杠形状同样落在这里而不是靠系统兜底。
  //
  //    命中的根可能不止一个：会话 cwd 与 cwd 内登记的允许根会同时命中。只拿**第一个**
  //    （cwd 列表头部）算剩余段，会把「cwd/roles/.hidden/x.md」在 cwd 内合法登记时判成
  //    隐藏段越权——这是过度限制，不是绕过。按根路径长度**降序**（最深优先）逐个复判，
  //    任一通过即放行；全部不过时回最深根给出的那条错误（它最贴近实际落点）。
  const ordered = matched.toSorted((left, right) => right.absolute.length - left.absolute.length);
  const errors = ordered.map((root) =>
    pathTokensError(path.relative(root.absolute, absolute), true, messages),
  );
  const passed = errors.some((error) => error === undefined);
  return passed ? undefined : errors[0];
}

/** 角色文件 → 模板条目（正文提炼 + 目录分组标签 + 确定性 id 去重）。
 *  正文提炼不设字符上限。 */
function agentEntryFromFile(
  slug: string,
  dirName: string,
  info: AgentFileInfo,
  collided: Set<string>,
): TemplateEntry | undefined {
  // 单 return 满足 consistent-return；正文为空或围栏未闭合则 result 保持 undefined，
  // 由调用方按 unnamed 计数——一份漏写结束围栏的文件不该让同目录其余角色全部失败。
  const { text: condensedText, unclosedFenceLine } = tryCondenseRoleBody(info.body);
  const text = unclosedFenceLine === undefined ? condensedText : "";
  let result: TemplateEntry | undefined;
  if (text.length > 0) {
    // 后缀必须在本循环里自增：拿 collided.size 当唯一输入时，候选一旦恰好已被占用
    // （先读到 a-3.md、再读到两份 a.md），每轮算出的都是同一个串，while 永不退出。
    let suffix = collided.size;
    let id = slug;
    while (collided.has(id)) {
      suffix += 1;
      id = `${slug}-${String(suffix)}`;
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

/** 扩展名是否 .md：不区分大小写。macOS 默认文件系统不区分大小写，`Agent.MD` 在用户看来
 *  就是一份角色文件；按字节判后缀会把它静默丢在扫描面之外（且不计任何 skipped）。 */
function isMdName(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

const MD_SUFFIX = /\.md$/iu;

/** 去掉 .md 后缀（大小写不敏感）；没有该后缀时原样返回（replace 不命中即原样，无需分支）。 */
function stripMdSuffix(name: string): string {
  return name.replace(MD_SUFFIX, "");
}

/** 目录项是「可见 .md 文件」？（候选收集与第三层清点同一判据，两处必须数到同一批）。 */
function isVisibleMdFile(child: FsDirEntry): boolean {
  return child.type === "file" && isMdName(child.name) && !child.name.startsWith(".");
}

/** 一层目录内容 → 顶层 .md 候选（跳过隐藏项，按名排序保确定性）。
 *  `skipped` 就地累加 escaped 计数：被 contains 拦下的链接文件如果不数出来，
 *  用户只会看到「导入 3 条」而不知道有一份被安全闸门挡在门外。 */
function mdCandidates(
  fs: Pick<FsService, "contains">,
  parent: FsTarget,
  children: FsDirEntry[],
  dirName: string,
  skipped: SkipCounts,
): ImportCandidate[] {
  const visible = children.filter((child) => isVisibleMdFile(child));
  const inside = visible.filter((child) => {
    // contains 是后端**用它自己的世界**判包含关系的那道门，不是我们自己拿 targetKey
    // 当路径比——targetKey 按官方契约是 opaque 的，在沙箱后端上它根本不是宿主路径。
    //
    // 为什么必须有：`importPathError` 只对 `path.resolve()` 出来的**字符串**做段比较，
    // 而随后的 `readText(entry.target)` 会跟随符号链接。于是 cwd 里一个
    // `roles/secret.md -> /Users/me/.aws/credentials.md` 能通过策略（路径看着在 cwd 内），
    // 读出来的却是允许根之外的文件。策略判的是字符串形状、读取走的是真实对象，
    // 两者之间必须由后端自己复判一次。
    const contained = fs.contains(parent, child.target);
    if (!contained) {
      skipped.escaped += 1;
    }
    return contained;
  });
  return inside
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

/** 单个候选的字节上限判定：与 readSnippetBounded 同一口径——**size 未知即拒读**。
 *
 * 为什么单文件分支也需要这道门：目录分支的每个候选都自带 `listDir` 给的 `size`，于是
 * `readCandidate` 能在读之前判上限；而单文件导入只有一个 `resolve` 出来的 target，
 * 不 `stat` 就只能盲读——官方 `readText` 自述"读整份文本"、**没有任何上限**，于是一个
 * 几 MB 的 .md 会整份进宿主内存（实测把 maxSnippetBytes 配成 1024，3 MB 的文件照样
 * 被读进来并返回成模板条目）。宁可少导一条并如实计数，也不拿宿主进程的存亡去赌。
 *
 * @returns 通过时给出字节数，未通过时给出 undefined（调用方计 tooLarge）。
 */
async function fileBytesWithin(
  fs: Pick<FsService, "stat">,
  target: FsTarget,
  maxBytes: number,
): Promise<number | undefined> {
  // stat 抛错 = 拿不到大小 = 不敢盲读，与「size 未知」同档处理。
  // 降级值用 `null` 而不是 `undefined`：本仓 unicorn/no-useless-undefined 判的是
  // 「显式写一个可有可无的 undefined」，而此处 null 才是有意义的第三态——「压根没
  // stat 出来」与「stat 出来了但没报 size」是两件事，只是都导向不读。
  const info = await fs.stat(target).catch(() => null);
  // 官方签名为 `stat(target): Promise<FsInfo>`（**不**含 undefined），而缺席路径的
  // 文档语义是「返回 undefined」（installed dsh-fs/lib/types/index.d.ts：
  // "or undefined when the target does not exist"）。声明面比实现面窄——跨进程
  // 递来的后端未必守得住——所以这里的 `?.` 是运行时兜底，不是给类型擦补丁：
  // 缺席与「报不出 size」同档处理（都不读）。
  const size = info?.size;
  return size === undefined || size > maxBytes ? undefined : size;
}

/** 单文件导入（路径直指一个角色 .md）：字节超限或读失败各计各的；解析不出 name →
 *  记 unnamed 并回原因；读到了但正文提炼为空 → 空条目列表（agentEntryFromFile
 *  返回 undefined 的形状）。 */
async function importFromFile(
  args: {
    fs: Pick<FsService, "readText" | "stat">;
    target: FsTarget;
    limits: DirScanLimits;
    skipped: SkipCounts;
    messages: HostMessages;
  },
  absolute: string,
): Promise<ImportResult> {
  const { fs, target, limits, skipped, messages } = args;
  const size = await fileBytesWithin(fs, target, limits.maxSnippetBytes);
  if (size === undefined) {
    skipped.tooLarge += 1;
    return { entries: [], truncated: true, skipped };
  }
  let info: AgentFileInfo | undefined;
  try {
    info = parseAgentFrontmatter(await fs.readText(target));
  } catch {
    skipped.unreadable += 1;
    return { entries: [], truncated: true, skipped };
  }
  if (info === undefined) {
    skipped.unnamed += 1;
    return { entries: [], truncated: false, skipped, error: messages.missingRoleName };
  }
  // 正文为空或围栏未闭合时 agentEntryFromFile 交回 undefined：按 unnamed 计数，并把
  // truncated 置真，让读面知道「有一份没进来」而不是看着 0 条以为库里是空的。
  const entry = agentEntryFromFile(
    stripMdSuffix(path.basename(absolute)),
    path.basename(path.dirname(absolute)),
    info,
    new Set(),
  );
  if (entry === undefined) {
    skipped.unnamed += 1;
    return { entries: [], truncated: true, skipped };
  }
  return { entries: [entry], truncated: false, skipped };
}

/**
 * listDir 的降级读面：列不出来（EACCES / ELOOP / 枚举期间被删）时记 unreadable 并交空表。
 *
 * 为什么必须有：`mapBounded` 内部是 `Promise.all`，worker 一抛就整批 reject，把**同一批
 * 里已经读完的结果一起丢掉**，上层 `collectAgentTemplates` 的 catch 再把整次导入变成
 * 「导入失败」。实测：一个 chmod 000 的子目录就让同层读得好好的 .md 一条都进不来。
 * 文件级读取早就有这道降级（`readCandidate` → `{kind:"unreadable"}`），目录枚举却漏了，
 * 口径不一致；`mapBounded` 自己的注释也写着「worker 自己负责错误降级（不抛）」。
 */
async function listDirOrUnreadable(
  fs: Pick<FsService, "listDir">,
  target: FsTarget,
  skipped: SkipCounts,
): Promise<FsDirEntry[]> {
  try {
    return await fs.listDir(target);
  } catch {
    skipped.unreadable += 1;
    return [];
  }
}

/** 更深层（第三层）目录：只清点可见 .md 数、不读正文——扫描深度是设计上限，
 *  但静默省略是 bug（内置库 game-development/<engine>/*.md 曾整批消失）。
 *  列不出来的深层目录按 unreadable 计数，不让整次导入归零。 */
async function countDeeperMdFiles(
  fs: Pick<FsService, "listDir">,
  deepDirs: readonly FsTarget[],
  readConcurrency: number,
  skipped: SkipCounts,
): Promise<number> {
  const counts = await mapBounded(deepDirs, readConcurrency, async (dir) => {
    const children = await listDirOrUnreadable(fs, dir, skipped);
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
    stripMdSuffix(read.file.name),
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
 *  上层 catch 仍要报出已经数到的那部分。这里的两层形状被 src/ui-messages.ts 的
 *  skipDeeper / importHint（中英四键）写给用户，改扫描深度要同步那四处文案。 */
async function importFromDirectory(
  fs: Pick<FsService, "listDir" | "readText" | "contains">,
  absolute: string,
  target: FsTarget,
  limits: DirScanLimits,
  skipped: SkipCounts,
): Promise<TemplateEntry[]> {
  const rootChildren = await fs.listDir(target);
  // 包含判据一律用**本次导入的根**（target），不是子项的直接父目录：链接进来的子目录
  // 自己的 target 已经在根外，拿它当父判据会把根外的角色文件整批放进来。
  const rootFiles = mdCandidates(fs, target, rootChildren, path.basename(absolute), skipped);
  const subDirs = rootChildren
    .filter((child) => {
      // 链接进来的子目录，其 target 可能已经在根外：枚举它会带出根外的名字与结构
      // （文件正文另有 mdCandidates 的 contains 复判）。不 contained 的按 escaped 记账，
      // 与同层的链接文件同一口径。
      const visible = isVisibleDirectory(child);
      if (!visible) {
        return false;
      }
      const inside = fs.contains(target, child.target);
      if (!inside) {
        skipped.escaped += 1;
      }
      return inside;
    })
    .map((child) => child.target)
    .toSorted((left, right) => left.displayPath.localeCompare(right.displayPath));
  // 子目录 listDir 有界并发（避免 await-in-loop，也避免整库一次性打开打满 fd）：
  // 一次遍历同时产出「该层 .md 候选」与「更深一层的目录」（后者只清点不读）。
  // 逐个降级：列不出来的子目录只自己计 unreadable，不牵连同批已读完的结果。
  const subScans = await mapBounded(subDirs, limits.readConcurrency, async (sub) => {
    const children = await listDirOrUnreadable(fs, sub, skipped);
    return {
      files: mdCandidates(fs, target, children, path.basename(sub.displayPath), skipped),
      deeper: children
        .filter((child) => isVisibleDirectory(child) && fs.contains(target, child.target))
        .map((child) => child.target),
    };
  });
  const subFiles: ImportCandidate[] = [];
  const deepDirs: FsTarget[] = [];
  for (const scan of subScans) {
    subFiles.push(...scan.files);
    deepDirs.push(...scan.deeper);
  }
  const deeperMdCount = await countDeeperMdFiles(fs, deepDirs, limits.readConcurrency, skipped);
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
 *  allowRoots = 设置 importAllowRoots 登记的额外允许目录（由读面注入）。 */
export async function collectAgentTemplates(
  fs: Pick<FsService, "resolve" | "listDir" | "readText" | "contains" | "stat">,
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
  const allowRoots = opts?.allowRoots ?? [];
  const policyError = importGate(requested, cwd, allowRoots, messages, opts?.skipPolicy === true);
  if (policyError !== undefined) {
    return { entries: [], truncated: false, skipped: skipCounts(), error: policyError };
  }
  // 与 importPathError **同一套解析**（策略判定的形状 = 实际读取的形状）：相对路径
  // 在上面已保证 cwd 存在，绝对路径 path.resolve 只做归一，不做第二份语义。
  const absolute = path.resolve(cwd ?? "", requested);
  const skipped = skipCounts();
  try {
    const target = await fs.resolve(absolute);
    // ⚠ 真实目标必须在允许根之内——**单文件与目录两条分支都要过这道**，判据交给后端。
    //
    // 为什么不能只判字符串：`importPathError` 走的是 `path.resolve()` 出来的**字符串段**，
    // 而 `fs.resolve` 给的 targetKey 是 realpath 之后的**真实对象**（installed fsio.ts）。
    // 于是 cwd 里一个 `roles -> /Users/me/.aws/credentials` 的软链目录，
    // 字符串形状「就在 cwd 之内」而真身在所有允许根之外。
    //
    // 这道闸必须同时覆盖单文件与目录两个分支：只挂单文件分支的话，`importFromDirectory` 的
    // `mdCandidates` 拿 `fs.contains(target, child.target)` 当门，而那里的 `target`
    // **就是已经逃逸的那个目录自己**，用它当父判据必然为真，于是根外目录里的 .md
    // 连同正文整批被当成本地角色导入（已用真磁盘 + 符号链接复现：断言「0 条」实得 1 条）。
    // 目录分支原本的 contains 只防「根内的子项被链接到根外」，防不了「根本身是链接」。
    const roots = importRootsOf(cwd, allowRoots, messages);
    if (await escapesAllRoots(fs, target, roots)) {
      skipped.escaped = 1;
      return {
        entries: [],
        truncated: true,
        skipped,
        error: outsideRootsError(target.displayPath, roots, messages),
      };
    }
    if (isMdName(absolute)) {
      return await importFromFile({ fs, target, limits, skipped, messages }, absolute);
    }
    const entries = await importFromDirectory(fs, absolute, target, limits, skipped);
    return {
      entries,
      // unnamed 也必须进这条判据：目录里解析不出 name 的 .md 是**整份没进来**，
      // 漏掉它时用户看到 truncated:false 而实际条目少了一份（单文件分支已单独回原因，
      // 目录分支只能靠这一位告诉卡片「有东西被跳过」）。
      truncated:
        skipped.tooLarge + skipped.unreadable + skipped.deeper + skipped.escaped + skipped.unnamed >
        0,
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

// ── organize（LLM 润色，纯函数便于测试）──────────────────────────────────

export interface OrganizeInput {
  prompt: string;
  cwd: string;
  entriesSummary?: string;
  /** 会话最近对话文本（user/assistant 交替，host 侧从 deriveMessages 提取）。 */
  recentTurns?: string;
  /** 参考角色上下文（提炼自模板正文；可选）。提供时借用该角色的术语与风格润色草稿。 */
  roleText?: string;
  model?: ModelSelection;
}

/** 构造 system 提示（导出供测试）。规则正文与各段标题全部取自注入的字典——
 *  面向模型的 prompt 也随官方 locale 偏好切语言；zh 输出的正文逐字取自该字典。 */
export function buildOrganizeSystem(
  input: Omit<OrganizeInput, "prompt">,
  messages: HostMessages,
): string {
  // ⚠ 信任序：这里只放**宿主自己产生**的内容（规则 + 会话 cwd）。仓库摘要、会话历史、
  // 角色正文一律不进 system——它们是用户仓库里可控的文本，攻击者只要克隆一个仓库、
  // 在某个 .md 里写下「忽略以上规则」，就能借 system 槽的最高信任位改写模型行为。
  // 真正的用户草稿本来就只走 user 消息，把不可信块也放进 user，两者在同一信任层，
  // 谁也冒充不了谁。
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
    messages.sysRuleDataNotInstruction,
    fillTemplate(messages.sysCwdLine, [["{cwd}", singleLine(input.cwd) || messages.sysCwdMissing]]),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * user 消息 = 草稿 + 围栏起来的不可信数据块。
 *
 * 围栏用**成对的定界标记**而不是缩进或横线：模型侧最容易被无视的是「看起来像普通内容」
 * 的标记，而成对标签既显眼、又便于判断边界。
 *
 * ⚠ 标签本身拦不住数据：围栏内容来自用户仓库（目录摘要里的文件名、会话历史、角色 .md
 * 正文），里面完全可能含 `</data>`。原样拼进去会被读成提前闭合，其后的字符就重新落回
 * 指令位——围栏反而把不可信内容送到了它本该隔离的信任层。所以落进围栏的每一段文本都先
 * 把自己的定界标记替换成中性写法，标记只能由本函数产生。
 *
 * @param prompt - 真正的用户草稿
 * @param input - 其余上下文（摘要/历史/角色）
 * @param messages - 注入的字典
 * @returns 交给模型的那条 user 文本
 */
export function buildOrganizeUser(
  prompt: string,
  input: Omit<OrganizeInput, "prompt">,
  messages: HostMessages,
): string {
  // 先去掉数据自带的同类标记再包：只替换开始/结束两枚定界串本身，其余字符逐字保留，
  // 于是丢掉的只是「看起来像围栏」那层伪装，内容本身不变。
  const defused = (line: string): string =>
    line
      .split(messages.sysDataFenceStart)
      .join("[fence-open]")
      .split(messages.sysDataFenceEnd)
      .join("[fence-close]");
  const fenced = (line: string): string =>
    [messages.sysDataFenceStart, defused(line), messages.sysDataFenceEnd].join("\n");
  const blocks = [
    input.entriesSummary !== undefined && input.entriesSummary !== ""
      ? fenced(fillTemplate(messages.sysSummaryLine, [["{summary}", input.entriesSummary]]))
      : "",
    input.recentTurns !== undefined && input.recentTurns !== ""
      ? fenced(fillTemplate(messages.sysRecentTurnsLine, [["{turns}", input.recentTurns]]))
      : "",
    input.roleText !== undefined && input.roleText !== ""
      ? fenced(fillTemplate(messages.sysRoleLine, [["{roleText}", input.roleText]]))
      : "",
  ].filter((part) => part.length > 0);
  return blocks.length === 0 ? prompt : [prompt, "", ...blocks].join("\n");
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

/** 润色入口（读面调用；导出供测试注入假 stream）。失败文案与 system 提示都来自
 *  注入的字典，本函数不读设置。 */
export async function runOrganize(
  llm: LlmService,
  input: OrganizeInput,
  messages: HostMessages,
  timeoutMs: number = ORGANIZE_TIMEOUT_MS,
  // 调用方的可选取消信号（当前读面不传；保留给直接调用方）。
  callerSignal?: AbortSignal,
): Promise<{ content: string }> {
  const { prompt } = input;
  // prompt 在 OrganizeInput 里是必选 string（organize 读面已用 `typeof === "string"` 收敛成
  // 字符串再传入），故无需可选链；空判用显式比较而非真值折叠。
  if (prompt.trim() === "") {
    throw new Error(messages.emptyPrompt);
  }
  const { model } = input;
  // model 可选（未选模型/读不到服务 → undefined）：三个分支都写成显式比较。
  if (model === undefined || model.provider === "" || model.model === "") {
    throw new Error(messages.noModelSelected);
  }
  // request-only 输入：不带 id / source（见文件上方那条注释的三条证据）。自造身份
  // （如 `id: dir-prep-organize-<timestamp>`）宿主侧无人读回。
  const llmMessages: RequestUserInput[] = [
    {
      role: "user",
      content: [{ type: "text", text: buildOrganizeUser(prompt, input, messages) }],
    },
  ];
  const controller = new AbortController();
  // 超时与「调用方取消」共用同一个 controller，所以必须区分成因：两者都让 llm 服务
  // 以 AbortError 收尾，而那条英文串（实测 "This operation was aborted"）不是字典文案，
  // 直接回给用户与「固定文案全部来自字典」的口径不符。timer 自己置位，catch 里据此换成
  // 带 timeoutMs 的字典文案；调用方取消仍原样上抛。
  let timedOut = false;
  // 经函数读：直接 `if (timedOut)` 时类型检查把它收窄成字面量 false（赋值在另一个
  // 回调里，tsc 看不见），于是那条判据会被判成「恒假」的死分支。经函数返回的
  // boolean 不再收窄。
  const hasTimedOut = (): boolean => timedOut;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // 调用方主动取消也要中止：没有这条，一次已放弃的润色会继续烧满整个超时窗口和
  // 一份真实 token 账单，而响应反正没人收。abort 监听用 once + finally 里摘除，
  // 免得在长驻的宿主进程里给每次请求留一个悬挂监听。
  // （当前读面不传 callerSignal：客户端超时只放弃等待，宿主仍由自己的 timer 收口。）
  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  try {
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
      messages: llmMessages,
      // system 只拿会话 cwd：目录摘要、会话历史、角色正文都由 buildOrganizeUser 放进
      // user 消息的围栏块（信任序见 buildOrganizeSystem 与 buildOrganizeUser 的注释）。
      // 这里不要再把三者折进来——buildOrganizeSystem 根本不读它们，写了是空透传，
      // 读起来像"角色/摘要在 system 里"，正好把信任序读反。
      system: buildOrganizeSystem({ cwd: input.cwd }, messages),
      signal: controller.signal,
    });
    const content = await drainStreamToText(stream, messages);
    if (content.length === 0) {
      throw new Error(messages.emptyOrganizeResult);
    }
    return { content };
  } catch (error: unknown) {
    // 只有「本函数的 timer 到点」才换成字典文案；调用方取消（callerSignal）与流自身的
    // 别的失败都原样上抛——把取消也说成超时会让界面报错指向错的成因。
    if (hasTimedOut()) {
      const seconds = String(Math.round(timeoutMs / 1000));
      throw new Error(fillTemplate(messages.organizeTimeout, [["{seconds}", seconds]]), {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

// ── 模板 settings（隐式注册 + volatile 字段）───────────────────────────────

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
 *  写入校验由 dsh-settings 在持久化前按此 schema 完成；凡是要出现在卡上的字段都必须 `.volatile()`
 *  ——没有任何 volatile 字段的条目会被宿主 describe() 整条跳过
 *  （packages/settings/settings/src/index.ts），设置卡读不到、写入则抛
 *  `has no volatile fields`。
 *
 *  旧 `settings.register(ns, Config, { base })` 的 base 底座取消，逐字段落到 `.default(...)`：
 *  - importAllowRoots：`.default([])`。**空表是策略不是缺省占位**——登记目录是用户的
 *    显式信任动作，除会话 cwd 与内置角色库外默认不放行任何绝对路径（fail-closed，
 *    见 importPathError）；
 *  - templates：**标 volatile、不给默认**。内置精选集（scripts/gen-defaults.mjs 从
 *    agents/ 角色库生成的 src/default-templates.generated.ts，~640 KB）由 **host 半**
 *    持有、经 `dirPrepOrganize.defaults` 方法按需下发，client 拉到后作回落：⚠ 不给默认**不等于**读回 undefined——schemastery 对 array 字段把缺失
 *    值 cast 成 `[]`（实测 `configSchema["~standard"].validate({})` 之后 `templates` 引用
 *    `.get() === []`），宿主 describe() 又只丢 undefined 位（`SettingsForms.projectForm`），
 *    所以「未设置」递到客户端看到的就是一张空表。回落判据因此落在 client 半
 *    （client-entry.ts 的 `fromSettings`：空表按未设置处理），设置卡「恢复默认」=
 *    `unset("templates")` 且复读空值按已回落处理，故「缺失」「空表」「内置」三者同义。
 *    写成 `.default(...)` 会让宿主每次 describe() 都重新序列化这 640 KB（index.ts 对
 *    `JSON.stringify([uid, schema.toJSON(), entry.options.config])` 取指纹，schema.ts
 *    的 plainSchema 保留 meta.default），所以内置集不进 schema、由 host 半端点按需下发；而既然空表就是
 *    「未设置」的运行时形状，回落判据仍由 client 半出。 */
const configShape = {
  templates: Schema.array(TemplateEntrySchema).volatile(),
  importAllowRoots: Schema.array(Schema.string()).default([]).volatile(),
  // ── Config 化（默认与原模块常量同值；部署间可能想配不同值的
  // 必须是配置字段）。organizeTimeoutMs **volatile 上卡**：客户端 fetch 超时要与它
  // 保持同源（host 先超时、客户端留 5s 余量），而 client 半唯一能读到的就是
  // configForms 快照的 volatile 位；另两位是 host 侧部署假定值（非 volatile，不占卡）。
  organizeTimeoutMs: Schema.natural().default(ORGANIZE_TIMEOUT_MS).volatile(),
  maxSnippetBytes: Schema.natural().default(MAX_SNIPPET_BYTES),
  readConcurrency: Schema.natural().default(READ_CONCURRENCY),
};

// 注解写 `ReturnType<typeof Schema.object<typeof configShape>>` 而不是让它推断：schemastery 的
// `object` 返回类型是 `ObjectS<X> & Dict`，那个 `Dict` 来自 @deepseek-ai/cosmokit——cosmokit 不是
// 本包的依赖，声明文件一旦点名它，pnpm 严格布局下消费方根本解析不到（TS2883 会直接拒绝产出
// host.d.ts，表现为整个入口的声明文件缺失）。dict 单独起常量，是为了让 `typeof configShape`
// 有名字可引——内联对象字面量没有。
const configSchema: ReturnType<typeof Schema.object<typeof configShape>> =
  Schema.object(configShape);

/** cordis 校验过 configSchema 后交进 apply 的那份配置：volatile 字段以 Volatile 引用
 *  形态进来，读当前值一律 `.get()`（改设置不必重挂载插件）。
 *  ⚠ templates 的形参写 `| undefined` 只是留口：实测**未设置时 `.get()` 给的是 `[]`**
 *  （schemastery 对 array 的 cast，见上方 configSchema 注释），而 host 半从不读这一位
 *  （它只把 schema 交给设置卡），回落由 client 半判。 */
export interface Config {
  templates: Volatile<TemplateEntry[] | undefined>;
  importAllowRoots: Volatile<string[]>;
  /** LLM 润色中止时限（volatile：客户端经 configForms 快照同源读取）。 */
  organizeTimeoutMs: Volatile<number>;
  /** 关键文件摘要的单文件字节上限（超出整份跳过）。 */
  maxSnippetBytes: number;
  /** 目录扫描/读取的有界并发度。 */
  readConcurrency: number;
}

export { configSchema as Config };

/** volatile 引用读出的值 → importAllowRoots 字符串列表（纯函数，测试锁死）。
 *  引用背后可能是存量脏配置：非数组一律空表（fail-closed），非字符串/纯空白项逐个
 *  丢弃——绝不能把非字符串塞进路径校验，也不能让空串变成"允许 process.cwd()"。
 *  相对路径同样丢弃：契约写的是「额外允许的**绝对**目录」（见 schema describe 与 DETAIL
 *  文档），放进来会被 toImportRoot 的 path.resolve 按**宿主进程 cwd** 解析，变成一条用户
 *  没写过、也不知道存在着的允许根。 */
export function importAllowRootsOf(raw: unknown): string[] {
  const roots: string[] = [];
  // 同一目录的等价写法（末尾分隔符、`.`/`..` 段）在设置卡里是多行，但运行期只该算
  // 一枚根：否则每次导入都会重复 resolve 同一棵树，越界回执也会把同义项各列一遍。
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim().length > 0 && path.isAbsolute(item.trim())) {
        // resolve 同时去掉末尾分隔符（normalize 在 POSIX 上会保留 `/a/b/`）。
        const normalized = path.resolve(item.trim());
        if (!seen.has(normalized)) {
          seen.add(normalized);
          roots.push(normalized);
        }
      }
    }
  }
  return roots;
}

// ── 插件主体 ───────────────────────────────────────────────────────────────

/** 注入的服务面：settings 为硬依赖（cordis 等它就绪才 apply）。
 *  命名空间是隐式的（= 本条目在 cordis.patch.yml 里的裸 id，可编辑字段取自
 *  导出的 Config），所以 settings 在这里的职责是「页面策略（configure）与跨命名空间读
 *  （describe）」，而非「注册的前提」；设置页只派发「host 已 serve 的命名空间 ∩
 *  settings.plugin.item 卡」（dsh-client-ui-settings-plugins 源码语义），configure 必须
 *  发生在 apply 期，故仍硬注入。sessions/fs/llm/agentDefaultModel 仍可选读。 */
export const inject = ["settings"];

/** 读面依赖的可测提取：apply 用 ctx.get 的惰性 getter 调用（服务可能在读面
 *  注册后才就绪），测试可直接注入静态假服务。 */
export interface RouteDeps {
  sessions?: () => SessionsService | undefined;
  fs?: () => FsService | undefined;
  llm?: () => LlmService | undefined;
  agentDefaultModel?: () => AgentDefaultModel | undefined;
  /** 会话活线：有活 Agent 时润色跟随它的模型，没有才回落默认模型。 */
  agents?: () => AgentsService | undefined;
  /** 设置里登记的额外导入允许根（每次请求现读，改设置无需重启）。 */
  importAllowRoots?: () => readonly string[];
  /** 部署值（Config 化）：润色超时 / 摘要字节上限 / 读取并发。
   *  缺省回落原模块常量（与 schema .default 同值）——测试与旧调用方不必逐一改。 */
  limits?: () => RouteLimits;
  /** 内置精选模板表的取数口。缺省走按需 import 产物；测试替掉它即可覆盖载入失败那条回执，
   *  而不必去改磁盘上那份产物（它的 URL 一旦被加载过就进了 Node 的 ESM 缓存，改了也没用）。 */
  loadDefaultTemplates?: () => Promise<readonly TemplateEntry[]>;
}

/** 回执字典的现读 getter：每个请求取一次，用户在「设置 → 常规」改语言后下一个请求即
 *  切文案（不重启、不加插件自己的 locale 设置项；与 importAllowRoots 的现读同构）。 */
export type MessagesOf = () => HostMessages;

/** 会话活线模型：新版读 `agent.model.current()`（含待切换选择），旧版回落
 *  `agent.options`。没有活 Agent、或两处都答不全时 undefined（调用方回落默认模型）。
 *  与 rescue 同一条规则：`current()` 交回 undefined 是「还没记录过选择」，不是读失败。 */
export function liveModelOf(deps: RouteDeps, sessionId: string | null): ModelSelection | undefined {
  const agent = sessionId === null ? undefined : deps.agents?.()?.get(sessionIdOf(sessionId));
  const selected = agent?.model?.current();
  const raw = selected ?? agent?.options;
  const result =
    raw !== undefined &&
    typeof raw.provider === "string" &&
    raw.provider.length > 0 &&
    typeof raw.model === "string" &&
    raw.model.length > 0
      ? {
          provider: raw.provider,
          model: raw.model,
          ...(raw.reasoningEffort === undefined ? {} : { reasoningEffort: raw.reasoningEffort }),
        }
      : undefined;
  return result;
}

/** 当前默认模型解析（缺服务/抛错 → undefined）。 */
function defaultModelOf(deps: RouteDeps): ModelSelection | undefined {
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
      /* 读取模型选择失败 → 按未选模型处理（organize 会据此报错） */
    }
  }
  return result;
}

/** 润色的模型来源：会话活线优先，没有才用默认模型。 */
function resolveModel(deps: RouteDeps, sessionId: string | null): ModelSelection | undefined {
  return liveModelOf(deps, sessionId) ?? defaultModelOf(deps);
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

/** importTemplates 请求体的输入面（纯函数，测试锁死）：坏输入按顺序判别——path
 *  非字符串先于"纯空白 path"，两者各带自己的状态码与文案。 */
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
 *  path 缺失/非字符串 → 直接拒（把它当成"留空"就是一个写坏字段的请求静默导入
 *  整个内置库——越界与坏输入都不许降级成"更多权限"）；只含空白字符的串同样
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

/** 读面每次调用的共享面：服务 getter 与现读文案/限额。 */
interface RemoteScope {
  readonly deps: RouteDeps;
  readonly messagesOf: MessagesOf;
  readonly limitsOf: () => RouteLimits;
}

/** 内置精选模板表的读面。两头都按需：表在独立产物 templates.data.mjs 里，第一次被
 *  调用时才 import；client 首次打开「模板」下拉时才拉这一发。 */
async function defaultsPayload(scope: RemoteScope): Promise<Record<string, unknown>> {
  try {
    const loadTemplates = scope.deps.loadDefaultTemplates ?? loadDefaultTemplates;
    return { ok: true, templates: await loadTemplates() };
  } catch (error: unknown) {
    // 载入失败只有一个成因：产物没跟着包发出去（files 漏了 templates.data.mjs，或
    // 装了旧版本）。按本仓约定回 ok:false，理由原文带出去便于定位。
    return { ok: false, error: errorText(error) };
  }
}

/** 目录上下文：缺 fs / 缺 cwd / 扫描报错各回一句，成功才下发条目表。 */
async function contextPayload(
  scope: RemoteScope,
  sessionId: string | null,
): Promise<Record<string, unknown>> {
  const messages = scope.messagesOf();
  try {
    const fs = scope.deps.fs?.();
    const cwd = cwdOfSession(scope.deps.sessions?.(), sessionId);
    if (fs === undefined) {
      return { ok: false, error: messages.fsUnavailable };
    }
    if (cwd === undefined) {
      return { ok: false, error: messages.cwdUnknown };
    }
    const result = await collectDirContext(fs, cwd, messages, scope.limitsOf());
    if (result.error !== undefined) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      cwd: result.cwd,
      truncated: result.truncated,
      skipped: result.skipped,
      entries: result.entries.map((entry) => ({
        name: entry.name,
        isDir: entry.isDir,
        sizeBytes: entry.sizeBytes,
        snippet: entry.snippet,
      })),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: fillTemplate(messages.collectFailed, [["{reason}", errorText(error)]]),
    };
  }
}

/** 当前默认模型（provider/model/effort）。 */
function modelPayload(scope: RemoteScope): Record<string, unknown> {
  const messages = scope.messagesOf();
  const agentDefaultModel = scope.deps.agentDefaultModel?.();
  if (agentDefaultModel === undefined) {
    return { ok: false, error: messages.modelServiceUnavailable };
  }
  try {
    const sel = agentDefaultModel.currentSelection();
    return {
      ok: true,
      provider: sel.provider,
      model: sel.model,
      ...(sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort }),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: fillTemplate(messages.readModelFailed, [["{reason}", errorText(error)]]),
    };
  }
}

/** organize 请求体的输入面：JSON 已解析的 unknown → 润色入参（非字符串一律按空值处理）。 */
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

/** 润色：LLM 调用与两层错误回执。内层 catch 是「润色过程本身失败」（回裸 errorText），
 *  外层是「装配入参时炸」。`messages` 每次调用现读一次，不在此处二次现读。 */
async function organizePayload(
  scope: RemoteScope,
  parsed: unknown,
): Promise<Record<string, unknown>> {
  const messages = scope.messagesOf();
  try {
    const llm = scope.deps.llm?.();
    if (llm === undefined) {
      return { ok: false, error: messages.llmUnavailable };
    }
    // JSON 返回 any：经 unknown 后用 isRecord 投影，不经 `as typeof body` 断言。
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
      return { ok: false, error: messages.cwdUnknown };
    }
    const model = resolveModel(scope.deps, sessionIdText);
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
      return { ok: true, content: result.content };
    } catch (error: unknown) {
      return { ok: false, error: errorText(error) };
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: fillTemplate(messages.organizeFailed, [["{reason}", errorText(error)]]),
    };
  }
}

/** 导入：路径策略拒绝单独回 4xx，导入过程本身失败回 ok:false（界面读同一句原因）。
 *  `messages` 同 organize：字典取表一次调用一次。 */
async function importPayload(
  scope: RemoteScope,
  parsed: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const messages = scope.messagesOf();
  try {
    const fs = scope.deps.fs?.();
    if (fs === undefined) {
      return { status: 200, body: { ok: false, error: messages.fsUnavailable } };
    }
    const request = importRequestOf(parsed, messages);
    if (request.rejected) {
      return { status: request.status, body: { ok: false, error: request.error } };
    }
    const allowRoots = scope.deps.importAllowRoots?.() ?? [];
    const cwd = cwdOfSession(scope.deps.sessions?.(), request.sessionId);
    // 越界/非法段单独回 4xx（策略拒绝不是"导入过程失败"，让调用方与日志能按
    // 状态码区分；响应体仍是 {ok:false,error}，界面读得到同一句原因）。
    if (!request.isBuiltin) {
      const policyError = importPathError(request.requested, cwd, allowRoots, messages);
      if (policyError !== undefined) {
        return { status: 403, body: { ok: false, error: policyError } };
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
      return { status: 200, body: { ok: false, error: result.error } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        count: result.entries.length,
        truncated: result.truncated,
        skipped: result.skipped,
        entries: result.entries,
      },
    };
  } catch (error: unknown) {
    return {
      status: 200,
      body: {
        ok: false,
        error: fillTemplate(messages.importException, [["{reason}", errorText(error)]]),
      },
    };
  }
}

/** 五个读面的纯载荷入口（服务与测试共用）：不含任何传输层判定。 */
export function createRemotePayloads(
  deps: RouteDeps,
  messagesOf: MessagesOf,
): {
  defaults: () => Promise<Record<string, unknown>>;
  context: (sessionId: string | null) => Promise<Record<string, unknown>>;
  model: () => Record<string, unknown>;
  organize: (parsed: unknown) => Promise<Record<string, unknown>>;
  importTemplates: (parsed: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
} {
  const scope: RemoteScope = {
    deps,
    messagesOf,
    limitsOf: () => sanitizeLimits(deps.limits?.() ?? DEFAULT_LIMITS),
  };
  return {
    defaults: () => defaultsPayload(scope),
    context: (sessionId) => contextPayload(scope, sessionId),
    model: () => modelPayload(scope),
    organize: (parsed) => organizePayload(scope, parsed),
    importTemplates: (parsed) => importPayload(scope, parsed),
  };
}

/** 官方 Typert Remote 的服务键（= 线上命名空间）。 */
export const DIR_PREP_REMOTE_NAMESPACE = "dirPrepOrganize";

interface ContextRequest {
  sessionId: string;
}

interface OrganizeRequest extends ContextRequest {
  prompt: string;
  entriesSummary: string;
  roleText?: string;
}

interface ImportTemplatesRequest {
  path: string;
  sessionId: string;
}

/**
 * 设置卡的宿主读面（官方 Typert Remote）：目录上下文、当前模型、润色、导入与内置模板。
 * 本包不自建 HTTP 端点，认证与分派由宿主 /api 网关负责。
 */
export class DirPrepRemoteService extends TypertRemoteService {
  private readonly scope: RemoteScope;

  public constructor(ctx: Context, scope: RemoteScope) {
    super(ctx, DIR_PREP_REMOTE_NAMESPACE);
    this.scope = scope;
  }

  public async defaults(): Promise<Record<string, unknown>> {
    return defaultsPayload(this.scope);
  }

  public async context(request: ContextRequest): Promise<Record<string, unknown>> {
    const sessionId =
      isRecord(request) && typeof request.sessionId === "string" ? request.sessionId : null;
    return contextPayload(this.scope, sessionId);
  }

  public model(request: ContextRequest): Record<string, unknown> {
    void request;
    return modelPayload(this.scope);
  }

  public async organize(request: OrganizeRequest): Promise<Record<string, unknown>> {
    return organizePayload(this.scope, request);
  }

  public async importTemplates(request: ImportTemplatesRequest): Promise<Record<string, unknown>> {
    const result = await importPayload(this.scope, request);
    return result.status === 200 ? result.body : { ...result.body, status: result.status };
  }
}

/** 标准装饰器的程序化调用：标记落到真正的原型上，源码不引装饰器语法。 */
function markRemote(prototype: DirPrepRemoteService, methodName: string): void {
  const context = {
    kind: "method",
    name: methodName,
    static: false,
    private: false,
    addInitializer: (initializer: (this: unknown) => void): void => {
      Reflect.apply(initializer, Object.create(prototype), []);
    },
  };
  // oxlint-disable-next-line eslint/new-cap -- `Remote(…)` 是装饰器工厂，不是大写开头的构造调用
  const decorate = Remote(methodName);
  Reflect.apply(decorate, undefined, [Reflect.get(prototype, methodName), context]);
}

markRemote(DirPrepRemoteService.prototype, "defaults");
markRemote(DirPrepRemoteService.prototype, "context");
markRemote(DirPrepRemoteService.prototype, "model");
markRemote(DirPrepRemoteService.prototype, "organize");
markRemote(DirPrepRemoteService.prototype, "importTemplates");

/** 注册读面（构造即注册）；替身上下文没有注册口时只少掉这一栏。 */
export function installDirPrepRemote(ctx: Context, scope: RemoteScope): boolean {
  if (!isRecord(ctx) || !isRecord(ctx.reflect) || typeof ctx.reflect.provide !== "function") {
    return false;
  }
  // oxlint-disable-next-line eslint/no-new -- 构造即注册；Service 构造只读 reflect/provide
  new DirPrepRemoteService(ctx, scope);
  return true;
}

/** settings 注册的占位清理（无额外拆卸动作，注册随插件生命周期存续）。 */
function noopDisposer(): void {
  /* 占位：无需清理 */
}

/** host apply：登记设置页策略 + 注册官方 Remote 读面（注入子上下文，卸载即撤）。
 *  模板设置是**隐式注册**的（导出的 Config + 字段上的 .volatile()），本函数
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
  // 下一个请求即切文案；不重启、也不加本插件自己的 locale 设置项）。跨命名空间读只剩
  // describe() 一条路：全部条目的表单投影里挑 ns === 'locale' 那条的 value。
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
  // 读面走官方 Typert Remote：经注入子上下文注册。没有 remote 网关的宿主只是设置卡
  // 读不到数据面，目录润色与模板这两项能力本身只依赖 settings 与 fs，照常可用。
  // 各服务经惰性 getter + 形状守卫投影（服务可能晚于本条目就绪；替代 `svc.get(...) as X`）。
  // 部署值：每次请求现读（volatile 位 .get()；非 volatile 位直读普通值）。
  const limitsOfConfig = (): RouteLimits => ({
    organizeTimeoutMs: config.organizeTimeoutMs.get(),
    maxSnippetBytes: config.maxSnippetBytes,
    readConcurrency: config.readConcurrency,
  });
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
    agents: () => {
      const service = getService("agents");
      return isAgentsService(service) ? service : undefined;
    },
    // 导入允许根：每次请求现读 volatile 引用（改设置不必重启插件）。引用背后仍可能
    // 是存量脏配置，故过 importAllowRootsOf 收成字符串表——读不到就是空表，绝不因为
    // 缺配置就放开绝对路径（只剩「会话 cwd + 内置角色库」两个根）。
    importAllowRoots: () => importAllowRootsOf(config.importAllowRoots.get()),
    // 部署值：每次请求现读（volatile 位 .get()；非 volatile 位直读普通值）。
    limits: limitsOfConfig,
  };
  const scope: RemoteScope = {
    deps,
    messagesOf: localeMessages,
    limitsOf: () => sanitizeLimits(limitsOfConfig()),
  };
  ctx.inject([], (child) => {
    installDirPrepRemote(child, scope);
  });
}
