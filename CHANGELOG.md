# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。最新版本在最上。

## 0.1.6

这一版收口客户端交互与错误文案，并把构建、CI 与伞工作区基线统一；模板数据与 85 条内置精选不变。

### Changed

- **宿主线抬到 `0.2.1-rc.3`**：`engines.dsh`、peer/dev 依赖、`pnpm-workspace.yaml` 的 overrides 与 README 徽标/正文同值；shared 下限随根真源投影。
- **构建编排统一进 shared 的 `lib/build-*`**：host/client/types 构建脚本只剩薄配置层，产物仍落 `dist/`。
- **润色链路的错误文案跟随界面语言**：客户端自己产生的错误（目录上下文失败、读取模型失败、输入为空、回执不可解析）改走本地化消息键，宿主回执里的原文不翻译、作为 `{message}` 原样带出。
- **超时值的非法输入回落到默认值**：`NaN`、`0`、负数与小数不再被折算成 1 ms 或负数——那会让「配错」看起来像「配了一个很小的合法值」，实际是立刻超时。
- **编辑中的草稿与写入操作互斥**：模板行、导入面板与允许根面板在保存期间禁用；保存成功后只清本次真正写下的键。
- **Remote 读面按运行期形状校验**：`ok: true` 但缺 `value` 的应答不再被当成「成功但空」；`$mount` 失败不缓存，下一次读会重试。
- **样式补兜底与可访问性**：所有 `var()` 带回落值，错误态 hover 不被基础样式覆盖，补 `:focus-visible` 与 `prefers-reduced-motion`。

### Fixed

- **同一轮事件里的第二次点击会再发一次 LLM 请求**：`loading` 要等一次重渲染才生效，两道读状态的闸门都拦不住；改为在 `await` 之前置同步在途标记。
- **新增模板行的正文会把占位提示落盘**：占位改由 textarea 的 placeholder 承担，新行正文从空串开始。
- **角色文件的代码围栏没有结束标记时只导入半篇正文**：现在直接报错并点明起始行，不再静默截断。
- **恢复默认的二次确认文案写死 4 秒**：改为按实际确认窗口插值。

### Added

- 润色链路的本地化错误消息（中英各一套）。
- 集成/属性/端到端测试与覆盖率门禁；`actionlint` 配置与更严的 CI 判据。

## 0.1.5

### Changed

- **命名与文案统一**：「整理」改为「润色」，「提示词模板」改为「模板库」，「角色视角」改为「角色风格」；中英文案、`package.json` 描述与关键字、`cordis.patch.yml` 与两份 README 同步。
- **prompt 信任序**：目录摘要、最近若干轮与角色正文改由 `buildOrganizeUser` 放进 user 消息的 `<data>` 围栏，system 只拿会话 cwd；数据行里的围栏标记先替换成 `[fence-open]` / `[fence-close]`，避免草稿自己关掉围栏。
- **客户端竞态收口**：内置快照读面加世代号，`reset` 之后晚到的应答不再写回 store；「恢复默认」与「保存」共用 busy 门禁；▾ 菜单项与主按钮同用 `loading || !canWrite`；超时下界夹到 1 ms。
- **Remote 读面**：`unwrap` 按运行期形状校验应答；`mount` 的 promise 失败后清缓存。
- **跨平台构建**：`.gitattributes` 钉 `eol=lf`；生成器用 `process.execPath` 跑 oxfmt 包内入口；构建产物改临时文件 + `rename`；核对产物里的 `BUNDLE_PKG` 与包名同源；补 `dist-size` 预算与 `.prettierignore` 第二份生成物。
- **CI 与发布**：新增三平台 × node 22/24 的 `ci.yml`、`codeql.yml`、`scorecard.yml` 与 `dependabot.yml`；`publish.yml` 改 OIDC 优先、静态 token 兜底，挂 `npm-publish` 环境、加 concurrency 与超时，action 钉 commit SHA。

### Fixed

- 内置快照 `reset` 之后可能被恢复前那次请求的旧快照覆盖。
- 「恢复默认」与「保存」并发时最后写入者赢，没有共同门禁。
- 写不回草稿时，▾ 菜单要烧完整次 LLM 往返才在写回那步报错。
- `Math.trunc` 把 `(0,1)` 的配置值取整成 0，加完余量后可能变成 0 或负数，被当成「当场超时」。

## 0.1.4

### Changed

- **`DIR_PREP_NAMESPACE` 导出并成为错误文案与宿主注册的唯一来源**：写死两处会让「网关挂的是 A、报错说的是 B」这种漂移没有任何运行期信号。
- **双语 README 补 shared 版本下限**：profile 里更低的 overrides 会装到缺具名导出的副本，表现为「装得上、永远不生效」，而单仓 CI 看不到。

## 0.1.3

### Fixed

