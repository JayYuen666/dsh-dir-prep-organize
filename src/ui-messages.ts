// src/ui-messages.ts —— 设置卡 UI 文案字典（中英双语）。
//
// 键集一致由 tsc 保证：zh / en 两份都标注同一个 UiMessages 接口，少键多键在编译期红。
// 注册与取值走官方 @deepseek-ai/dsh-client-locale 的**类型化** register（两语一次性交
// `Record<BuiltInLocaleId, LocaleDictOf<NS>>`）+ bind(ns)，语言切换由宿主驱动、无需重载
// 页面（见 client-entry.ts 的 apply）。
// 带变量的整句用官方 Translate 的 `{name}` 插值（宿主同语义），不再手工拼串。
//
// 覆盖面：设置卡 + 输入框旁「润色」「模板」两个 dock 按钮（组件经注册项 `locale: NS`
// 声明拿框架合成的 `t` seat，注册 label 用 thunk 跟随活动语言——见 client-entry.ts 的
// apply）。刻意不进字典的两类：
//   - 喂给模型的目录摘要（formatContextSummary）：它是 prompt 的一段，翻译它等于改
//     模型看到的输入；
//   - 用户自填的模板正文/角色库数据（default-templates.generated.ts 与 agents/）——
//     数据不做机翻。
// 润色链路由客户端自己产生的错误（前置检查、坏回执的兜底话）全部走这里的键，由捕获侧
// 用当前语言的 t 渲染；宿主回执携带的原文（ctxRes.error 等）不翻译、作为 {message}
// 原样带出。
import type { TranslateNS as OfficialTranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { MessagesCatalog } from "@jayyuen66/dsh-plugin-shared/lib/locale";

/** 本包设置卡产出的全部界面文案。 */
export interface UiMessages {
  /** 角色库小节标题与说明（这份列表同时喂「模板」下拉与「润色」▾）。 */
  readonly rolesSection: string;
  readonly rolesHint: string;
  /** 设置源可写位为 false 时的状态条。 */
  readonly statusReadOnly: string;
  /** 设置源尚未就绪时的状态条。 */
  readonly statusNotReady: string;
  /** 新增模板按钮。 */
  readonly addTemplate: string;
  /** 保存按钮 title（有未保存改动）。 */
  readonly saveTitleDirty: string;
  /** 保存按钮 title（无未保存改动）。 */
  readonly saveTitleClean: string;
  /** 保存按钮（写入中）。 */
  readonly saving: string;
  /** 保存按钮（空闲态）；同时充当回执文本里的动作名。 */
  readonly save: string;
  /** 撤销按钮（丢弃本地草稿）。 */
  readonly revert: string;
  /** 恢复默认按钮 title（说明影响面与两步确认）。 */
  readonly resetTitle: string;
  /** 恢复默认按钮（已进入确认态）。 */
  readonly resetConfirm: string;
  /** 恢复默认按钮（空闲态）；同时充当回执文本里的动作名。 */
  readonly resetDefault: string;
  /** 卡底的保存语义说明。 */
  readonly footHint: string;
  /** 保存失败前缀（后接错误摘要）。 */
  readonly saveFailed: string;
  /** 新增行的默认名称（整句模板）。 */
  readonly newTemplateName: string;
  /** 写入回执不可确认（宿主未回读成功）。 */
  readonly persistUnconfirmed: string;
  /** 写入回执未生效（宿主拒绝写入，带 revision）。 */
  readonly persistRejected: string;
  /** 行内视觉标记输入框的 aria-label。 */
  readonly rowAriaEmoji: string;
  /** 行内视觉标记输入框的 title。 */
  readonly rowEmojiTitle: string;
  /** 行内名称输入框的 placeholder。 */
  readonly rowPlaceholderName: string;
  /** 行内名称输入框的 aria-label。 */
  readonly rowAriaName: string;
  /** 行内分组输入框的 placeholder。 */
  readonly rowPlaceholderGroup: string;
  /** 行内分组输入框的 aria-label。 */
  readonly rowAriaGroup: string;
  /** 行内分组输入框的 title。 */
  readonly rowGroupTitle: string;
  /** 行内删除按钮的 title。 */
  readonly rowDeleteTitle: string;
  /** 行内删除按钮的文字。 */
  readonly rowDelete: string;
  /** 行内一句话介绍输入框的 placeholder。 */
  readonly rowPlaceholderDescription: string;
  /** 行内一句话介绍输入框的 aria-label。 */
  readonly rowAriaDescription: string;
  /** 行内正文文本域的 placeholder。 */
  readonly rowPlaceholderText: string;
  /** 行内正文文本域的 aria-label。 */
  readonly rowAriaText: string;
  /** 导入回执整体不是对象时的错误。 */
  readonly importFailedUnknown: string;
  /** 导入命中 0 条时的提示。 */
  readonly importEmpty: string;
  /** 导入成功（路径留空 = 内置全量）。 */
  readonly importAllDone: string;
  /** 导入成功（显式路径）。 */
  readonly importFromDone: string;
  /** 导入路径输入框的 placeholder。 */
  readonly importPlaceholder: string;
  /** 导入路径输入框的 aria-label。 */
  readonly importAriaPath: string;
  /** 导入按钮的 title（两种路径语义）。 */
  readonly importBtnTitle: string;
  /** 导入按钮（请求中）。 */
  readonly importing: string;
  /** 导入按钮（空闲态）。 */
  readonly importRoles: string;
  /** 导入失败前缀（后接错误摘要）。 */
  readonly importErrorPrefix: string;
  /** 导入面板的规则说明（允许根、扫描层级、frontmatter 要求）。 */
  readonly importHint: string;
  /** 跳过计数：更深层未扫描。 */
  readonly skipDeeper: string;
  /** 跳过计数：超字节上限。 */
  readonly skipTooLarge: string;
  /** 跳过计数：读取失败。 */
  readonly skipUnreadable: string;
  /** 跳过计数：非角色文件。 */
  readonly skipUnnamed: string;
  /** 跳过计数：真实目标在允许根之外（符号链接逃逸），被安全闸门拦下。 */
  readonly skipEscaped: string;
  /** 跳过计数整句的外层括号。 */
  readonly skipSummary: string;
  /** 跳过计数各项的分隔符。 */
  readonly skipSeparator: string;
  /** 允许目录面板标题。 */
  readonly rootsHeading: string;
  /** 单行允许目录输入框的 aria-label。 */
  readonly rootsAriaRow: string;
  /** 单行允许目录输入框的 title。 */
  readonly rootsRowTitle: string;
  /** 单行移除按钮的 title。 */
  readonly rootsRemoveTitle: string;
  /** 单行移除按钮的文字。 */
  readonly rootsRemove: string;
  /** 新增行输入框的 placeholder。 */
  readonly rootsAddPlaceholder: string;
  /** 新增行输入框的 aria-label。 */
  readonly rootsAddAria: string;
  /** 新增行按钮的 title。 */
  readonly rootsAddTitle: string;
  /** 新增行按钮的文字。 */
  readonly rootsAdd: string;
  /** 允许目录面板的规则说明（绝对路径默认拒绝）。 */
  readonly rootsHint: string;
  /** dock 注册项 label：「润色」按钮。 */
  readonly dockOrganizeEntry: string;
  /** dock 注册项 label：「模板」按钮。 */
  readonly dockTemplatesEntry: string;
  /** 「润色」主键（空闲态）。 */
  readonly organizeIdle: string;
  /** 「润色」主键（请求中）。 */
  readonly organizeLoading: string;
  /** 「润色」主键（失败闪烁）。 */
  readonly organizeFailedShort: string;
  /** 「润色」按钮 title（空闲态）。 */
  readonly organizeIdleTitle: string;
  /** 「润色」失败时 title 前缀（后接错误摘要）。 */
  readonly organizeFailedTitle: string;
  /** 润色前置检查失败：目录上下文读取失败（{message} = 宿主原文，原样带出）。 */
  readonly organizeErrContextFailed: string;
  /** 润色前置检查失败：读取模型失败（{message} = 宿主原文）。 */
  readonly organizeErrModelFailed: string;
  /** 润色前置检查失败：输入框为空。 */
  readonly organizeErrEmpty: string;
  /** 润色链路兜底：宿主回执没带 error 字段时给 {message} 的占位原因。 */
  readonly organizeErrUnknownReason: string;
  /** 润色回执整体不是对象时的兜底错误。 */
  readonly organizeErrUnknown: string;
  /** ▾ 角色菜单按钮的 aria-label。 */
  readonly organizeCaretAria: string;
  /** ▾ 角色菜单按钮的 title。 */
  readonly organizeCaretTitle: string;
  /** 「润色」主键的 aria-label。 */
  readonly organizeMainAria: string;
  /** 角色菜单首项：直接润色。 */
  readonly organizeDirectItem: string;
  /** 角色菜单空态（没有任何模板）。 */
  readonly organizeNoTemplates: string;
  /** 角色菜单条目（{name} = 模板名）。 */
  readonly organizeRoleItem: string;
  /** 润色成功但输入框动作缺失时抛出的错误（会闪烁在按钮上）。 */
  readonly organizeWriteBackUnavailable: string;
  /** 润色结果因草稿版本变化或会话切换而没有写回时的错误。 */
  readonly organizeWriteBackStale: string;
  /** 「润色」按钮 title（输入框处于提交期，编辑面只读）。 */
  readonly organizeBusyTitle: string;
  /** 「模板」按钮 title（可写时）。 */
  readonly templatesIdleTitle: string;
  /** 「模板」按钮 title（输入框动作缺失）。 */
  readonly templatesBrokenTitle: string;
  /** 「模板」按钮 title（输入框处于提交期，编辑面只读）。 */
  readonly templatesBusyTitle: string;
  /** 空分组名的归组名。 */
  readonly templatesGroupCommon: string;
  /** 「模板」按钮的 aria-label。 */
  readonly templatesAria: string;
  /** 「模板」下拉空态（用户删光了列表）。 */
  readonly templatesEmptyHint: string;
  /** 内置精选表在 host 侧、首次打开菜单/进卡片时才拉：拉取中的占位行。 */
  readonly builtinLoading: string;
  /** 内置表拉取失败（含 {message}）：静默显示空列表会被当成"内置角色没了"。 */
  readonly builtinFailed: string;
  /** 内置表拉取失败后的重试按钮。 */
  readonly builtinRetry: string;
}

/**
 * 本包的文案命名空间 merge 进官方的 `LocaleNamespaceMap`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts`「Dictionary owners extend via declaration
 * merging (exactly like SlotMap)」）。这不是美化：不 merge 时 `ctx.locale.bind(NS)` 只能
 * 落到官方那条**未类型化**重载（返回 `Translate<string>`），卡片要的窄键集 `t` 就无官方
 * 来源，本地只好手写一份同构签名。
 * ⚠ interface 键位必须是字面量，故用下面的等式常量把它与 client-entry.ts 的 `NS` 钉住。
 */
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** 本包设置卡的全部界面文案键。 */
    "dir-prep-organize": keyof UiMessages;
  }
}

