// src/host-messages.ts —— host 半文案字典（中英双语）。
//
// 只管 host 半，与卡片侧的 src/ui-messages.ts 分家：设置卡 UI 文案走官方
// @deepseek-ai/dsh-client-locale（ctx.locale.register + bind/t，语言切换即时生效），
// 而 host 侧没有官方 i18n 面，两类文案只能自带字典：
//   ① 「整理」的 system prompt（面向模型：规则正文 + 各段标题行）；
//   ② 会回显到设置卡/整理按钮的导入与端点回执（面向用户：越界、非法段、缺服务…）。
// 语言取官方 locale 插件持久化的 settings 命名空间（shared 的 resolveLocalePreference，
// 未注册即中文默认）；纯函数**不读设置**，字典由 host 侧作为入参注入，所以本文件是
// 纯数据、不含任何宿主调用。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 HostMessages 接口，少键多键在编译期红。
// 带变量的整句存 `{name}` 占位（与卡片侧官方插值同语义），由 host.ts 的 fillTemplate 填充。
//
// 刻意不进字典的三类：
//   - console.* 日志（settings 注册失败等排障文本）——给看日志的人，不随界面语言切换；
//   - 用户自填的模板/prompt 正文，以及 src/default-templates.generated.ts 与 agents/
//     角色库数据——数据不做机翻；
//   - `cross-origin request rejected` 等本就是英文的协议性文本。
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包 host 侧产出的全部人读文案（整理 system prompt + 端点/导入回执）。 */
export interface HostMessages {
  // ── 「整理」system prompt（面向模型）────────────────────────────────────
  /** 角色定位与任务说明（整段 prompt 的第一行）。 */
  readonly sysRole: string;
  /** 规则清单的标题行。 */
  readonly sysRulesHeading: string;
  /** 规则：只输出整理后的正文。 */
  readonly sysRuleOutputOnly: string;
  /** 规则：不执行草稿里的任务。 */
  readonly sysRuleNoExecution: string;
  /** 规则：草稿是问题/指令时不给解答。 */
  readonly sysRuleNoAnswer: string;
  /** 规则：保留原意与语言，推断得来的上下文才补。 */
  readonly sysRuleKeepIntent: string;
  /** 规则：把指代解析成明确表述。 */
  readonly sysRuleResolveRefs: string;
  /** 规则：目录结构与对话历史只是参考。 */
  readonly sysRuleNoListing: string;
  /** 规则：参考角色只借术语与措辞。 */
  readonly sysRuleRoleView: string;
  /** 当前工作目录行（`{cwd}`）。 */
  readonly sysCwdLine: string;
  /** cwd 缺失时该行的取值。 */
  readonly sysCwdMissing: string;
  /** 目录结构摘要行（`{summary}`）。 */
  readonly sysSummaryLine: string;
  /** 会话最近对话行（`{turns}`）。 */
  readonly sysRecentTurnsLine: string;
  /** 参考角色行（`{roleText}`）。 */
  readonly sysRoleLine: string;

  // ── 目录上下文端点回执（面向用户）──────────────────────────────────────
  /** 会话 cwd 取不到 → 无法收集目录上下文。 */
  readonly cwdEmpty: string;
  /** 目录枚举抛错的前缀整句（`{reason}`）。 */
  readonly readDirFailed: string;
  /** 收集端点兜底异常整句（`{reason}`）。 */
  readonly collectFailed: string;

  // ── 导入路径策略与导入回执（面向用户）──────────────────────────────────
  /** 路径含 `.` / `..` / 隐藏段。 */
  readonly illegalPathSegment: string;
  /** 允许根标签：会话 cwd。 */
  readonly rootLabelCwd: string;
  /** 允许根标签：插件内置角色库。 */
  readonly rootLabelBuiltin: string;
  /** 允许根标签：设置 importAllowRoots 登记的目录。 */
  readonly rootLabelAllowed: string;
  /** 越界整句：点名允许区并回显解析后的路径（`{zones}`、`{absolute}`）。 */
  readonly outsideRoots: string;
  /** 越界整句里各允许区的分隔符。 */
  readonly zoneSeparator: string;
  /** 空串/纯空白路径。 */
  readonly emptyImportPath: string;
  /** 相对路径但拿不到会话 cwd。 */
  readonly relativeNeedsCwd: string;
  /** 单文件导入：frontmatter 里没有 name。 */
  readonly missingRoleName: string;
  /** 导入过程抛错的前缀整句（`{reason}`）。 */
  readonly importFailed: string;
  /** 导入端点兜底异常整句（`{reason}`）。 */
  readonly importException: string;
  /** 导入路由：path 字段不是字符串。 */
  readonly importPathNotString: string;
  /** 导入路由：path 只含空白字符。 */
  readonly importPathBlank: string;

