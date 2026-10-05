# @jayyuen66/dsh-dir-prep-organize

[English](./README.md) · [简体中文](./README.zh-CN.md)

## 它做什么

- 在 dsh web 对话输入框右侧加两个控件：「整理」分段按钮与「模板」下拉。
- 「整理」主键直接整理，▾ 选「以某角色视角整理」；「模板」下拉按 group 分组，空组归「通用」。
- 「整理」把草稿 + 会话 cwd 的顶层目录（文件名/大小/关键文本文件全文）+ 会话最近真人对话交给当前默认模型重写。
- 成功直接替换草稿；失败草稿原值不动、按钮转失败态 4 秒（title 带原因）。
- 「模板」点选即插入草稿：空草稿整段填入，非空草稿末尾空一行追加。
- 默认列表是 85 条内置精选角色模板（scripts/gen-defaults.mjs 生成自包内 agents/ 角色库：22 个部门目录、306 个角色 .md）。
- 那张表**只留在 host 半**：client 半不再打包它（生成表 640KB，曾让 `client.js` 涨到 711KB），改为首次打开「整理」/「模板」菜单或进设置卡时 `GET /_dsh/dir-prep/default-templates` 按需拉一发并进程内复用；未就绪时菜单里是「正在载入…」占位行，失败则显形为原因 + 重试按钮（不静默显示空列表）。用户已设置过自己的模板时一发都不发。
- 设置页一张「提示词模板」卡承载逐条增删改、两步确认恢复默认、一键导入内置全部角色、按路径导入本地 .md 或目录、登记导入允许目录。
- 模板与允许目录的读写走宿主 settings，零 LLM，也不注册任何模型工具。

## 安装

包发布在公共 npm（`registry.npmjs.org`），安装不需要凭据：

```sh
dsh plugin --profile web add @jayyuen66/dsh-dir-prep-organize
```