/** 编译期契约：merge 里写死的命名空间键（`Translate` 由它取键集）就是卡片的条目 id。 */
const LOCALE_NS_KEY = "dir-prep-organize" as const;

/**
 * 本源只以**类型**形态对外流通：`client-entry.ts` 的 `const NS: LocaleNs = "dir-prep-organize"` 把条目
 * id 钉在本源上（分叉即编译期红），而产物漂移针仍要按字面量形状从 bundle 里抓 `NS`，所以那里
 * 保留字面量、只加类型标注——值导出不必存在（用例侧同理：要断言运行时那串就写字面量）。
 */
export type LocaleNs = typeof LOCALE_NS_KEY;

/**
 * 卡片取文案的函数形状：官方 `TranslateNS<N> = Translate<LocaleKeysOf<N>>`（installed
 * `dsh-client-ui-slots/lib/types/index.d.ts`，而 `Translate<K> =
 * (key: K, params?: Record<string, unknown>) => string`，同文件）。函数面归官方，
 * 键集就是上面 merge 的 `keyof UiMessages`（外加官方 `LocaleKeysOf` 一并放行的
 * `common` 命名空间键——那是宿主查不到键时的回落面，运行时行为见其 `lookup`）。
 */
export type Translate = OfficialTranslateNS<typeof LOCALE_NS_KEY>;

