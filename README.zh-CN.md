<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/JayYuen666/dsh-dir-prep-organize@main/icon.svg" width="96" height="96" alt="dsh-dir-prep-organize logo" />
</p>

<h1 align="center">dsh-dir-prep-organize</h1>

<p align="center"><em>dsh 输入框旁的两个按钮：看着当前目录把草稿重写一遍，或者把一份角色模板放进草稿。</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-dir-prep-organize"><img src="https://img.shields.io/npm/v/@jayyuen66/dsh-dir-prep-organize?style=flat-square&logo=npm&logoColor=white" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@jayyuen66/dsh-dir-prep-organize"><img src="https://img.shields.io/npm/dm/@jayyuen66/dsh-dir-prep-organize?style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/JayYuen666/dsh-dir-prep-organize/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JayYuen666/dsh-dir-prep-organize/ci.yml?branch=main&style=flat-square&label=ci" alt="ci" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4c1?style=flat-square" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-4c1?style=flat-square&logo=nodedotjs&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dsh-%5E0.2.1--rc.2-658EFF?style=flat-square" alt="dsh" />
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=typescript,react,nodejs" alt="tech stack" />
</p>

<p align="center">
  <a href="https://github.com/JayYuen666"><img src="https://img.shields.io/badge/GitHub-JayYuen666-181717?style=flat-square&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="mailto:cqwkkj@gmail.com"><img src="https://img.shields.io/badge/Email-cqwkkj@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email" /></a>
  <a href="https://twitter.com/JayYuen666"><img src="https://img.shields.io/badge/Twitter-X%2FJayYuen666-000000?style=flat-square&logo=x&logoColor=white" alt="Twitter/X" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-658EFF?style=flat-square" alt="English" /></a>
</p>

**一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：一个可拆分「润色」按钮——把草稿、会话目录顶层与最近的真实对话交给当前默认模型重写；外加一个角色模板下拉。零模型工具、零自建 HTTP 路由。**

## <img src="https://api.iconify.design/lucide/file-text.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 目录