- **导入同 slug 碰撞时 id 改写进入死循环**（会同步阻塞宿主）：改为循环内自增后缀，并加回归用例。
- **允许根包含判据只按 `/` 拆段**：win32 上合法子路径一律判越界、`..\` 漏检；改用 `path.relative` + 双分隔符拆段。
- **client 读面的模块级全局不随卸载清理**：收进 `ctx.effect` disposer，按身份比较防误清。

### Changed

- **Typert 迁移收尾**：五条 `/_dsh/dir-prep/*` 端点改为官方 `dirPrepOrganize` Remote；HTTP handler、信任/CSRF 闸门、`guardBody` 与只为 body 上限存在的 `importBodyMaxBytes` 删除，webserver 集成测试一并删除。
- 删除 `peerDependencies.react`：宿主运行时是 18.x，devDependency 保留。
- 清理迁移遗留的 HTTP 契约文本、`invalidJsonBody` 死键、指错行的证据引用与失真计数。

## 0.1.2

### Fixed

- **目录导入的软链逃逸（P0，真磁盘复现）**：`escapesAllRoots` 原先只挂在单文件分支上，目录分支整批漏掉后端复判；cwd 里一条指向根外的软链就能把根外目录里的 `.md` 连同正文整批导入。两条分支现在统一在 `resolve` 之后先过这道门。
- **单文件导入没有字节上限**：`cwd/roles.md` 直接调 `fs.readText`，不看 `maxSnippetBytes`；现在按官方 `stat` 判大小，未知或超限即跳过并计入 `skipped.tooLarge`。
- **目录枚举逐个降级**：`fs.listDir` 在 `mapBounded` worker 里没有 try/catch，一个 `chmod 000` 的子目录就让整次导入归零；现在逐个降级并计入 `skipped.unreadable`。
- **导入回填按最新草稿合并**：`onImported` 闭包用点击那一刻的草稿，等待一整次网络往返期间用户改的行会被整份旧草稿覆盖；改为函数式更新。
- **fetch 超时夹到 2^31-1**：`organizeTimeoutMs + 5000` 越界时 V8 会静默夹成 1 ms，把「调大超时」反转成「立刻失败」；取值与夹位单源挪到 `src/client-timeouts.ts`。
- **「恢复默认」纳入 busy 门禁**；「整理」按钮在 `setDraft` 不可用时禁用。

### Changed

- `@jayyuen66/dsh-plugin-shared` 从 `^0.1.4` 升到 `^0.1.5-rc`，吃进三处信任闸门修复；验证不止比版本号：`npm pack` 拉下发布产物逐条比对行为。
- 新增集成层（真磁盘 + 真 FileSystem 抽象类）：上面三条 host 缺陷都是手搓桩测不出来的。

## 0.1.2-rc

### Changed

- **宿主包整体精确钉到 `0.2.1-alpha.2`**；`@jayyuen66/dsh-plugin-shared` 升到 `^0.1.4`，工具链随 catalog 更新。
- **`servingNonLoopback` 改由 shared 的 `isNonLoopbackBindHost` 取**：宿主把 `Config.host` 收成任意本机接口 IP 字面量、通配地址在载入即拒，旧的 `=== "0.0.0.0"` 恒为 false，局域网请求整片吃 403 而本地门禁全绿。
- **peerDependencies 补齐声明产物点名却未认领的宿主包**，写成 optional；值导入的 `dsh-brand` 与 `schemastery` 保持必选。
- 升级带来的声明行号位移逐条对表修正。

## 0.1.1

### Added

- `THIRD_PARTY_NOTICES.md`：内置角色库来自上游 agency-agents-zh（MIT），照录版权与许可原文；`LICENSE` 末尾加指向。
- `types/` 声明产物随包发布；源码里的显式 `.ts` 后缀在声明阶段改写成 `.js`。
- `engines.node >=22.12`、bugs/homepage/sideEffects；发布流水线补 `--provenance` 与发布后可取性校验。

### Changed

- 内置精选模板表移出 `host.js`，独立为 `templates.data.mjs`，首次请求才 import；`host.js` 从数百 KB 降到几十 KB。
- 删除 `agents/integrations/`（面向外部工具的转换件，对 dsh 无作用）；已验证精选模板逐字节不变。
- 删除与 `prepack` 重复的 `prepare`；CI 三个 action 改钉 commit SHA。

### Fixed

- `check` 补上 `build:types`：此前校验的声明产物压根没被构建过。
- 发布清单门禁覆盖入口面、第三方声明、运行期产物、声明覆盖全部导出，以及不泄漏本机或包管理器内部路径。

## 0.1.0

首个发布版本。此前 1.0.0 与 0.6.x 已被 npm 永久记录，统一以 0.1.0 为首个发布号，依赖范围同步改为 `^0.1.0`；发布凭据改以 `NODE_AUTH_TOKEN` 注入 publish 那一步，token 形态校验保留且只读不写盘；lockfile 随依赖范围重解。