export const UI_MESSAGES: MessagesCatalog<UiMessages> = {
  zh: {
    rolesSection: "角色库",
    rolesHint:
      "输入框「模板」下拉与「润色」▾ 角色菜单共用这一份列表，空表即回落到内置精选角色集（生成自插件 agents/ 角色库）。留空点「导入角色」可一键导入内置全部；填路径则按「会话 cwd + 内置角色库 + 下方导入允许目录」放行。编辑后点「保存」生效，重启不丢。",
    statusReadOnly: "设置源不可写：编辑已禁用；下拉仍按当前列表生效。",
    statusNotReady: "设置源未就绪：显示当前生效列表，就绪后可编辑。",
    addTemplate: "+ 新增模板",
    saveTitleDirty: "写入模板列表与导入允许目录（模板生效于新拉开的菜单）",
    saveTitleClean: "无未保存修改",
    saving: "保存中…",
    save: "保存",
    revert: "撤销",
    resetTitle:
      "丢弃模板列表的全部自定义，回到内置默认（不影响已登记的导入允许目录；两步确认，点击即生效）",
    resetConfirm: "确认恢复默认？再点一次（{seconds} 秒内）",
    resetDefault: "恢复默认",
    footHint:
      "说明：编辑/新增/删除先在本地暂存，点「保存」一次写入（模板与导入允许目录同理）；清空名称或正文的条目保存时会被剔除（删除请用行内「删除」）；恢复默认只回滚模板列表。",
    saveFailed: "保存失败：",
    newTemplateName: "新模板 {index}",
    persistUnconfirmed: "{action}结果不可确认：设置源未就绪（宿主未回读成功）",
    persistRejected: "{action}未生效：宿主拒绝了本次写入（当前 revision {revision}）",
    rowAriaEmoji: "模板 {index} 视觉标记",
    rowEmojiTitle: "可选视觉标记（emoji 或短文本），下拉菜单显示在名称前",
    rowPlaceholderName: "菜单显示名",
    rowAriaName: "模板 {index} 名称",
    rowPlaceholderGroup: "分组",
    rowAriaGroup: "模板 {index} 分组",
    rowGroupTitle: "下拉按此分组展示；留空归入「通用」",
    rowDeleteTitle: "删除此模板",
    rowDelete: "删除",
    rowPlaceholderDescription: "一句话介绍（下拉悬停时显示；如：威胁建模与 OWASP 代码审计）",
    rowAriaDescription: "模板 {index} 一句话介绍",
    rowPlaceholderText: "模板正文（点选后插入输入框，随你的消息一起发给模型）",
    rowAriaText: "模板 {index} 正文",
    importFailedUnknown: "导入失败（未知错误）",
    importEmpty: "目录下没有符合条件的角色 .md（需含 name 的 frontmatter）",
    importAllDone: "已从内置角色库导入全部 {count} 条{skips}，编辑后点「保存」生效",
    importFromDone: "已从 {path} 导入 {count} 条{skips}，编辑后点「保存」生效",
    importPlaceholder: "留空 = 导入内置全部角色；或填 .md / 目录路径（须在允许根内）",
    importAriaPath: "角色导入路径",
    importBtnTitle:
      "留空 = 一键导入内置全部角色；填路径 = 导入该 .md 或目录下的角色（路径须在允许根内）",
    importing: "导入中…",
    importRoles: "导入角色",
    importErrorPrefix: "导入失败：",
    importHint:
      "导入说明：留空导入内置角色库全部（agents/）；填路径时只放行「会话 cwd」「内置角色库 agents/」与下方「导入允许目录」之内的路径——绝对路径默认拒绝，越界会直接报「导入路径越界」并回显解析后的路径。本卡没有会话上下文，故只能填内置库或已登记目录里的路径。目录扫描顶层 + 一层子目录 .md（跳过隐藏项），文件须含 name 的 frontmatter，正文将提炼为模板正文。",
    skipDeeper: "{count} 个更深层 .md 未扫描（导入只扫两层）",
    // 「两层」「顶层 + 一层子目录」是 host.ts importFromDirectory 的扫描形状写给用户的那一面：
    // 改那边的扫描深度，这四个键（skipDeeper / importHint × zh / en）要同步改。
    skipTooLarge: "{count} 个文件超字节上限被跳过",
    skipUnreadable: "{count} 个文件读取失败",
    skipUnnamed: "{count} 个非角色文件（frontmatter 无 name）",
    skipEscaped: "{count} 个文件的真实目标在允许根之外（符号链接），已按安全策略排除",
    skipSummary: "（{list}）",
    skipSeparator: "，",
    rootsHeading: "导入允许目录（importAllowRoots）",
    rootsAriaRow: "导入允许目录 {index}",
    rootsRowTitle: "该目录（含其子目录）内的角色 .md 可经「导入角色」读取",
    rootsRemoveTitle: "移除此允许目录",
    rootsRemove: "移除",
    rootsAddPlaceholder: "新增一个允许导入的目录绝对路径",
    rootsAddAria: "新增导入允许目录",
    rootsAddTitle: "加入待保存的允许目录列表",
    rootsAdd: "登记目录",
    rootsHint:
      "绝对路径默认拒绝：只有「当前会话 cwd」「插件内置角色库 agents/」与本列表登记的目录之内可导入。设置页没有会话上下文，卡上填的路径必须落在内置库或本列表内。改完点底部「保存」生效。",
    dockOrganizeEntry: "润色",
    dockTemplatesEntry: "模板",
    organizeIdle: "润色",
    organizeLoading: "润色中",
    organizeFailedShort: "失败",
    organizeIdleTitle: "结合当前目录润色输入框内容（主键直接润色；▾ 可选角色风格）",
    organizeFailedTitle: "润色失败：{message}",
    organizeErrContextFailed: "目录上下文读取失败：{message}",
    organizeErrModelFailed: "读取模型失败：{message}",
    organizeErrEmpty: "输入框为空，无内容可润色",
    organizeErrUnknownReason: "未知错误",
    organizeErrUnknown: "润色失败（未知错误）",
    organizeCaretAria: "选择润色的角色风格",
    organizeCaretTitle: "按某个角色的风格润色（角色来自下方模板库）",
    organizeMainAria: "润色输入框内容",
    organizeDirectItem: "直接润色（默认，不带角色）",
    organizeNoTemplates: "无模板可选作角色风格",
    organizeRoleItem: "以「{name}」的风格润色",
    organizeWriteBackUnavailable: "输入框动作不可用，无法写回",
    organizeWriteBackStale: "输入框内容已变化，润色结果未写回",
    organizeBusyTitle: "输入框正在提交，暂不能润色",
    templatesIdleTitle: "选择一条模板插入光标处（按分组展示）",
    templatesBrokenTitle: "输入框动作不可用，无法插入",
    templatesBusyTitle: "输入框正在提交，暂不能插入模板",
    templatesGroupCommon: "通用",
    templatesAria: "插入模板",
    templatesEmptyHint: "无模板：在设置页「角色库」中添加或恢复默认",
    builtinLoading: "正在载入内置角色模板…",
    builtinFailed: "内置模板加载失败：{message}",
    builtinRetry: "重试",
  },
  en: {
    rolesSection: "Role library",
    rolesHint:
      'The input-box "Template" dropdown and the "Polish" ▾ role menu share this one list; an empty list falls back to the built-in curated role set (generated from this plugin\'s agents/ role library). Leave the path empty and press "Import roles" to import the whole built-in library; an explicit path is allowed within "session cwd + built-in role library + the import allowed directories below". Press "Save" after editing — it survives restarts.',
    statusReadOnly:
      "Settings source is read-only: editing is disabled; the dropdown still uses the current list.",
    statusNotReady:
      "Settings source is not ready yet: showing the list currently in effect, editing unlocks once it is ready.",
    addTemplate: "+ Add template",
    saveTitleDirty:
      "Write the template list and the import allowed directories (templates take effect in newly opened menus)",
    saveTitleClean: "No unsaved changes",
    saving: "Saving…",
    save: "Save",
    revert: "Revert",
    resetTitle:
      "Discard every customization of the template list and go back to the built-in defaults (registered import directories are untouched; two-step confirm, takes effect on the next click)",
    resetConfirm: "Restore defaults? Click once more (within {seconds}s)",
    resetDefault: "Restore defaults",
    footHint:
      'Note: edits, additions and deletions are staged locally first and written in one go when you press "Save" (same for templates and import directories); entries whose name or body is empty are dropped on save (use the inline "Delete" instead); "Restore defaults" only rolls back the template list.',
    saveFailed: "Save failed: ",
    newTemplateName: "New template {index}",
    persistUnconfirmed:
      "{action} cannot be confirmed: the settings source is not ready (host read-back failed)",
    persistRejected:
      "{action} did not take effect: the host rejected this write (current revision {revision})",
    rowAriaEmoji: "Visual mark of template {index}",
    rowEmojiTitle:
      "Optional visual mark (emoji or short text), shown before the name in the dropdown",
    rowPlaceholderName: "Menu display name",
    rowAriaName: "Name of template {index}",
    rowPlaceholderGroup: "Group",
    rowAriaGroup: "Group of template {index}",
    rowGroupTitle: 'The dropdown groups entries by this value; leave empty to fall into "General"',
    rowDeleteTitle: "Delete this template",
    rowDelete: "Delete",
    rowPlaceholderDescription:
      "One-line intro (shown on dropdown hover; e.g. threat modelling and OWASP code auditing)",
    rowAriaDescription: "One-line intro of template {index}",
    rowPlaceholderText:
      "Template body (inserted into the input box and sent to the model with your message)",
    rowAriaText: "Body of template {index}",
    importFailedUnknown: "Import failed (unknown error)",
    importEmpty: "No qualifying role .md in that directory (frontmatter must contain name)",
    importAllDone:
      'Imported all {count} entries from the built-in role library{skips}; press "Save" after editing',
    importFromDone: 'Imported {count} entries from {path}{skips}; press "Save" after editing',
    importPlaceholder:
      "Empty = import every built-in role; or a .md / directory path (must be inside an allowed root)",
    importAriaPath: "Role import path",
    importBtnTitle:
      "Empty imports the whole built-in role library in one click; a path imports that .md or the roles in that directory (must be inside an allowed root)",
    importing: "Importing…",
    importRoles: "Import roles",
    importErrorPrefix: "Import failed: ",
    importHint:
      'Import notes: an empty path imports the whole built-in role library (agents/); an explicit path is only allowed inside "session cwd", "built-in role library agents/" and the "import allowed directories" below — absolute paths are refused by default, and anything out of bounds reports "import path out of bounds" with the resolved path echoed back. This card has no session context, so explicit paths must live in the built-in library or a registered directory. Directory scans cover the top level plus one level of sub-directory .md files (hidden entries skipped), each file needs a frontmatter name, and its body is condensed into the template text.',
    skipDeeper: "{count} deeper .md files were not scanned (imports cover two levels)",
    skipTooLarge: "{count} files were skipped for exceeding the byte limit",
    skipUnreadable: "{count} files could not be read",
    skipUnnamed: "{count} non-role files (no name in frontmatter)",
    skipEscaped:
      "{count} files whose real target lies outside the allowed roots (symlinks) were excluded by policy",
    skipSummary: " ({list})",
    skipSeparator: ", ",
    rootsHeading: "Import allowed directories (importAllowRoots)",
    rootsAriaRow: "Import allowed directory {index}",
    rootsRowTitle:
      'Role .md files inside this directory (and its subdirectories) can be read by "Import roles"',
    rootsRemoveTitle: "Remove this allowed directory",
    rootsRemove: "Remove",
    rootsAddPlaceholder: "Absolute path of a directory newly allowed for imports",
    rootsAddAria: "Add an import allowed directory",
    rootsAddTitle: "Add it to the pending allowed-directory list",
    rootsAdd: "Register directory",
    rootsHint:
      'Absolute paths are refused by default: imports only succeed inside "the current session cwd", "the plugin\'s built-in role library agents/" and the directories registered below. The settings page has no session context, so a path typed here must fall inside the built-in library or this list. Press "Save" at the bottom to apply.',
    dockOrganizeEntry: "Polish",
    dockTemplatesEntry: "Templates",
    organizeIdle: "Polish",
    organizeLoading: "Polishing",
    organizeFailedShort: "Failed",
    organizeIdleTitle:
      "Polish the input-box content against the current directory (main key polishes directly; ▾ picks a role style)",
    organizeFailedTitle: "Polish failed: {message}",
    organizeErrContextFailed: "Failed to read the directory context: {message}",
    organizeErrModelFailed: "Failed to read the model: {message}",
    organizeErrEmpty: "The input box is empty; nothing to polish",
    organizeErrUnknownReason: "unknown error",
    organizeErrUnknown: "Polish failed (unknown error)",
    organizeCaretAria: "Choose a role style to polish with",
    organizeCaretTitle: "Polish in a role's style (roles come from the template library below)",
    organizeMainAria: "Polish the input-box content",
    organizeDirectItem: "Polish directly (default, no role)",
    organizeNoTemplates: "No templates available as a role style",
    organizeRoleItem: 'Polish in the style of "{name}"',
    organizeWriteBackUnavailable: "Input-box actions unavailable; cannot write back",
    organizeWriteBackStale: "The input box changed; the polished text was not applied",
    organizeBusyTitle: "The input box is submitting; cannot polish right now",
    templatesIdleTitle: "Pick a template to insert at the caret (shown grouped)",
    templatesBrokenTitle: "Input-box actions unavailable; cannot insert",
    templatesBusyTitle: "The input box is submitting; cannot insert a template",
    templatesGroupCommon: "General",
    templatesAria: "Insert a template",
    templatesEmptyHint:
      'No templates: add or restore defaults under "Role library" in the settings page',
    builtinLoading: "Loading built-in role templates…",
    builtinFailed: "Failed to load built-in templates: {message}",
    builtinRetry: "Retry",
  },
};