- [它做什么](#它做什么)
- [安装](#安装)
- [确认它真的在工作](#确认它真的在工作)
- [它不提供什么](#它不提供什么)
- [在 dsh 里启用](#在-dsh-里启用)
- [润色调用](#润色调用)
- [模板](#模板)
- [设置项](#设置项)
- [对外接口](#对外接口)
- [数据与隐私](#数据与隐私)
- [已知边界](#已知边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [许可](#许可)

## <img src="https://api.iconify.design/lucide/shield.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它做什么

- 在 web 输入框右侧加**两个控件**：一个可拆分的「润色」按钮（主键 + ▾），一个「模板」下拉。
  - 主键直接润色；▾ 键提供「以某个角色的风格润色」。
  - 下拉按条目的 `group` 字段分组，`group` 为空的条目落在「通用」里。
- **润色**会把草稿、会话 cwd 的顶层（文件名、大小、关键文本文件的全文）以及会话里**真实的** user/assistant 轮次交给当前默认模型，然后用重写结果替换草稿。
  - 失败时草稿**绝不**被改动：按钮进入错误态若干秒，原因写在其 tooltip 里。
- **模板**会把文本插进草稿：草稿为空时整份填入，否则空一行后追加。
- 内置集是 **85 条精选角色模板**，由 `scripts/gen-defaults.mjs` 从本包的 `agents/` 角色库生成——那是从上游项目移入的几百份角色 `.md`，分布在二十多个部门目录下。对用户有意义的是那 85 条；角色库的份数不在这里钉死，因为上游一刷新它就变。
  - 这张表**只在宿主侧**：客户端产物不再内联它。生成文件约 640 KB，曾把 `client.js` 推到约 711 KB。
  - 浏览器**懒加载、只调一次** Remote 的 `defaults` 方法（首次打开菜单或首次进设置卡），之后在进程内复用。用户已经有自己的模板时**一个字节都不拉**。
  - 数据还没到时菜单显示一行 loading，而不是「没有模板」那句提示；失败时把宿主自己的原因和「重试」按钮一起显示出来。
- **「模板库」**设置卡覆盖：逐条增/改/删、两步恢复默认、一键导入整套内置库、按路径导入本地 `.md` 或目录、登记额外的允许导入目录。这张卡是**一份列表同时喂两处**——输入框「模板」下拉，与「润色」▾ 的角色菜单。
- 模板与允许目录都经宿主设置读写，**零 LLM 调用**，且**不注册任何模型工具**。

## <img src="https://api.iconify.design/lucide/package.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 安装

```sh
dsh plugin --profile web add @jayyuen66/dsh-dir-prep-organize
```

卸载：`dsh plugin --profile web remove @jayyuen66/dsh-dir-prep-organize`。包在公共 npm 上，安装不需要凭据，也不需要配作用域源。

- **要求 Node.js `>= 22.12`。** 本包是纯 ESM。用**具名**导出（`import { apply } from "@jayyuen66/dsh-dir-prep-organize"`）；**没有 default 导出**，所以 `import pkg from …` 会报 `does not provide an export named 'default'`。正是这个 Node 下限让 ESM 入口的 `require()` 形式可用，所以声明了 `engines.node`。
- **要求宿主 `dsh` 在 `0.2.1-rc.2` 这条线上。** 宿主真正读的是 `engines.dsh`（`^0.2.1-rc.2`），而且它**单独决定**：`evaluatePluginCompatibility` 在 `engines.dsh` 那一支就返回了，根本走不到读 `peerDependencies` 的那段。对宿主真实代码实测：`0.2.0-rc.2` **被拒**，`0.2.1-rc.2` 与 `0.2.2` 通过，`0.3.0` 被拒。被拒的宿主需要走显式担责的授权 `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version <exact> --accept-risk`。
- **`@deepseek-ai/dsh-*` 的钉版保持在 `0.2.1-rc.2`**——本包编译与测试所对着的那一版。`engines.dsh` 那个范围是关于「能在哪些**宿主**上跑」的声明；钉版是关于「它是对着哪个宿主版本**编译**的」的事实。把两者混为一谈，正是发布门禁分开检查它们的原因。
- **`dependencies` 里不放任何 `@deepseek-ai/*`，这是契约**（`test/publish-manifest.test.ts` 钉着）。消费方 profile 用 `nodeLinker: hoisted` 且 `autoInstallPeers: false` 安装，于是写在 `dependencies` 里的宿主包会被落成**真实目录**，与运行中的宿主已加载的那份并存。`@deepseek-ai/dsh-tools` 的工具运行期调度键是普通 `Symbol`（不是 `Symbol.for`），符号身份按模块实例算：宿主从 profile 副本上读那个键拿到 `undefined`，于是**每一次原生工具调用都抛**——而本包的构建、类型检查、覆盖率门禁在此之前全部照绿。
- **`host.js` 按值导入的那两枚宿主包是必需 peer**：`@deepseek-ai/schemastery`（宿主 fork——只有它能把 `.volatile()` 字段解析成活引用）与 `@deepseek-ai/dsh-brand`。`build-host.mjs` 外部化 `dependencies` **与** `peerDependencies`，所以裸说明符留在产物里；只写 `devDependencies` 会让打包器把官方函数体内联进去。`test/build-host.test.ts` 同时钉「说明符在」与「函数体不在」。
- **声明里点到的每一枚宿主包都落在 `peerDependencies`**，凡是只能从那里到达的都是 *optional*（`@deepseek-ai/cordis`、`cosmokit`，以及 `dsh-agent-default-model` / client-ui / `fs` / `llm` / `session` 那一族）。声明它们不是仪式：pnpm 严格布局下，`types/host.d.ts` 里一枚没有被任何 manifest 表点名的裸说明符在消费方侧解析不到，而本仓自己的类型检查照样绿。那条清单由测试从 `types/**/*.d.ts` 现量读，不从这段文字读，所以两边不会漂移。
- **随包发的东西**：`host.js`、`client.js`、`templates.data.mjs`、`types/`、`cordis.patch.yml`、`agents/` 与 `THIRD_PARTY_NOTICES.md`。`package.json`、`README*` 与 `LICENSE` 由发布器无条件附带。
- **内置表单独一个产物、首次使用时才加载**，不是插件装载时加载。它以前被打进 `host.js`，于是每个用户即使从不开那个下拉，也要在内存里付一份模板的代价。
- **`agents/` 不是本仓写的**：来自 [`agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)（MIT）。版权与许可声明随包发在 `THIRD_PARTY_NOTICES.md` 里，因为 MIT 要求它出现在每一份分发副本中。**不要手改 `agents/` 下的任何文件。**

### <img src="https://api.iconify.design/lucide/arrow-down-to-line.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> shared 的版本下限

如果你的 profile 用 pnpm `overrides` 把 `@jayyuen66/dsh-plugin-shared` 钉在某个版本，那个值必须不低于本包声明的那一版。钉得更低会装到一份缺少运行期所导入名字的产物，宿主起来时报 `N entries did not activate` 与 `does not provide an export named ...`——包装得上、永远不生效，而各仓单仓 CI 看不见这一类。

## <img src="https://api.iconify.design/lucide/circle-check.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 确认它真的在工作

1. **输入框右边出现两个控件。** 没出现就是装配层没挂上——用 `dsh --profile web --dump-config` 看有没有 `dir-prep-organize` 这一层。
   - `--dump-config` 是唯一被接受的"进了层栈"信号，而它**不是只读命令**——它会重写该 profile 的根装配文件。所以判读要分别捕获 stdout 与 stderr；未匹配的 patch 目标只出现在 stderr，只看退出码什么都证明不了。
   - 层行可能是 `# == <层>`，也可能是 `# == <层>, patched by <路径>`；两种都得认。
2. **下拉能填出来**：打开「模板」，内置列表经 Remote 的 `defaults` 方法到达。一行 loading 表示还在路上；失败会显示宿主的原因加「重试」。
3. **润色能用**：按主键。成功即替换草稿；失败则草稿不动，按钮进入错误态，原因在 tooltip 里。
4. **设置卡渲染出来**：「模板库」出现在设置页，改动先进草稿，点**保存**后生效。

## <img src="https://api.iconify.design/lucide/circle-slash.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 它不提供什么

找之前先知道这几件事：

- **它不注册任何模型工具。** 宿主半只 inject `settings`，从不碰工具注册表。没有 `organize_text` 这类工具可调。
- **它没有自建的 HTTP 路由。** 数据面是官方 Typert Remote 命名空间 `dirPrepOrganize`，经注入的子 fiber 注册，走宿主 `/api` 网关。认证、Host/DNS 重绑定/Origin 判据、签名浏览器会话 cookie、body 上限全归网关——本包不持有 CSRF token，也没有路由表。
- **它不加 CLI 子命令。**
- **它不读任何环境变量**，也没有自己的出站请求。
- 它**确实**消费的东西：宿主 `settings` 服务（硬注入）、`llm.stream`、`agentDefaultModel`，以及会话与文件系统服务。缺 `settings` 时设置卡禁用并告警，下拉回落到内置精选集。

## <img src="https://api.iconify.design/lucide/plug.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 在 dsh 里启用

- 安装即贡献组合包补丁层（`dsh.bundle.patch` → `./cordis.patch.yml`），插入 `- id: dir-prep-organize`，`name` 指向包名。
- **客户端半**注册两个槽位外加设置卡：
  - `conversation.input.right`——润色按钮（id `dir-prep-organize`，order 99）与模板下拉（id `dir-prep-organize-templates`，order 100）。
  - `plugins.bundle.config`——设置卡，按 **bundle 包名** `@jayyuen66/dsh-dir-prep-organize` 作 key。宿主派发 `entryKey: pkg.name`（真源是 profile `package.json` 里的 `dsh.profile.bundles`），所以写成裸条目 id 永远匹配不上，卡片哪都不渲染。
  - 设置命名空间与 `configForms.get()` 仍是**裸条目 id** `dir-prep-organize`——与那个槽位 key 刻意不是同一个标识。
- 客户端半是 `dsh.client.platform = web` 且带 `immediately`。
- 卡片的文案遵循官方 locale 插件的偏好；宿主半每次请求现读该偏好，所以切语言不必重启。

## <img src="https://api.iconify.design/lucide/sparkles.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 润色调用

| 面 | 事实 |
|---|---|
| 传输 | 宿主 `llm.stream`：一条**仅请求态**的 user 文本消息（无 `id`、无 `source`）加一段 `system` 规则块 |
| 模型 | `agentDefaultModel.currentSelection()`——provider / model / reasoningEffort。取不到时回报 "No model selection is available" |
| 角色风格 | 可选的 `roleText` 注入 user 消息的 `<data>` 围栏（不进 system——见 `buildOrganizeSystem` 的信任序注释）。它只借用术语与语气，**从不执行该角色的任务** |
| finish reason | 除 `stop` 之外（含缺 finish 块）一律**失败**，且绝不写回草稿 |
| 超时 | `organizeTimeoutMs`，默认 120000 ms，每次请求经 `.get()` 读。客户端 fetch 超时是它 + 5000 ms |
| 输入上限 | `maxSnippetBytes`（262144 = 256 KiB）按关键文件、`readConcurrency`（8）按读并发。目录、对话与角色正文**从不截断** |
| 为什么刻意不截断 | 模型报上下文溢出就是反馈，由用户自己收窄输入。载荷超过端点 body 上限则得到 413 |

## <img src="https://api.iconify.design/lucide/layout-template.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 模板

| 面 | 事实 |
|---|---|
| 条目形状 | `{ id, name, description, text, group, emoji }`，全部字符串。`description` / `group` / `emoji` 默认空串 |
| 保存时校验 | `name` 或 `text` 为空的条目被丢掉；`emoji` 截到 12 字符；缺失或撞车的 `id` 确定性地替换成 `tpl-<index>` |
| 内置集 | 从 `agents/` 角色库生成的 85 条精选模板。`templates` 未设置时下拉回落到它们 |
| 「未设置」= 空数组 | 隐式注册下 schemastery 会把缺失的数组字段 cast 成 `[]`，所以**空列表永远意味着「回落到内置」**。只有非空数组且条目全部非法，才渲染成空列表 |
| 恢复默认 | 把 `templates` 退回精选集，`importAllowRoots` 不动。两步确认，第二次点击须在 4 秒内 |
| 导入 | 按路径：本地 `.md` 文件或目录。`path` 恰为空串 = 导入整套内置库 |

## <img src="https://api.iconify.design/lucide/sliders-horizontal.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 设置项

命名空间 `dir-prep-organize` 即设置条目 id。投影进设置表单的字段就是那几个 `.volatile()` 的。

| 字段 | 类型 | 默认值 | 卡上有控件 | 说明 |
|---|---|---|---|---|
| `templates` | `{id,name,description,text,group,emoji}[]` | 未设置 | **有** | 用户自己的模板。未设置时回落到 85 条内置 |
| `importAllowRoots` | `string[]` | `[]` | **有** | 导入端点的额外允许根，逐个目录登记；非字符串与纯空白项丢弃，重复项去重。一个都没登记时只允许会话 cwd 与内置角色库 |
| `organizeTimeoutMs` | natural，volatile | `120000` | **无** | LLM 中止时限（毫秒）。夹在 `[1, 2147483647]`：超过 2^31-1 时 Node 的 `setTimeout` 会打 `TimeoutOverflowWarning` 并静默用 **1 ms**，于是"调大超时"变成"立刻失败"。卡上没有控件，改它只能经 `settings.yaml` 或该行的 `config:` |
| `maxSnippetBytes` | natural，非 volatile | `262144` | **无** | 关键文件摘要的单文件上限；超过、或大小未知的文件整份跳过并计入 `skipped.tooLarge`。导入候选用同一个上限。非 volatile 意味着不进表单快照，所以也没有卡上的行——纯部署值 |
| `readConcurrency` | natural，非 volatile | `8` | **无** | 摘要与目录导入的有界读并发。夹在 `[1, 64]`：`0` 或负数会让那套有界 map 自我递归直到宿主被 OOM killer 杀掉，而过大的值直接废掉这个字段存在的意义（fd 上限） |

设置持久化在 dsh 数据目录下的 `settings.yaml`。

## <img src="https://api.iconify.design/lucide/network.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 对外接口

官方 Typert Remote 命名空间 **`dirPrepOrganize`**，经注入的子 fiber 注册。descriptor 手写，参数走严格形状校验，结果走 `src-json`。

| 方法 | 入参 | 成功载荷 |
|---|---|---|
| `defaults` | — | `ok` / `templates[…]`（精选集） |
| `context` | `{ sessionId }` | `ok` / `cwd` / `truncated` / `skipped` / `entries[{name,isDir,sizeBytes,snippet}]` |
| `model` | `{ sessionId }` | `ok` / `provider` / `model` / `reasoningEffort` |
| `organize` | `{ sessionId, prompt, entriesSummary, roleText? }` | `ok` / `content` |
| `importTemplates` | `{ path, sessionId }`（`path` 恰为空串 = 整套内置库） | `ok` / `count` / `truncated` / `skipped` / `entries` |

- 业务失败一律 `ok:false` 带 `error`。导入路径策略那几支是例外：越界路径或形状不对的 `path` 还会额外带 `status` 403 或 400。
- 客户端解析结果保留防御性默认：非对象载荷、或缺 `ok:true`，都变成**可见的错误**，绝不变成空列表。

## <img src="https://api.iconify.design/lucide/lock.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 数据与隐私

| 面 | 事实 |
|---|---|
| 网络 | 没有自己的出站请求：数据面走宿主网关的 RPC 通道。不读任何环境变量 |
| 落盘 | 唯一写盘的是宿主设置文件里的 `templates` 与 `importAllowRoots` |
| 一次润色发出去什么 | 完整草稿、会话 cwd 路径、顶层目录条目**连同关键文本文件的全文**、真实的 user/assistant 轮次（框架注入的消息与工具结果被滤掉），以及可选的角色正文 |
| 哪些文件会取摘要 | 只有 20 种代码/文档扩展名（ts/tsx/js/jsx/mjs/cjs/py/rs/go/java/rb/json/toml/md/sql/graphql/proto/css/scss/less）。`yaml` / `env` **不在**白名单 |
| 敏感文件名 | 名字在**分隔符边界**上命中 `credentials` / `secret(s)` / `id_rsa` / `pem` / `p12` / `pfx` / `keystore` / `env` / `key(s)` / `token(s)` / `auth` / `passwd` / `password` / `account(s)` 的文件，永不取摘要。边界是刻意的：朴素子串匹配会误杀 `monkey.js` 与 `AUTHORS.md`，而漏匹配会把凭据全文发给第三方模型 |
| 上限与并发 | 单个文件超过 `maxSnippetBytes`、或大小未知，整份跳过——绝不半份摘要。读按 `readConcurrency` 跑 |
| 计数器 | 过大 / 读不出 / 更深层 / 非角色这几类计入 `skipped`，在 UI 里显示，并由 `truncated` 如实反映 |
| 导入端点 | **只读**：不调模型、不写盘。绝对路径默认拒绝；只有会话 cwd、本包的 `agents/` 与 `importAllowRoots` 之内通过。`.` / `..` / 隐藏段（如 `.ssh`）一律拒绝，越界路径回 403 并回显解析后的路径 |

## <img src="https://api.iconify.design/lucide/triangle-alert.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 已知边界

按类登记，每类一条。

- **没有任何东西替你截断。** 目录列表、对话文本与角色正文都是整份进去的。上下文溢出是模型的报错，也是你收窄输入的依据——本插件不会静默丢掉你半份草稿。
- **导入卡没有会话上下文。** 它的 POST 把 `sessionId` 发成空串，所以导入目标必须在内置 `agents/` 或某个已登记的根之内，且不含 `.` / `..` / 隐藏段。拒绝时会点名允许区并回显解析后的路径。
- **目录导入只到两层。** 顶层加一层子目录；第三层只被**计数**为 `deeper`，永不导入。
- **前 20 行 frontmatter 里解析不出名字的文件计为 `unnamed`**，跳过而不是猜。
- **这里没有机器翻译。** `agents/` 角色库与模板正文是用户数据，无论界面语言如何，永不被翻译。
- **润色对模型回答只能尽力而为。** finish reason 不是 `stop` 就整趟失败；而模型若返回散文而不是重写结果，草稿就被那段散文替换掉。

## <img src="https://api.iconify.design/lucide/circle-help.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 常见问题

| 症状 | 怎么回事 |
|---|---|
| 按了「润色」什么都没变 | 失败从不碰草稿；按钮进入错误态若干秒，原因在 tooltip 里。常见成因：没有会话 cwd（`sessionId` 缺失或会话未知）、没有模型选择、finish reason 不是 `stop`、或撞上 `organizeTimeoutMs` 时限 |
| 模型报上下文溢出 | 这是设计如此：输入刻意不截断，模型报错就是反馈。载荷超过端点 body 上限则得到 413 |
| 导入本地角色被拒 | 绝对路径默认拒绝，而卡片没有会话上下文。路径必须在内置 `agents/` 或某个已登记目录之内，且不含 `.` / `..` / 隐藏段 |
| 导入的条目比预期少 | 看四个 `skipped` 计数器：`deeper`（第三层，只计数）、`tooLarge`（超过 `maxSnippetBytes`）、`unnamed`（前 20 行 frontmatter 里没有名字）、`unreadable`（读失败） |
| 模板改动没生效 / 语言不对 | 改动先在本地暂存，点**保存**后对新生效的下拉可见。标签与文案遵循官方 locale 偏好；而角色与模板**正文**是用户数据，永不做机器翻译 |

## <img src="https://api.iconify.design/lucide/wrench.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 开发

```sh
pnpm install
pnpm run check        # typecheck → lint → client 构建 → host 构建 → 类型 → 测试 → 格式
pnpm run gen:defaults # 从 agents/ 重新生成精选集（仅开发期）
```

- **`test/gen-defaults.test.ts` 是一道漂移锁。** 它把生成文件与角色库逐字段比对、核对两张镜像表的键序，并要求与生成器产出**字节级**一致。改解析或提炼逻辑就必须改 `scripts/gen-defaults-lib.mjs` **并**重跑 `pnpm run gen:defaults`；否则表现出来是一条红测试，而不是一个悄悄过时的下拉。
- 精选 slug 缺失或解析失败时生成器非零退出，所以角色不可能无声消失。
- 其余测试按「桩看不见的那几类错」分层：宿主半、客户端半、Remote 契约（`test/dir-prep-remote.test.ts`）、两份构建产物（`test/build-host.test.ts`、`test/build-client.test.ts`），以及一层集成。
- 覆盖率四项阈值都是 100%，所以新增分支必须有能走到它的用例。

## <img src="https://api.iconify.design/lucide/scale.svg?color=%23658EFF&height=22" height="22" width="22" align="absmiddle" alt="" /> 许可

MIT。源码在 [github.com/JayYuen666/dsh-dir-prep-organize](https://github.com/JayYuen666/dsh-dir-prep-organize)，issue 走那个仓的 tracker。

`agents/` 移植自 [`agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)（MIT），详见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