- 宿主区间 `>= 0.2.0-rc.2`，同时写进 `peerDependencies` 与 `engines.dsh`。真正生效的只有 `peerDependencies`：自 `0.1.7-rc.1` 起宿主载入插件时会校验它并把不兼容的条目**停用**（`compatibility-preflight.ts` 的 `deny()`）；`engines.dsh` 在该宿主版本上没有任何读者。
- `@deepseek-ai/dsh-*` 依赖仍精确钉在 `0.2.1-alpha.1`——那是本包构建并测过的宿主版本。区间是对**它能跑在哪些宿主上**的声明，钉版是对**它在哪个宿主版本上编译过**的事实；把两者混成一条断言，正是发布门禁现在把它们拆开分别验的原因。
- client 半 `dsh.client.platform = web`、`immediately`。
- 发布形态为按包单仓，`repository.url` 为 git+https://github.com/JayYuen666/dsh-dir-prep-organize.git ；问题反馈走同一仓库的 issue（`bugs`）。
- 要求 Node.js `>= 22.12`。本包是纯 ESM：用 `import { apply } from "@jayyuen66/dsh-dir-prep-organize"` 或 `require("@jayyuen66/dsh-dir-prep-organize")`。**没有默认导出**——`import pkg from …` 会报 `does not provide an export named 'default'`，请取具名导出。正是这个 Node 下限让 `require()` 能吃下这个 ESM 入口，所以 `engines.node` 要写明。
- TypeScript 声明以 `types/host.d.ts` 随包发出，同时接进 `types` 与 `.` 的 exports 条件。`Config` 那个 schema 值带了显式注解，所以产物里不会出现消费方解析不到的类型名。
- 发布产物只有 `host.js`、`client.js`、`templates.data.mjs`、`types/`、`cordis.patch.yml`、`agents/` 与 `THIRD_PARTY_NOTICES.md`（package.json 的 `files`）；`LICENSE`、`README.md`、`package.json` 由 registry 客户端无条件附带。
- 内置精选模板表单独成一个产物，**首次用到时才载入**，不再随插件载入就进内存。它原先被打进 `host.js`，于是即便用户从不开「模板」下拉，也要替 85 条模板付内存——现在 `host.js` 只有原先的约十分之一，而浏览器那一侧本来就是按需拉的。
- `agents/` 并非本仓原创：它来自上游项目 [`agency-agents-zh`](https://github.com/jnMetaCode/agency-agents-zh)（MIT）。MIT 要求声明随每一份分发副本一起给出，故其版权与许可声明收录在 `THIRD_PARTY_NOTICES.md`。
- 运行期依赖四枚，全在 `dependencies`：`@jayyuen66/dsh-plugin-shared`、`@deepseek-ai/schemastery`（宿主 fork，0.1.7 的 `.volatile()` 活引用只有它解析得出来）、`@deepseek-ai/dsh-brand`（`0.2.1-alpha.1`）与 `@deepseek-ai/cosmokit`（`1.8.6-alpha.1`）。
  - 第四枚同样不是笔误：schemastery 的 `Dict` 取自 cosmokit，于是凡是提到 schema 的声明产物都会带上对它的引用。若把 cosmokit 留作传递依赖，消费方在 pnpm 严格布局下解析不到这个引用——声明入口在那边根本过不了类型检查。这里钉的正是 schemastery 本就会解析到的那个版本，不增加任何安装体积。
  - 第三枚不是笔误：`host.ts` 的 `brandString` 是**值导入**，必须落 `dependencies`——`build-host.mjs` 的外部化名单只读 `dependencies`∪`peerDependencies`，放 `devDependencies` 就会被 rolldown 把官方函数体内联进 `host.js`（`test/build-host.test.ts` 同时钉「说明符在」与「函数体不在」）。

## 在 dsh 里启用

- 装包即由包内 bundle patch（`dsh.bundle.patch` 指向 `./cordis.patch.yml`）注入 `- id: dir-prep-organize`（`name` 为包名）。
- 卸载用 `dsh plugin --profile web remove @jayyuen66/dsh-dir-prep-organize`。
- host 半硬依赖 webServer 与 settings：缺 settings 时设置卡停用并 warn，「模板」下拉回落内置精选集，五个端点不受影响。
- client 半注册槽 `conversation.input.right`（整理 id `dir-prep-organize` order 99、模板 id `dir-prep-organize-templates` order 100），另注册设置卡槽 `plugins.bundle.config`。
  - 卡槽 key = bundle 包名 `@jayyuen66/dsh-dir-prep-organize`：该槽按 bundle 包名 keyed（宿主派发 `entryKey: pkg.name`，真源是 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`）；写成裸条目 id 就不命中，卡片整张不渲染。
  - settings 命名空间与 `configForms.get()` 仍是裸条目 id `dir-prep-organize`，与上面的 slot key 不是一回事。

## 提供给模型的工具

| 面           | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型工具注册 | 无。host 半只 `inject` webServer 与 settings，不碰宿主工具注册面                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 整理调用     | 宿主 `llm.stream`：单条 user 文本消息（**request-only 输入**，不带 `id`/`source`，见 `host.ts` 上方那条注释的三条证据）+ `system` 规则段；模型取 `agentDefaultModel.currentSelection()` 的 provider/model/reasoningEffort，取不到即报「当前无可用模型选择」                                                                                                                                                                                                                                                          |
| 角色视角     | 可选 `roleText` 注入 system 的「参考角色」段，只借术语与措辞重写草稿，不代为执行角色的任务                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 时限与上限   | 三枚都进 config，路由每次请求经 `limits` 取一次：`organizeTimeoutMs` 默认 120000 ms（volatile 引用，`.get()` 现读）、`maxSnippetBytes` 默认 262144（256 KiB）、`readConcurrency` 默认 8（后两位是普通值形态，不经 `.get()`）；client 请求超时 = `organizeTimeoutMs` + 5000 ms（宿主值缺席按 120000 算，即 125000；另外三个端点的 fetch 用常量 `FETCH_TIMEOUT_MS` 125000 ms）；POST body 上限是配置字段 `importBodyMaxBytes`，默认 8 MiB；目录/对话/角色正文一律不截断；流终态非 `stop`（含缺 finish 块）判失败且不写回 |

## 设置项

| 字段                | 类型                                       | 默认     | 说明                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates`         | `{id,name,description,text,group,emoji}[]` | 未设置   | 全 string 字段，description/group/emoji 缺省空串；保存时 name 或 text 为空的条目被剔除，emoji 截到 12 字符，id 缺失或撞名确定性补 `tpl-<index>`；未设置时下拉回落内置 85 条精选（生成集留在 host 半、经 default-templates 端点按需下发，不再是 host 的 base）。⚠ 隐式注册下「未设置」到客户端就是**空表**（schemastery 对 array 字段把缺失值 cast 成 `[]`，不给默认并不产生 undefined），所以空表一律按未设置回落内置；只有「非空数组但逐项非法」才渲染空列表 |
| `importAllowRoots`  | `string[]`                                 | `[]`     | 导入端点的额外允许根，逐条登记目录；非字符串与纯空白项丢弃、去重；未登记 = 只放行会话 cwd 与内置角色库                                                                                                                                                                                                                                                                                                               |
| `organizeTimeoutMs` | natural，`.volatile()`                     | `120000` | LLM 整理中止时限（毫秒），host 侧 `config.organizeTimeoutMs.get()` 每次请求现读。标了 volatile ⇒ 随宿主投影进本条目的表单快照，三枚里 client 半只读它一枚（`rawOrganizeTimeoutMsOf`），用来把 organize 的 fetch 超时定为「该值 + 5000 ms」。⚠ 使用前夹进 `[1, 2147483647]`：超过 2^31-1 时 Node 的 `setTimeout` 会打一条 `TimeoutOverflowWarning` 然后**静默改用 1 ms**，「把超时调大」于是变成「立刻失败」。⚠ 卡片**没有**它的控件：`src/client-entry.ts` 只写 `templates` 与 `importAllowRoots`，改它得动 settings.yaml 或注册行的 `config:`        |
| `maxSnippetBytes`   | natural（非 volatile）                     | `262144` | 单个关键文件摘要的字节上限，超出整份跳过（不喂半份摘要）并计 `skipped.tooLarge`；导入候选读取用同一枚。非 volatile ⇒ 不进表单快照，卡片自然也没有它的行；只能按部署值给（settings.yaml / 行 `config:`）                                                                                                                                                                                                              |
| `readConcurrency`   | natural（非 volatile）                     | `8`      | 关键文件摘要读取与目录导入（子目录 listDir、第三层清点、候选读取）的有界并发度；同上，无投影、无卡上控件。⚠ 使用前夹进 `[1, 64]`：`0` 或负数会让有界 map 无限自递归直到宿主进程被 OOM killer 杀掉，而配成极大值则直接废掉这个字段存在的理由（那道 fd 上界）                                                                                                                                                                                                                                                    |
| `importBodyMaxBytes`  | natural（非 volatile）                     | `8388608` | organize / import 两条 POST 的 body 字节上限（内存防爆纵深防御，非功能截断：两条路由提交的是整理草稿与模板产物，不是大文件本体）；超限即 413，guardBody 流式计量并在越界处早退，所以最坏常驻内存就是这一枚水位。同上，无投影、无卡上控件                              |
| 恢复默认            | —                                          | —        | unset `templates` 回落精选集、不动 `importAllowRoots`；两步确认，第二次点击须在 4 秒内                                                                                                                                                                                                                                                                                                                               |
| 存储位置            | —                                          | —        | settings 命名空间 `dir-prep-organize`（0.1.7 隐式注册：命名空间 = 本条目 id，投影进设置表单的是 host.ts `Config` 上标了 `.volatile()` 的 `templates`/`importAllowRoots`/`organizeTimeoutMs`，其中卡片只写前两枚；`maxSnippetBytes` 与 `readConcurrency` 是普通值形态），落在 `<dsh 数据目录>`（`$DSH_HOME`）的 settings.yaml                                                                                         |

## 对外接口

| 路由                      | 方法 | 入参                                                                             | 成功回执                                                                |
| ------------------------- | ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/_dsh/dir-prep/context`  | GET  | query `sessionId`                                                                | `ok/csrf/cwd/truncated/skipped/entries[{name,isDir,sizeBytes,snippet}]` |
| `/_dsh/dir-prep/model`    | GET  | query `sessionId`                                                                | `ok/csrf/provider/model/reasoningEffort`                                |
| `/_dsh/dir-prep/organize` | POST | body `prompt`/`sessionId`/`entriesSummary`/可选 `roleText`，头 `x-dir-prep-csrf` | `ok/content`                                                            |
| `/_dsh/dir-prep/import`   | POST | body `path`（精确空串 = 内置全量）/`sessionId`，不经 CSRF                        | `ok/count/truncated/skipped/entries`                                    |
| `/_dsh/dir-prep/default-templates` | GET | 无参数，不经 CSRF | `ok/templates[{id,name,description,text,group,emoji}]`（内置精选表原文下发） |

| 情形                                          | 响应                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由与令牌                                    | 四条都是 webServer 精确路由（注册时 `kind: "exact"`）；每条 handler 体的**第一条语句**是 `guardTrust(req, res, { servingNonLoopback })`（shared/lib/trust），非 trusted 即写一次 403 并 return，不再读 body；`csrf` 为 per-apply 随机令牌，两个 GET 下发、organize 回填 |
| 信任判据的次序                                | Host 权威 → `sec-fetch-site` 白名单（只放 same-origin/none/缺失）→ `origin` 与 Host 逐字比对；本包 handler 里自家那枚 `isCrossOrigin` 分支在闸门落地后不可达、已删（共享层 `guardBody` 的同形检查也被闸门挡在前面），拒跨域的是闸门，错误文本由它给                       |
| Host 权威不是本机可信地址                     | 403 + `{ok:false,error:"untrusted host authority"}`；`servingNonLoopback` 取自 `webServer.host === "0.0.0.0"`，取不到即按只绑回环的保守档                                                                                                                               |
| `sec-fetch-site` 不在白名单、或 origin 对不上 | 403 + `{ok:false,error:"cross-origin request rejected"}`（`origin` 为 `null` 的沙箱页，以及缺 Host 却又带了 `origin` 的本地面，同落这一句）                                                                                                                             |
| 方法不符                                      | 405 带 `Allow`，体是 JSON：`{ok:false,error:"GET only"}`（organize/import 为 `"POST only"`）                                                                                                                                                                            |
| CSRF 缺失或错                                 | 403 + `{ok:false,error:"invalid csrf token"}`（`guardBody` 那一条，仍在闸门之后）                                                                                                                                                                                       |
| body 超配置上限（默认 8 MiB）                | 413 + `{ok:false,error:"request body too large"}`                                                                                                                                                                                                                       |
| 坏流或非法 JSON                               | 400 + `{ok:false,error}`（坏流 `"request body unreadable"`，非法 JSON 走字典文案）                                                                                                                                                                                      |
| 业务失败                                      | 仍回 200 + `{ok:false,error}`；导入路径越界/非法段例外，回 403 与 400（见数据与隐私）                                                                                                                                                                                   |

## 数据与隐私

| 面                         | 事实                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 网络调用                   | 只指向本进程的同源 `/_dsh/*`；不请求任何外部主机，也不读任何环境变量                                                                                                       |
| 落盘                       | 唯一落盘数据是 settings 里的 `templates` 与 `importAllowRoots`                                                                                                             |
| 一次整理发给模型的全部内容 | 草稿全文、会话 cwd 路径、顶层目录条目与关键文本文件全文、真人 user/assistant 文本（框架注入消息与 tool 结果被过滤）、可选角色正文                                          |
| 摘要扩展名                 | 只取 20 种代码/文档扩展名（ts/tsx/js/jsx/mjs/cjs/py/rs/go/java/rb/json/toml/md/sql/graphql/proto/css/scss/less）；yaml/env 类不在白名单                                    |
| 敏感文件名                 | 文件名含 credential/secret/id_rsa/.pem/.p12/.pfx/keystore/.env/.key 者永不取正文                                                                                           |
| 单文件上限与并发           | 单文件超 `maxSnippetBytes`（默认 256 KiB）或大小未知即整份跳过（不喂半份摘要），读取按 `readConcurrency`（默认 8）有界并发；两位都是配置字段，也都不是卡上的控件           |
| 计数与回显                 | 超限/读失败/更深层未扫/非角色都计入 `skipped` 并回显，`truncated` 如实上报                                                                                                 |
| 导入端点                   | 只读：不调模型、不写盘。绝对路径默认拒绝，仅放行会话 cwd、包内 `agents/`、`importAllowRoots` 三类根之内，`.`/`..`/隐藏段（如 `.ssh`）一律拒，越界回 403 并回显解析后的路径 |

## 常见问题

| 现象                      | 处理                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 点了「整理」草稿没变？    | 失败不改草稿；按钮 4 秒失败态，title 写原因。常见为无会话 cwd（sessionId 缺失或会话不存在）、无模型选择、模型终态非 stop、`organizeTimeoutMs` 到点（默认 120 秒）                                                                                               |
| 模型报上下文超限？        | 目录/对话/角色正文都不截断，超限由模型报错、用户自行精简；载荷本身超配置上限（默认 8 MiB）时端点回 413                                                                                                                                                                        |
| 导入本地角色被拒？        | 绝对路径默认拒绝，且设置卡没有会话上下文（POST 的 `sessionId` 为空串），路径须落在内置 `agents/` 或已登记目录内、且不含 `.`/`..`/隐藏段；越界回执会点名允许区并回显解析后的路径                                                                                 |
| 导入条数比预期少？        | 看回执 `skipped` 四项：目录只扫顶层与一层子目录（第三层只计 `deeper`）、超 `maxSnippetBytes`（默认 256 KiB）计 `tooLarge`、frontmatter 前 20 行解析不出 name 计 `unnamed`、读失败计 `unreadable`                                                                |
| 改模板不生效 / 语言不对？ | 编辑先本地暂存，点「保存」后对新开的下拉生效；设置卡、输入框旁那两个 dock 按钮（文案与注册 label 都进了 `ui-messages.ts` 字典）、以及 host 回执都跟随官方 locale 插件的语言偏好（host 侧每请求现读，无需重启），而 agents/ 角色库与模板正文属用户数据、不做机翻 |