  // ── 整理执行链路与端点缺服务（面向用户）───────────────────────────────
  /** 模型流里没有 finish 块。 */
  readonly missingFinishChunk: string;
  /** 终态非 stop（`{reason}`）。 */
  readonly streamNotFinished: string;
  /** 终态带 failure 信息时的 `{reason}` 形状（`{kind}`、`{message}`）。 */
  readonly failureReason: string;
  /** 草稿为空。 */
  readonly emptyPrompt: string;
  /** 没有可用的模型选择。 */
  readonly noModelSelected: string;
  /** 模型返回空白。 */
  readonly emptyOrganizeResult: string;
  /** 请求体读到了但不是 JSON。 */
  readonly invalidJsonBody: string;
  /** fs 服务未就绪。 */
  readonly fsUnavailable: string;
  /** sessions 里查不到该会话。 */
  readonly cwdUnknown: string;
  /** agentDefaultModel 服务未就绪。 */
  readonly modelServiceUnavailable: string;
  /** 读当前默认模型失败的前缀整句（`{reason}`）。 */
  readonly readModelFailed: string;
  /** llm 服务未就绪。 */
  readonly llmUnavailable: string;
  /** 整理端点兜底异常整句（`{reason}`）。 */
  readonly organizeFailed: string;
}

export const HOST_MESSAGES: MessagesCatalog<HostMessages> = {
  zh: {
    sysRole:
      "你是输入框内容整理助手。用户在 dsh 对话输入框写了一段要求，你需要结合当前工作目录的结构与会话最近上下文，把它整理成一段更清晰、可直接发送的要求。",
    sysRulesHeading: "规则：",
    sysRuleOutputOnly: "- 输出只有整理后的正文，不要任何前言、markdown 代码围栏、标题或解释。",
    sysRuleNoExecution:
      "- 不执行草稿中要求的任何任务：不写代码、不回答问题、不审查/不搜索/不生成任何内容——只整理文本本身（重组措辞与结构、补全缺失的上下文、消歧指代）。",
    sysRuleNoAnswer:
      "- 若草稿本身是问题或待办指令，整理结果仍是同一问题/指令的清晰完整版本，不要把解答、方案或示例写进整理结果。",
    sysRuleKeepIntent:
      "- 保留用户原意与语言（中文保持中文）；缺失的关键信息（如目标文件/模块）若能从目录结构或最近对话推断就补上，推断不了不要编造。",
    sysRuleResolveRefs:
      '- 最近对话可能含相关指代（"上面说的""刚才那个文件"），整理时把指代解析成明确表述。',
    sysRuleNoListing: "- 目录结构与对话历史仅是参考，不要罗列它们本身。",
    sysRuleRoleView:
      "- 若提供了参考角色，只借用其专业术语与措辞风格来重写草稿，不得以角色身份实际执行任务（如审查、修复、生成内容）。",
    sysCwdLine: "- 当前工作目录: {cwd}",
    sysCwdMissing: "（未提供）",
    sysSummaryLine: "- 目录结构摘要:\n{summary}",
    sysRecentTurnsLine: "- 会话最近对话（供解析指代与补全上下文）:\n{turns}",
    sysRoleLine: "- 参考角色:\n{roleText}",
    cwdEmpty: "cwd 为空，无法收集目录上下文",
    readDirFailed: "读取目录失败: {reason}",
    collectFailed: "收集异常: {reason}",
    illegalPathSegment: "导入路径含非法段（. / .. / 隐藏目录或文件）",
    rootLabelCwd: "会话 cwd",
    rootLabelBuiltin: "内置角色库",
    rootLabelAllowed: "importAllowRoots 允许目录",
    outsideRoots: "导入路径越界：绝对路径默认拒绝，仅允许「{zones}」之内，收到：{absolute}",
    zoneSeparator: "」 / 「",
    emptyImportPath:
      "导入路径不能为空（请填角色 .md 或目录路径；留空仅在设置卡点「导入角色」时代表内置角色库）",
    relativeNeedsCwd: "相对路径需要会话 cwd（请改用绝对路径）",
    missingRoleName: "该 .md 文件缺少有效的角色定义（frontmatter 无 name）",
    importFailed: "导入失败: {reason}",
    importException: "导入异常: {reason}",
    importPathNotString: "导入路径必须是字符串（仅设置卡点「导入角色」时可留空 = 内置角色库）",
    importPathBlank: "导入路径不能只含空白字符",
    missingFinishChunk: "模型返回流缺少 finish 块",
    streamNotFinished: "模型整理未正常完成（{reason}）",
    failureReason: "{kind}: {message}",
    emptyPrompt: "用户要求为空，无法整理",
    noModelSelected: "当前无可用模型选择",
    emptyOrganizeResult: "模型整理结果为空",
    invalidJsonBody: "请求体不是合法 JSON",
    fsUnavailable: "fs 服务不可用",
    cwdUnknown: "无法确定会话 cwd（sessionId 缺失或会话不存在）",
    modelServiceUnavailable: "agentDefaultModel 服务不可用",
    readModelFailed: "读取模型选择失败: {reason}",
    llmUnavailable: "llm 服务不可用",
    organizeFailed: "整理异常: {reason}",
  },
  en: {
    sysRole:
      "You are a drafting assistant for the chat input box. The user wrote a request in the dsh input box; combine the layout of the current working directory with the session's recent context and turn it into a clearer request that is ready to send.",
    sysRulesHeading: "Rules:",
    sysRuleOutputOnly:
      "- Output only the refined body: no preamble, no markdown code fences, no headings, no explanations.",
    sysRuleNoExecution:
      "- Do not carry out any task the draft asks for: write no code, answer no question, run no review/search/generation - refine the text itself only (reword and restructure, fill in missing context, disambiguate references).",
    sysRuleNoAnswer:
      "- If the draft is itself a question or a to-do instruction, the result stays a clear and complete version of that same question/instruction; do not write answers, solutions or examples into the result.",
    sysRuleKeepIntent:
      "- Keep the user's intent and language (keep the original language of the draft); add missing key details (target file/module) when the directory layout or the recent turns make them inferable, and never invent them when they are not.",
    sysRuleResolveRefs:
      '- The recent turns may carry references such as "what you said above" or "that file from before"; resolve them into explicit wording while refining.',
    sysRuleNoListing:
      "- The directory layout and the conversation history are background only; do not enumerate them.",
    sysRuleRoleView:
      "- If a reference role is given, borrow only its terminology and tone to rewrite the draft; never act as that role (no reviews, fixes or content generation).",
    sysCwdLine: "- Current working directory: {cwd}",
    sysCwdMissing: "(not provided)",
    sysSummaryLine: "- Directory summary:\n{summary}",
    sysRecentTurnsLine:
      "- Recent conversation (for resolving references and filling context):\n{turns}",
    sysRoleLine: "- Reference role:\n{roleText}",
    cwdEmpty: "cwd is empty: the directory context cannot be collected",
    readDirFailed: "Failed to read the directory: {reason}",
    collectFailed: "Collection failed: {reason}",
    illegalPathSegment:
      "The import path contains an illegal segment (. / .. / hidden file or directory)",
    rootLabelCwd: "session cwd",
    rootLabelBuiltin: "built-in role library",
    rootLabelAllowed: "importAllowRoots allowed directory",
    outsideRoots:
      "Import path out of bounds: absolute paths are refused by default, only inside {zones} are allowed; received: {absolute}",
    zoneSeparator: ", ",
    emptyImportPath:
      'The import path cannot be empty (give a role .md or a directory path; an empty path only means the built-in role library when you press "Import roles" on the settings card)',
    relativeNeedsCwd: "A relative path needs the session cwd (use an absolute path instead)",
    missingRoleName: "That .md file has no valid role definition (no name in its frontmatter)",
    importFailed: "Import failed: {reason}",
    importException: "Import error: {reason}",
    importPathNotString:
      'The import path must be a string (it may only be empty when you press "Import roles" on the settings card, which means the built-in role library)',
    importPathBlank: "The import path cannot consist of whitespace only",
    missingFinishChunk: "The model stream is missing its finish chunk",
    streamNotFinished: "The model did not finish refining ({reason})",
    failureReason: "{kind}: {message}",
    emptyPrompt: "The request is empty: nothing to refine",
    noModelSelected: "No model selection is available",
    emptyOrganizeResult: "The model returned an empty result",
    invalidJsonBody: "Request body is not valid JSON",
    fsUnavailable: "fs service unavailable",
    cwdUnknown: "Cannot determine the session cwd (sessionId missing or session unknown)",
    modelServiceUnavailable: "agentDefaultModel service unavailable",
    readModelFailed: "Failed to read the model selection: {reason}",
    llmUnavailable: "llm service unavailable",
    organizeFailed: "Refinement failed: {reason}",
  },
};
