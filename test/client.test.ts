// @vitest-environment happy-dom
// src/client-entry.ts 契约测试（真实 React 19 + happy-dom 渲染，不写假 React）。
//
// 分层（与 session-rescue 的 client-ui.test.ts 同款）：
//   · 纯函数（formatContextSummary / applyTemplateToDraft / persistError /
//     formatImportSkips）直调断言；
//   · 组件走 apply(ctx) 装配出来的真实 slot 组件树挂载，按 DOM 断言；
//     交互优先直调 React props（happy-dom 合成事件到不了 React 19 root 监听器，
//     已在前一个包里实证），button.click() 在真实链路上可用；
//   · 一切网络都经 fetch 桩；模型/设置服务都是假对象 —— 绝不打真实模型。
//
// 审计修复的锁死点：
//   · 「以角色视角整理」POST 必须带 roleText（host 侧已修，这里是客户端半程）；
//   · 被宿主拒绝的保存不得显示成功（mutate 不 reject，故复读快照比对）；
//   · 导入省略计数必须显示；
//   · crypto.randomUUID 不可用时新增模板仍可用。
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React, { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  apply as clientApply,
  applyTemplateToDraft,
  builtinTemplatesSnapshot,
  formatContextSummary,
  formatImportSkips,
  loadBuiltinTemplates,
  persistError,
  rootsPersistError,
  rawOrganizeTimeoutMsOf,
  resetBuiltinTemplates,
  subscribeBuiltinTemplates,
  inject as clientInject,
} from "../src/client-entry.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import type { Translate, UiMessages } from "../src/ui-messages.ts";
import { DEFAULT_TEMPLATES } from "../src/templates.ts";
import type { TemplateEntry } from "../src/templates.ts";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";

/** 官方快照面（7 位全必选）。桩件与全部 fixture 都用它，不再是本包自抄的四位形状：
 *  官方面加一位（base/user/mode 这类）这里就编译失败，而不是等真宿主来告诉测试。 */
type FormSnapshot = ConfigFormSnapshot<Record<string, unknown>>;

/**
 * 官方 `ConfigFormSnapshot` 的合法形状：base/user 是组装层与用户层原文，mode 是宿主
 * 持久化模式——首个快照受理前 value/revision 为 undefined，正是卡片要渲染「还没数据」
 * 的那一态。
 * ⚠ 默认 `value` 必须是**真宿主在「用户从没动过模板」时交出的形状**，不是 `{}`：
 * host 半的 `templates` 不给默认，但 schemastery 对 array 字段把缺失值 cast 成 `[]`，
 * 宿主 describe() 的 projectForm 只丢 undefined 位，于是空表原样递到客户端。桩件写成
 * `{}` 会让「回落内置」这条路只在测试里成立、真页面是空的（实测踩过）。
 */
function snap(over: Partial<FormSnapshot> = {}): FormSnapshot {
  return {
    status: "ready",
    value: { templates: [], importAllowRoots: [] },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: "host",
    ...over,
  };
}

/** 本包目录（happy-dom 换掉了全局 URL，故一律用 node:path 拼，见下方用例同款注释）。 */
const PKG_DIR = path.join(import.meta.dirname, "..");

/**
 * 宿主 profile（`~/.dsh/profiles/web/package.json` → `dsh.profile.bundles`）里本包那一条，
 * 也就是 `plugins.bundle.config` 唯一能命中的 key（宿主派发 `entryKey: pkg.name`：installed
 * dsh-client-ui-plugin-manager/lib/client.js:1821，pkg.name = bundle.name：:306/:320；槽契约
 * slot-contract.d.ts:96-100「keyed by the bundle's package name」；匹配是逐字相等：
 * dsh-client-ui-renderer/lib/client.js:1154 → 写成裸条目 id 就是整张卡不渲染）。
 * **解析**而不是在测试里抄一份：抄一份同样的错值就一直绿，这正是此前漏掉的原因。
 * 同时钉住 profile 的 link 目标就是本目录，避免比到另一份残留副本。
 */
async function profileBundleName(): Promise<string> {
  const own = JSON.parse(await readFile(path.join(PKG_DIR, "package.json"), "utf8")) as unknown as {
    name?: unknown;
  };
  assert.equal(typeof own.name, "string", "本包 package.json 有 name");
  const pkgName = String(own.name);
  // 宿主派发插件页的 entryKey 就是被装 bundle 的包名（= 本包 package.json.name，与装法无关），
  // 核心判据不依赖 profile。profile 只在这台开发机上存在，装了才顺手钉两道机器侧针：
  // 清单里恰有一条、link 目标就是本目录（避免比到另一份残留副本）。
  // 本包 node/no-sync 不放行 existsSync，故直接读并按 ENOENT 判缺失（其余错误照抛）。
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  const profilePath =
    override === "" ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json") : override;
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return pkgName;
    }
    throw error;
  }
  const profile = JSON.parse(raw) as {
    dependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
  };
  const bundles: unknown = profile.dsh?.profile?.bundles;
  assert.ok(Array.isArray(bundles), `${profilePath} 的 dsh.profile.bundles 应是数组`);
  // link 指向的是"哪一份检出"：本机 profile 装的就是这一份时，才顺手钉"清单里恰有一条、
  // 且只指向本目录"这两道机器侧针（改名/残留副本没人拦就是真缺陷）。指向别处时（单包仓的
  // 暂存副本、消费者自己的检出）这条针不适用 —— 拿别的机器的安装状态判红等于把开发机
  // 状态写进包测试，故跳过而不是失败。
  const installedHere: unknown = profile.dependencies?.[pkgName];
  if (!(typeof installedHere === "string" && installedHere.includes(PKG_DIR))) {
    return pkgName;
  }
  assert.deepEqual(
    (bundles as unknown[]).filter((item) => item === pkgName),
    [pkgName],
    "本包在 profile 的 bundles 清单里，且只列一次",
  );
  const link: unknown = profile.dependencies?.[pkgName];
  assert.equal(typeof link, "string", "profile 的 dependencies 指向本包");
  assert.ok(
    typeof link === "string" && link.includes(PKG_DIR),
    `profile 的 link 目标应是本目录（实得 ${String(link)}）`,
  );
  return pkgName;
}

/** 本包 cordis.patch.yml 声明的裸条目 id（0.1.7 的 settings 命名空间）。 */
async function patchEntryIds(): Promise<string[]> {
  const patch = await readFile(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  return [...patch.matchAll(/^\s*(?:-\s+)?id:\s*(?<id>\S+)\s*$/gmu)].map(
    (row) => row.groups?.["id"] ?? "",
  );
}

// ── 卡片双语测试助手（样板包 ctx-observe/test/client-card.test.ts 同款）──────

/** 官方 locale 的 `{name}` 插值（宿主同语义）：测试里自己实现，不引宿主内部实现。
 *  形参名用 template 而非 text：本文件已有取 DOM 文本的 text() 助手，避免 no-shadow。 */
function fillTemplate(template: string, params: Record<string, unknown>): string {
  return template.replaceAll(/\{(?<key>\w+)\}/gu, (_all: string, key: string) => {
    const value = params[key];
    if (typeof value === "number") {
      return String(value);
    }
    return typeof value === "string" ? value : "";
  });
}

/** 模板里的 {占位符} 名字清单（不具名捕获组，避开 dot-notation 与 TS4111 的相互要求）。 */
function placeholders(template: string): Set<string> {
  return new Set(template.split(/[{}]/u).filter((piece) => /^\w+$/u.test(piece)));
}

/**
 * 官方 locale 的取值语义（测试侧复刻）：本包字典命中即用，未命中回落**键名本身**
 * （官方 `LocaleRuntime.lookup` 在 active 语言与 fallback 链都 miss 后的行为）。
 * 表按 `Record<string, string>` 承载而不是 `UiMessages`：merge 进 `LocaleNamespaceMap`
 * 之后 `TranslateNS<NS>` 的键域是「本包键 ∪ common 命名空间键」（官方 `LocaleKeysOf`），
 * 按 `UiMessages` 索引那条并集在编译期就红。展开成字面量是为了拿到隐式索引签名
 * （`UiMessages` 是 interface，本身给不出）。
 */
function localeText(
  dict: Record<string, string>,
  key: string,
  params: Record<string, unknown>,
): string {
  return fillTemplate(dict[key] ?? key, params);
}

const zhTable: Record<string, string> = { ...UI_MESSAGES.zh };
const enTable: Record<string, string> = { ...UI_MESSAGES.en };

/** 中文 translator：既有断言里的中文串因此与 i18n 迁移前完全一致。 */
const tZh: Translate = (key, params) => localeText(zhTable, key, params ?? {});

// ── fetch 桩 ───────────────────────────────────────────────────────────────

interface FetchRoute {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwOn?: "abort" | "network" | "http";
  /** true = 非 2xx 且响应体不是 JSON（网关错误页形状）。 */
  jsonThrows?: boolean;
}

/** fetch 实收到的 init（只取断言用到的三面；经守卫投影而非 as 断言）。 */
interface FetchInit {
  method?: string;
  headers?: Headers;
  body?: string;
  signal?: AbortSignal;
}

interface FetchCall {
  url: string;
  init: FetchInit;
}

const fetchCalls: FetchCall[] = [];

/** 与 src/client-entry.ts 一致的端点常量（断言 fetch 序列用）。 */
const CONTEXT_URL = "/_dsh/dir-prep/context";
const MODEL_URL = "/_dsh/dir-prep/model";
const ORGANIZE_URL = "/_dsh/dir-prep/organize";
const IMPORT_URL = "/_dsh/dir-prep/import";
const DEFAULTS_URL = "/_dsh/dir-prep/default-templates";

// ── DOM 针脚 / 槽位名 / 夹具值单源（本文件里重复 3 次以上的字面量集中在此）───
// 值一律**在本文件写死**，不 import 生产模块的同名常量：断言要钉的是「实现交出什么」，
// 拿实现自己的常量去比实现自己就没人检查任何东西了（同上方端点常量的口径）。

/** 框架槽名（inject/register 两侧与断言里读注册表用的都是这两条）。 */
const SLOT_INPUT_RIGHT = "conversation.input.right";
const SLOT_BUNDLE_CONFIG = "plugins.bundle.config";

/** 本包条目 id：settings 命名空间 / dock 注册项 id / cordis.patch.yml 裸 id 同一位。 */
const ENTRY_ID = "dir-prep-organize";

/** 组件写进 DOM 的 data-field 针脚（byField/byFields/buttonByField/stateOf 的入参）。 */
const FIELD_ORGANIZE_BTN = "dpi-organize-btn";
const FIELD_ORGANIZE_CARET = "dpi-organize-caret";
const FIELD_ORGANIZE_MENU = "dpi-organize-menu";
const FIELD_ORGANIZE_ROLE_ITEM = "dpi-organize-role-item";
const FIELD_TEMPLATE_ITEM = "dpi-template-item";
const FIELD_TEMPLATE_MENU = "dpi-template-menu";

/** 设置卡输入框的 CSS 选择器（inputByClass/rowValue/pressEnterOn 的入参，含前导点）。 */
const CLS_NAME = ".dpic-name";
const CLS_TEXT = ".dpic-text";
const CLS_EMOJI = ".dpic-emoji";
const CLS_IMPORT_PATH = ".dpic-importpath";

/** 内置表响应不是对象时客户端自己补的那句原因（没有 host 原文可带）。 */
const BAD_PAYLOAD_ERROR = "内置模板响应不是合法载荷";

/** 角色目录夹具：导入路径与「导入允许目录」都用绝对路径形状。 */
const ROLES_DIR = "/Users/me/roles";
const LIBRARY_DIR = "/Users/x/library";
const AGENCY_ZH_DIR = "/Users/me/agency-agents-zh";
const OTHER_ROLES_DIR = "/Users/other/roles";

// 刻意手抄：test/ 不引运行时依赖，真源见 shared/lib/record.ts。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** fetch init 投影（client 侧经 `new Headers()` 传头，故 headers 是 Headers 实例）。 */
function fetchInitOf(value: unknown): FetchInit {
  const rec = isRecord(value) ? value : {};
  const { method, headers, body, signal } = rec;
  return {
    ...(typeof method === "string" ? { method } : {}),
    ...(headers instanceof Headers ? { headers } : {}),
    ...(typeof body === "string" ? { body } : {}),
    ...(signal instanceof AbortSignal ? { signal } : {}),
  };
}

type Router = (url: string, init: FetchInit) => FetchRoute | Promise<FetchRoute>;

function stubFetch(router: Router): void {
  fetchCalls.length = 0;
  vi.stubGlobal(
    "fetch",
    async (
      url: unknown,
      init: unknown,
    ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> => {
      const urlText = String(url);
      fetchCalls.push({ url: urlText, init: fetchInitOf(init) });
      const route = await router(urlText, fetchInitOf(init));
      if (route.throwOn === "abort") {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      if (route.throwOn === "network") {
        throw new Error("carrier down");
      }
      if (route.throwOn === "http") {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (route.jsonThrows === true) {
        return {
          ok: route.ok ?? true,
          status: route.status ?? 200,
          json: async (): Promise<unknown> => {
            throw new Error("body is not JSON");
          },
        };
      }
      return {
        ok: route.ok ?? true,
        status: route.status ?? 200,
        json: async () => route.body,
      };
    },
  );
}

/** 整理三端点的默认成功路由（context/model 带 csrf）。 */
function stubOrganizeOk(roleBody?: unknown): void {
  stubFetch((url) => {
    if (url.startsWith(CONTEXT_URL)) {
      return {
        body: {
          ok: true,
          csrf: "tok-ctx",
          cwd: "/w",
          truncated: false,
          entries: [
            { name: "sub", isDir: true, sizeBytes: 0 },
            { name: "a.ts", isDir: false, sizeBytes: 2048, snippet: "export const a" },
            { name: "b.md", isDir: false, sizeBytes: 9 },
          ],
        },
      };
    }
    if (url.startsWith(MODEL_URL)) {
      return { body: { ok: true, csrf: "tok-model", provider: "p", model: "m" } };
    }
    if (url.startsWith(DEFAULTS_URL)) {
      return { body: { ok: true, templates: DEFAULT_TEMPLATES } };
    }
    return { body: roleBody ?? { ok: true, content: "整理后的要求" } };
  });
}

/** 内置表端点的桩（表已挪到 host 侧，dock/卡片的兜底列表靠拉这一发）。
 *  ok=回精选集；fail=200 带 {ok:false}；network=传输层直接抛。 */
function stubBuiltinTemplates(
  mode: "ok" | "fail" | "network" = "ok",
  templates: unknown = DEFAULT_TEMPLATES,
): void {
  stubFetch((url) => {
    if (!url.startsWith(DEFAULTS_URL)) {
      return { body: { ok: true } };
    }
    if (mode === "network") {
      return { throwOn: "network" };
    }
    return {
      body: mode === "ok" ? { ok: true, templates } : { ok: false, error: "内置表暂不可用" },
    };
  });
}

/** 内置表端点的响应形状（桩件与断言共用，别让 release 收 unknown）。 */
interface BuiltinBody {
  ok: boolean;
  templates?: unknown;
  error?: string;
}

/** 悬住的内置表桩：用来断"还没到"的那一行，release 后再断换代。 */
function stubBuiltinPending(): { release: (body?: BuiltinBody) => void } {
  const gate = Promise.withResolvers<BuiltinBody>();
  stubFetch(async (url) => {
    if (!url.startsWith(DEFAULTS_URL)) {
      return { body: { ok: true } };
    }
    return { body: await gate.promise };
  });
  return {
    release: (body) => {
      gate.resolve(body ?? { ok: true, templates: DEFAULT_TEMPLATES });
    },
  };
}

/** 只数内置表端点被打了几个（轮询/复用面的观测量）。 */
function defaultsCallCount(): number {
  return fetchCalls.filter((call) => call.url.startsWith(DEFAULTS_URL)).length;
}

/** 让出一个宏任务边界：fetch/then 链（纯微任务）全部落地后再断言。 */
async function flush(): Promise<void> {
  await act(async () => {
    const gate = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => {
      gate.resolve(undefined);
    }, 0);
    await gate.promise;
    clearTimeout(timer);
  });
}

// ── 配置表单假实现（可模拟"宿主拒绝写入但 set 不 reject"）────────────────────

/** 表单假实现 = 官方 `ConfigForm<Record<string, unknown>>`（getSnapshot / subscribe /
 *  mutate / set / unset 五成员全必选）加测试侧的轨迹与绊线。`extends` 是**编译期**契约：
 *  官方面加一位或改一位签名，这里立刻编译失败（旧的自抄四成员面正缺 `mutate`）。 */
interface FakeScope extends ConfigForm<Record<string, unknown>> {
  /** 绊线：`ConfigForm` 面里没有 dispose，表单归 provider 长活。
   *  这里刻意留一个**必抛**的成员——client 侧一旦把 `scope.dispose()` 写回 disposer，
   *  立刻炸在这里，而不是"看似干净退出、之后每次保存被静默丢弃"。 */
  dispose: () => never;
  /** 测试侧写入并广播（模拟 host 回读后的快照变化）。 */
  commit: (next: FormSnapshot) => void;
  writes: { field: string; value: unknown }[];
  unsets: string[];
  /** false = 宿主拒绝：set 正常 resolve(false) 但快照不变（审计复现的失败模式）。 */
  acceptWrites: boolean;
  /** true = 写入被收下，但宿主回读源随即转为未就绪（回执"不可确认"的形状）。 */
  goesStaleOnWrite: boolean;
}

function makeScope(initial: FormSnapshot): FakeScope {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  /** 换代即换引用：card store 的 memo 靠引用相等判「未换代」。 */
  const commit = (next: FormSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const scope: FakeScope = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    writes: [],
    unsets: [],
    acceptWrites: true,
    goesStaleOnWrite: false,
    dispose: (): never => {
      throw new Error("configForms.get() 交回的是 provider 持有的共享表单，不得 dispose");
    },
    // 官方第五位（路径级原子批量写）：本包卡片的保存始终逐字段走 set/unset，故这里
    // 只满足类型面，并在被调用时明确失败——静默返回 true 会让「走了批量写」这件事
    // 变成一次没人发现的假成功。
    mutate: (): Promise<boolean> => {
      throw new Error("本卡按字段写走 set/unset，不应触达官方 mutate（批量原子写）");
    },
    async set(field, value) {
      scope.writes.push({ field, value });
      if (!scope.acceptWrites) {
        // 宿主拒绝：官方的 set resolve(false) 且快照不变（不 reject）。
        return false;
      }
      commit({
        ...snapshot,
        revision: (snapshot.revision ?? 0) + 1,
        status: scope.goesStaleOnWrite ? "unavailable" : snapshot.status,
        value: { ...snapshot.value, [field]: value },
      });
      return true;
    },
    async unset(field) {
      scope.unsets.push(field);
      if (!scope.acceptWrites) {
        return false;
      }
      // unset 之后宿主不是把键抹掉，而是按 schema 重新求值该 array 字段 → 空表
      // （与上方 snap() 默认 value 同一真值口径，见 client-entry.ts 的 fromSettings 注释）。
      commit({
        ...snapshot,
        revision: (snapshot.revision ?? 0) + 1,
        value: { ...snapshot.value, [field]: [] },
      });
      return true;
    },
    commit,
  };
  return scope;
}

const READY: FormSnapshot = snap({
  value: {
    templates: [{ id: "t1", name: "甲", description: "", text: "正文甲", group: "", emoji: "" }],
  },
  revision: 3,
});

const TPL: TemplateEntry = {
  id: "t1",
  name: "甲",
  description: "",
  text: "正文甲",
  group: "",
  emoji: "",
};

// ── client ctx 假实现（slots / configForms / effect）────────────────────────

interface SlotReg {
  name: string;
  id?: string;
  key?: string;
  order?: number;
  label?: string | (() => string);
  locale?: string;
  inject?: () => Record<string, unknown>;
  component: unknown;
}

interface MockCtx {
  registers: SlotReg[];
  slotFactories: Map<string, () => (() => void) | undefined>;
  disposers: (() => void)[];
  scope: FakeScope;
  /** apply 向 `configForms.get()` 要过哪些条目 id（0.1.7 里它就是 settings 命名空间）。 */
  formEntryIds: string[];
  /** 注册进官方 locale 的入参（命名空间 + 一次交齐的两语字典），供双语断言。
   *  元素形状从生产侧的 register 签名派生，桩件与生产不会各自漂移。 */
  localeCalls: { ns: Parameters<LocaleSeat["register"]>[0]; dicts: LocaleDictArg }[];
  effect: (factory: () => (() => void) | undefined, label?: string) => void;
  slots: {
    inject: (slot: string, factory: () => (() => void) | undefined) => void;
    register: (desc: SlotReg, view: unknown) => () => void;
  };
  configForms: { get: (entryId: string) => FakeScope };
  /** 生产 `apply` 的那一位原样引用：桩件实现一改形状即编译期红。 */
  locale: LocaleSeat;
}

/** 生产 ClientCtx（未导出，但可从 apply 的入参取到）——桩件的 locale 面跟着它走。 */
type ApplyCtx = Parameters<typeof clientApply>[0];
/** 官方类型化 register 的字典参数（两语目录），同样从生产侧派生。 */
type LocaleDictArg = Parameters<ApplyCtx["locale"]["register"]>[1];
type LocaleSeat = ApplyCtx["locale"];

/** 本轮尚未清理的 ctx。
 *  每个用例都会 clientApply() 一次，而 client 的样式标签只在 effect disposer 里移除：
 *  用例不主动 drain 时，document.head 会随用例数堆出几十个同 id 的
 *  #dir-prep-organize-css，卸载用例的 querySelector 因此读到"上一个用例的标签"，
 *  断言失败 → node:assert 对 happy-dom 元素做深比较 diff（实测 createErrDiff
 *  指数级展开到 ~6GB，worker 被 SIGKILL，整个文件后半 15 个用例全丢）。
 *  故 afterEach 统一 drain：用例开始时 document 干净，卸载断言才只看得见自己的标签。 */
const liveCtxs: MockCtx[] = [];

/** 跑掉并摘除该 ctx 已登记的 effect 清理（跑过的不会重复跑）。 */
function drainDisposers(ctx: MockCtx): void {
  const pending = [...ctx.disposers];
  ctx.disposers.length = 0;
  for (const dispose of pending) {
    dispose();
  }
}

/** 装配一个 ctx（translator 默认中文；双语用例传 tEn 走同一渲染路径）。 */
/** mountAll 每轮刷新：从 dock 注册项的 inject 真实抽出 t/useCard（生产里 t 来自
 *  `locale: NS` 声明合成的 seat、useCard 来自 hooks 间隔——这里用同一 translator 与
 *  useCardOf 等价替代）。 */
let dockKit: { t: Translate; useCard: KitProps["useCard"] } | null = null;

function dockKitProps(): { t: Translate; useCard: KitProps["useCard"] } {
  assert.ok(dockKit, "dockKitProps 需先 mountAll");
  return dockKit;
}

/** client templatesStore 的快照形状（store 按原始快照身份缓存 → 引用稳定）。 */
interface SnapshotView {
  templates: TemplateEntry[];
  fromSettings: boolean;
  allowRoots: string[];
  ready: boolean;
  writable: boolean;
}

function isSnapshotView(value: unknown): value is SnapshotView {
  if (!isRecord(value)) {
    return false;
  }
  const { templates, fromSettings, allowRoots, ready, writable } = value;
  return (
    Array.isArray(templates) &&
    typeof fromSettings === "boolean" &&
    Array.isArray(allowRoots) &&
    typeof ready === "boolean" &&
    typeof writable === "boolean"
  );
}

interface StoreView {
  getSnapshot: () => unknown;
  subscribe: (listener: () => void) => () => void;
  readBack: () => unknown;
}

function isStoreView(value: unknown): value is StoreView {
  return (
    isRecord(value) &&
    typeof value["getSnapshot"] === "function" &&
    typeof value["subscribe"] === "function" &&
    typeof value["readBack"] === "function"
  );
}

/** 框架侧 hooks.card → useCard 的等价适配器：直连**真** store 的 getSnapshot。 */
/** 宿主同款语义的订阅型 hook 替身。官方把 inject 的 {getSnapshot, subscribe} 映射成
 *  useCard（src 组件不得直呼 useSyncExternalStore），替身若只静态读一次快照，"内置表
 *  到达"这类**非表单变更**的换代在测试里永远看不见——兜底列表就成了测不到的死支。 */
function useCardOf(store: StoreView): (selector: (snap: SnapshotView) => unknown) => unknown {
  return (selector) => {
    const view = useSyncExternalStore(store.subscribe, () => {
      const snapshot = store.getSnapshot();
      assert.ok(isSnapshotView(snapshot), "store 快照形状合法");
      return snapshot;
    });
    return selector(view);
  };
}

function makeCtx(snapshot: FormSnapshot = READY, translator: Translate = tZh): MockCtx {
  const scope = makeScope(snapshot);
  const registers: SlotReg[] = [];
  const ctx: MockCtx = {
    registers,
    slotFactories: new Map(),
    disposers: [],
    scope,
    formEntryIds: [],
    localeCalls: [],
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") {
        ctx.disposers.push(dispose);
      }
    },
    slots: {
      inject(slot, factory) {
        ctx.slotFactories.set(slot, factory);
      },
      register(desc, view) {
        registers.push({ ...desc, component: view });
        return () => {
          const idx = registers.findIndex(
            (item) => item.name === desc.name && item.component === view,
          );
          if (idx !== -1) {
            registers.splice(idx, 1);
          }
        };
      },
    },
    configForms: {
      get(entryId) {
        ctx.formEntryIds.push(entryId);
        return scope;
      },
    },
    locale: {
      register(ns, dicts) {
        ctx.localeCalls.push({ ns, dicts });
        return () => {
          void 0;
        };
      },
      bind: () => translator,
    },
  };
  liveCtxs.push(ctx);
  return ctx;
}

/** 装配并取出三个组件（两个输入框按钮 + 设置卡）。 */
function mountAll(
  snapshot?: FormSnapshot,
  translator: Translate = tZh,
): {
  ctx: MockCtx;
  organize: React.ComponentType<Record<string, unknown>>;
  template: React.ComponentType<Record<string, unknown>>;
  card: React.ComponentType<Record<string, unknown>>;
  cardInject: () => Record<string, unknown>;
} {
  const ctx = makeCtx(snapshot, translator);
  clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
  ctx.slotFactories.get(SLOT_INPUT_RIGHT)?.();
  ctx.slotFactories.get(SLOT_BUNDLE_CONFIG)?.();
  const configFactory = ctx.slotFactories.get(SLOT_BUNDLE_CONFIG);
  assert.ok(configFactory, "config 槽已注入");
  const settingsReg = ctx.registers.find((reg) => reg.name === SLOT_BUNDLE_CONFIG);
  assert.ok(settingsReg?.inject);
  const dockRegs = ctx.registers.filter((reg) => reg.name === SLOT_INPUT_RIGHT);
  assert.equal(dockRegs.length, 2, "整理 + 模板两个按钮");
  // dock 注册契约（官方 slots.md）：locale 声明（框架合成 t seat）+ inject hooks 间隔
  // （裸 getSnapshot/subscribe 源 → useCard，组件不直呼 useSyncExternalStore），
  // 且与设置卡共享同一 store 实例。
  for (const reg of dockRegs) {
    assert.equal(reg.locale, ENTRY_ID, "dock 注册声明 locale 命名空间");
    assert.ok(typeof reg.inject === "function", "dock 注册带 inject 工厂");
  }
  // label 是 thunk（官方 SlotLabel：thunks follow the active locale），调用一次既验证
  // 字典键又覆盖 thunk 本体。
  const dockLabels = dockRegs.map((reg) => reg.label);
  assert.ok(
    typeof dockLabels[0] === "function" && typeof dockLabels[1] === "function",
    "两个 dock label 都是 thunk",
  );
  assert.equal(dockLabels[0](), translator("dockOrganizeEntry"), "整理 label 走 dock 字典");
  assert.equal(dockLabels[1](), translator("dockTemplatesEntry"), "模板 label 走 dock 字典");
  const cardInjected = settingsReg.inject() as unknown as CardInject;
  assert.ok(isStoreView(cardInjected.hooks.card), "设置卡 hooks.card 是 templatesStore");
  const dockInjected = dockRegs[0]!.inject?.() as { hooks: { card: unknown } } | undefined;
  assert.ok(
    dockInjected !== undefined && isStoreView(dockInjected.hooks.card),
    "dock inject 的 hooks.card 是 templatesStore",
  );
  // 上一条 assert.ok 已经把 dockInjected 收窄成非空（node 的 ok 是 asserts value），
  // 这里再判一次 undefined 在类型面上恒真 ⇒ 只留真正的共享实例判据。
  assert.ok(
    dockInjected.hooks.card === cardInjected.hooks.card,
    "dock 与设置卡共享同一 store 实例",
  );
  dockKit = {
    t: translator,
    useCard: useCardOf(dockInjected.hooks.card),
  };
  return {
    ctx,
    organize: dockRegs[0]!.component as React.ComponentType<Record<string, unknown>>,
    template: dockRegs[1]!.component as React.ComponentType<Record<string, unknown>>,
    card: settingsReg.component as React.ComponentType<Record<string, unknown>>,
    cardInject: settingsReg.inject,
  };
}

// ── DOM 挂载工具 ────────────────────────────────────────────────────────────

let root: Root | null = null;
let container: HTMLDivElement;

/** 草稿写入记录（kitProps 的 setDraft 落点；beforeEach 清空）。 */
const writes: string[] = [];

async function mount(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(ui);
  });
}

/** 重挂同一组件树（受控 props 变更后跟随）。 */
async function rerender(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    root?.render(ui);
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
}

function text(): string {
  // container 是 div：DOM 契约里元素的 textContent 只可能是 string（空元素回 ""，
  // null 只出现在 document / doctype 上），故 `?? ""` 是类型面与运行时都成立的冗余守卫。
  return container.textContent;
}

function byField(field: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-field="${field}"]`);
}

function byFields(field: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-field="${field}"]`)];
}

/** data-state 直读（unicorn/prefer-dom-node-dataset：DOM 上不写 getAttribute）。 */
function stateOf(field: string): string | undefined {
  const node = byField(field);
  return node?.dataset["state"];
}

function textOf(node: Element | null): string {
  return node?.textContent ?? "";
}

function allButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonByField(field: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[data-field="${field}"]`);
}

function buttonWithText(label: string): HTMLButtonElement | null {
  return allButtons().find((button) => textOf(button).trim() === label) ?? null;
}

function buttonContaining(label: string): HTMLButtonElement | null {
  return allButtons().find((button) => textOf(button).includes(label)) ?? null;
}

/** 点按钮 + 让异步链路（fetch/then）跑完。 */
async function press(target: HTMLElement | null): Promise<void> {
  assert.ok(target, "按钮存在");
  await act(async () => {
    target.click();
  });
  await flush();
}

/** React 19 挂在节点上的真实 props（绕过 happy-dom 合成事件层）。
 *  `__reactProps$…` 是 DOM 节点上的自有属性，Element 类型面没有索引签名，
 *  故整体收窄一次（测试面专用；src 侧禁同类断言）。 */
function reactPropsOf(node: Element): Record<string, unknown> {
  const holder = node as unknown as Record<string, unknown>;
  const key = Object.keys(holder).find((name) => name.startsWith("__reactProps$"));
  assert.ok(key !== undefined, "取到 React props 键");
  const props = holder[key];
  assert.ok(isRecord(props), "React props 是对象");
  return props;
}

/** 事件 handler 的统一调用面（事件对象按 unknown 传入，组件按各自形状取用）。 */
type DomHandler = (event?: unknown) => void;

/** 取节点上某个 React 事件 prop：先 typeof 断言（形状不对立刻红），再收窄调用面。 */
function handlerOf(node: Element, name: string): DomHandler {
  const handler = reactPropsOf(node)[name];
  assert.equal(typeof handler, "function", `${name} 必须是函数`);
  return handler as DomHandler;
}

/** POST body 的 JSON → 对象（unknown 经守卫投影，不经 as 断言）。 */
function jsonRecordOf(source: string | undefined): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source ?? "{}");
  assert.ok(isRecord(parsed), "请求体是 JSON 对象");
  return parsed;
}

/** 直调 React onChange（happy-dom 合成事件到不了 React 19 root 监听器）。 */
async function type(node: HTMLElement | null, value: string): Promise<void> {
  assert.ok(node, "输入框存在");
  await act(async () => {
    handlerOf(node, "onChange")({ target: { value } });
  });
}

/** 直调 React onBlur（设置卡"失焦即上报草稿"路径）。 */
async function blur(node: HTMLElement | null): Promise<void> {
  assert.ok(node, "输入框存在");
  await act(async () => {
    handlerOf(node, "onBlur")();
  });
}

/** 直调 React onKeyDown（导入框回车即导入）。 */
async function pressKey(node: HTMLElement | null, key: string): Promise<void> {
  assert.ok(node, "输入框存在");
  await act(async () => {
    handlerOf(node, "onKeyDown")({ key });
  });
}

/** 直调按钮的 React onClick（绕过 disabled 的 DOM 门禁，验证组件自身门禁）。 */
async function clickViaProps(node: HTMLElement | null): Promise<void> {
  assert.ok(node, "按钮存在");
  await act(async () => {
    handlerOf(node, "onClick")();
  });
  await flush();
}

/** DOM 夹具与全局复位。两条规则一起钉死写法：require-top-level-describe 不许钩子躺在
 *  文件根上，require-hook 又不许套件体里出现裸的 setup 语句（把钩子登记藏在具名函数里
 *  再调用，同样算 setup 代码）⇒ 这里只导出**钩子体本身**，由每个顶层套件在体首用
 *  `beforeEach(domFixtureSetup)` / `afterEach(domFixtureTeardown)` 各登记一次。
 *  17 个套件登记的是同两个函数，效果与原文件级钩子逐字等价（每个用例前后各跑一遍、
 *  顺序不变），打印出来的套件名也不受牵连。 */
function domFixtureSetup(): void {
  container = document.createElement("div");
  document.body.append(container);
  writes.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
    writable: true,
  });
  fetchCalls.length = 0;
}

async function domFixtureTeardown(): Promise<void> {
  await unmount();
  container.remove();
  const lingering = [...liveCtxs];
  liveCtxs.length = 0;
  for (const ctx of lingering) {
    drainDisposers(ctx);
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // 内置表是模块级缓存（跨用例存活）：不复位会让上一个用例拉到的表串进下一个断言。
  resetBuiltinTemplates();
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────
describe("formatContextSummary", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("目录在前、文件在后，大小按 KB/B 分档，snippet 折行压平", () => {
    const out = formatContextSummary({
      ok: true,
      cwd: "/w",
      truncated: false,
      entries: [
        { name: "sub", isDir: true, sizeBytes: 0 },
        { name: "big.ts", isDir: false, sizeBytes: 4096, snippet: "第一行\n第二行" },
        { name: "small.ts", isDir: false, sizeBytes: 512 },
        { name: "blank.ts", isDir: false, sizeBytes: 0, snippet: "" },
      ],
    });
    assert.match(out, /当前目录: \/w/u);
    assert.match(out, /文件 3 个, 目录 1 个/u);
    assert.ok(out.indexOf("📁 sub/") < out.indexOf("📄 big.ts"), "目录排在文件前");
    assert.match(out, /big\.ts \(4\.0KB\)/u);
    assert.match(out, /small\.ts \(512B\)/u);
    assert.match(out, /第一行 第二行/u, "snippet 换行压平");
    assert.ok(!out.includes("blank.ts   ↳"), "空 snippet 不加箭头");
  });

  it("宿主报了截断 → 摘要必须声明「目录树不完整」（否则模型把没扫到的当成不存在）", () => {
    const out = formatContextSummary({
      ok: true,
      cwd: "/w",
      truncated: true,
      entries: [{ name: "a.ts", isDir: false, sizeBytes: 9 }],
    });
    assert.match(out, /按上限截断/u);
    assert.match(out, /勿据此判断文件不存在/u);
    const plain = formatContextSummary({ ok: true, cwd: "/w", entries: [] });
    assert.ok(!plain.includes("截断"), "未截断时不多塞一行");
  });

  it("无 cwd / 无 entries → 仍产出可发送的摘要头", () => {
    assert.equal(formatContextSummary({ ok: true }).split("\n")[0], "当前目录: (未提供)");
    assert.match(formatContextSummary({ ok: true, entries: [] }), /文件 0 个, 目录 0 个/u);
  });
});
describe("applyTemplateToDraft", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("空草稿整段填入；非空末尾空两行追加", () => {
    assert.equal(applyTemplateToDraft("", "T"), "T");
    assert.equal(applyTemplateToDraft("草稿  ", "T"), "草稿\n\nT");
  });

  it("宿主给的草稿不是字符串 → 按空草稿整段填入（不拼出 undefined 前缀）", () => {
    const odd: unknown = undefined;
    assert.equal(applyTemplateToDraft(odd as string, "模板正文"), "模板正文");
  });
});

/** 英文 translator：与 tZh 同一条渲染路径，只是换字典（双语用例共用）。 */
const tEn: Translate = (key, params) => localeText(enTable, key, params ?? {});
describe("rawOrganizeTimeoutMsOf 对同源超时位的快照净化", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("正数透传；非数字/非有限/≤0/缺席 → undefined", () => {
    assert.equal(rawOrganizeTimeoutMsOf({ organizeTimeoutMs: 300_000 }), 300_000);
    assert.equal(rawOrganizeTimeoutMsOf({ organizeTimeoutMs: 0 }), undefined);
    assert.equal(rawOrganizeTimeoutMsOf({ organizeTimeoutMs: -5 }), undefined);
    assert.equal(rawOrganizeTimeoutMsOf({ organizeTimeoutMs: "fast" }), undefined);
    assert.equal(rawOrganizeTimeoutMsOf({ organizeTimeoutMs: Number.NaN }), undefined);
    assert.equal(rawOrganizeTimeoutMsOf({}), undefined, "宿主没投影该位 → undefined");
  });
});
describe("persistError（写入回执核验，文本取自卡片字典）", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  const expected = [TPL];
  const action = tZh("save");

  it("宿主未就绪 → 不可确认", () => {
    assert.match(
      persistError(tZh, { ready: false, revision: 0, templates: [] }, expected, action) ?? "",
      /保存结果不可确认：设置源未就绪（宿主未回读成功）/u,
    );
  });

  it("复读值与提交值不一致 → 未生效（含 revision）", () => {
    assert.match(
      persistError(tZh, { ready: true, revision: 7, templates: [] }, expected, action) ?? "",
      /保存未生效：宿主拒绝了本次写入（当前 revision 7）/u,
    );
  });

  it("一致 → undefined", () => {
    assert.equal(
      persistError(tZh, { ready: true, revision: 8, templates: expected }, expected, action),
      undefined,
    );
  });

  it("en 字典走同一核验路径：回执文本是英文（动作名同样取自字典）", () => {
    assert.equal(
      persistError(tEn, { ready: true, revision: 7, templates: [] }, expected, tEn("save")),
      "Save did not take effect: the host rejected this write (current revision 7)",
    );
  });
});
describe("formatImportSkips（计数句子取自卡片字典）", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("缺省 / 全 0 → 空串", () => {
    assert.equal(formatImportSkips(tZh, undefined), "");
    assert.equal(formatImportSkips(tZh, { tooLarge: 0, unreadable: 0, deeper: 0, unnamed: 0 }), "");
  });

  it("四类计数都进句子", () => {
    const out = formatImportSkips(tZh, { tooLarge: 1, unreadable: 2, deeper: 40, unnamed: 3 });
    assert.match(out, /40 个更深层/u);
    assert.match(out, /1 个文件超字节上限/u);
    assert.match(out, /2 个文件读取失败/u);
    assert.match(out, /3 个非角色文件/u);
    assert.match(out, /^（.+，.+，.+，.+）$/u, "外层括号 + 中文顿号分隔同样来自字典");
  });

  it("en 字典：同一份计数产出英文句子与英文分隔符", () => {
    const out = formatImportSkips(tEn, { tooLarge: 1, unreadable: 0, deeper: 40, unnamed: 0 });
    assert.equal(
      out,
      " (40 deeper .md files were not scanned (imports cover two levels), 1 files were skipped for exceeding the byte limit)",
    );
  });
});
describe("inject 声明", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("client 半依赖 slots + configForms + locale（卡片文案走官方 locale）", () => {
    // 0.1.7：`settingsScope` 服务已被宿主移除（installed 全树零命中），配置读写的入口
    // 是 `ctx.configForms.get(entryId)`（installed dsh-client-ui-settings/lib/types/
    // client/config-form.d.ts:94-98 交出 Context.configForms，get:142）。声明里没有
    // configForms → inject 解析不出来 → 整个 client 半不挂载（设置卡 + 两个按钮全静默缺席）。
    assert.deepEqual(clientInject, ["slots", "configForms", "locale"]);
  });

  it("apply 取表单用的是本条目的 profile id（= 0.1.7 的 settings 命名空间）", async () => {
    // 0.1.7 没有 register 声明 ns 这一步：命名空间 = profile 条目 id（installed
    // dsh-settings/lib/index.js:432 的 `ns: entry.options.id`），client 侧
    // `configForms.get(entryId)`（同包 config-form.d.ts:142）按同一个 id 取表单。
    // 取错 id 的形状是"卡片能打开、保存却写进别的条目"，且两侧各写各的常量就会漂移，
    // 故这里把 client 取的 id 钉在本包 cordis.patch.yml 上，且只在 apply 里取一次。
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    // 路径经 node:path 拼：happy-dom 环境把全局 `URL` 换成了它自己的实现，
    // `new URL(…, import.meta.url)` 会回 http://localhost:3000/… → readFile 报
    // "The URL must be of scheme file"（实测）。
    const patch = await readFile(path.join(import.meta.dirname, "..", "cordis.patch.yml"), "utf8");
    const entryId = /^\s*-\s+id:\s*(?<id>\S+)\s*$/mu.exec(patch)?.groups?.["id"];
    assert.ok(
      typeof entryId === "string" && entryId.length > 0,
      "cordis.patch.yml 声明了裸条目 id",
    );
    assert.deepEqual(ctx.formEntryIds, [entryId], "只取一次，且 id = 本条目裸 id");
    assert.equal(entryId, ENTRY_ID, "与 host 半隐式注册的命名空间同源");
  });

  it("设置卡 slot key = profile bundles 里的 bundle 包名（键值定案，2026-09-23）", async () => {
    // 派发链（installed dsh 0.1.7）：plugin-manager/lib/client.js:1821 用
    // `entryKey: pkg.name` 渲染该槽，pkg.name = bundle.name（:306/:320），页面还以
    // :2698 `ledger.bundles.has(openPkg.name)` 决定开不开这一段；renderer/lib/client.js:1154
    // 逐字相等匹配。slot-contract.d.ts:96-100 写明「keyed by the bundle's package name」。
    // 官方占位者 dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 亦用包名。
    const { ctx } = mountAll();
    const regs = ctx.registers.filter((reg) => reg.name === SLOT_BUNDLE_CONFIG);
    // `.at(0)` 而不是 `[0]`：下标在 oxlint 的类型引擎里非空（它不接 tsc 的
    // noUncheckedIndexedAccess），可选链会被判冗余；at() 的返回类型自带 `| undefined`，
    // 两套类型面一致。提到一处局部量，四条断言读的都是同一个 key。
    const bundleKey = regs.at(0)?.key;
    assert.equal(regs.length, 1, "只登记一张 bundle 设置卡");
    assert.equal(bundleKey, await profileBundleName(), "key = 宿主派发的 entryKey（bundle 包名）");
    // 反向钉 1：不得退回裸条目 id（那正是「卡片静默不渲染」的写法）。
    const bareIds = await patchEntryIds();
    assert.deepEqual(bareIds, [ENTRY_ID], "cordis.patch.yml 只声明一行裸条目 id");
    assert.notEqual(bundleKey, bareIds[0], "key 不再是条目 id");
    // 反向钉 2：bundle 槽用包名，行槽才是 `<pkg>#<rowId>`（plugin-manager/lib/client.js:27-28）。
    assert.ok(typeof bundleKey === "string" && !bundleKey.includes("#"), "bundle 槽的 key 不含 #");
    // 硬约束的另一面：表单仍按裸条目 id 取（0.1.7 里它就是 settings 命名空间，installed
    // dsh-client-ui-settings/lib/client.js:1309-1315），与 slot key 刻意不同源。
    assert.deepEqual(ctx.formEntryIds, bareIds, "configForms.get() 仍吃裸条目 id");
    assert.notEqual(ctx.formEntryIds[0], bundleKey, "命名空间 ≠ slot key：两个串各自独立");
    // 两个 dock 按钮的 id 也不受牵连（那是 list 槽的 id，不是 keyed 槽的 key）。
    const dockIds = ctx.registers
      .filter((reg) => reg.name === SLOT_INPUT_RIGHT)
      .map((reg) => reg.id);
    assert.deepEqual(dockIds, [ENTRY_ID, "dir-prep-organize-templates"], "dock id 不变");
  });

  it("store 订阅沿 configForms scope 通知（dock/card 的 useCard 快照换代依赖此通路）", () => {
    // 旧实现里 dock 按钮经 useSyncExternalStore(store.subscribe) 订阅；迁移到 inject
    // hooks 间隔后订阅动作移交框架渲染器，但 store 本体的 subscribe 仍必须是
    // scope 通知的直通口（官方渲染器按源身份缓存 hook，换代靠这条回调）。
    const { ctx } = mountAll();
    const dockReg = ctx.registers.find((reg) => reg.name === SLOT_INPUT_RIGHT);
    const injected = dockReg?.inject?.() as { hooks: { card: StoreView } } | undefined;
    assert.ok(injected !== undefined && isStoreView(injected.hooks.card));
    const store = injected.hooks.card;
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    ctx.scope.commit(READY);
    assert.equal(notified, 1, "换代即通知");
    unsubscribe();
    ctx.scope.commit(READY);
    assert.equal(notified, 1, "退订后不再通知");
  });
});

// ── 「整理」分段按钮 ────────────────────────────────────────────────────────

interface KitProps {
  /** locale seat 的测试替身：mountAll 每轮从 dock 注册的 inject 抽取（见 dockKit）。 */
  t: Translate;
  /** hooks.card → useCard 的等价适配（useCardOf，真 store）。 */
  useCard: (selector: (snap: SnapshotView) => unknown) => unknown;
  useInput?: <TResult>(selector: (state: { draft: string }) => TResult) => TResult;
  inputActions?: { setDraft: (text: string) => void };
  sessionId?: string;
}

/** kitProps 的覆盖面：exactOptionalPropertyTypes 下"显式给 undefined"与"缺省"
 *  是两件事，测试要能各自造出来（框架注入缺省 props 的真实形状）。 */
interface KitOverrides {
  useInput?: KitProps["useInput"] | undefined;
  inputActions?: KitProps["inputActions"] | undefined;
  sessionId?: string | undefined;
}

function kitProps(over: KitOverrides = {}): Record<string, unknown> {
  assert.ok(dockKit, "kitProps 需先 mountAll（dock 注册的 inject 抽出 t/useCard）");
  return {
    ...dockKit,
    sessionId: "s1",
    useInput: (selector: (state: { draft: string }) => string) => selector({ draft: "原始草稿" }),
    inputActions: {
      setDraft: (value: string): void => {
        writes.push(value);
      },
    },
    ...over,
  };
}

/** 卸载后才落地的响应：seq 已在清理 effect 里递增 → 成功/失败两条分支都静默丢弃。 */
async function expectStaleDiscarded(orgBody: unknown): Promise<void> {
  const gate = Promise.withResolvers<undefined>();
  stubFetch(async (url) => {
    if (url.startsWith(ORGANIZE_URL)) {
      await gate.promise;
      return { body: orgBody };
    }
    return { body: { ok: true, csrf: "t", cwd: "/w", entries: [], provider: "p", model: "m" } };
  });
  const { organize } = mountAll();
  await mount(React.createElement(organize, kitProps()));
  await act(async () => {
    buttonByField(FIELD_ORGANIZE_BTN)?.click();
  });
  await flush();
  await unmount();
  await act(async () => {
    gate.resolve(undefined);
  });
  await flush();
}
describe("OrganizeButton", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("空闲态渲染主键 + ▾；点主键走三段请求并写回整理结果", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    writes.length = 0;
    await mount(React.createElement(organize, kitProps()));
    assert.equal(stateOf(FIELD_ORGANIZE_BTN), "idle");
    assert.ok(text().includes("整理"));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    const posted = fetchCalls
      .map((call) => call.url.split("?")[0] ?? "")
      .toSorted((left, right) => left.localeCompare(right));
    assert.deepEqual(posted, [CONTEXT_URL, MODEL_URL, ORGANIZE_URL]);
    assert.deepEqual(writes, ["整理后的要求"], "成功后替换输入框");
    const post = fetchCalls.find((call) => call.init.method === "POST");
    assert.ok(post, "organize 是 POST");
    assert.equal(post.init.headers?.get("x-dir-prep-csrf"), "tok-ctx", "回填 context 下发的令牌");
    const body = jsonRecordOf(post.init.body);
    assert.equal(body["prompt"], "原始草稿");
    assert.equal(body["sessionId"], "s1");
    assert.equal("roleText" in body, false, "直接整理不带角色");
    assert.match(String(body["entriesSummary"]), /📁 sub\//u, "目录摘要已提交");
  });

  it("▾ 打开角色菜单 → 选角色：POST 必须带 roleText（审计修复主证）", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    writes.length = 0;
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    assert.equal(stateOf(FIELD_ORGANIZE_CARET), "open");
    assert.ok(byField(FIELD_ORGANIZE_MENU), "菜单已渲染");
    const roleItems = byFields(FIELD_ORGANIZE_ROLE_ITEM);
    assert.equal(roleItems.length, 1, "角色项 = 当前模板列表长度");
    const [first] = roleItems;
    assert.ok(first, "至少一个角色项");
    assert.match(textOf(first), /^以「.+」视角整理$/u, "无 emoji 时不加前导空格");
    await press(first);
    const post = fetchCalls.find((call) => call.init.method === "POST");
    assert.ok(post, "角色整理也走 POST");
    const body = jsonRecordOf(post.init.body);
    const { roleText } = body;
    assert.equal(typeof roleText, "string", "角色整理必须带 roleText 字段");
    assert.ok(typeof roleText === "string" && roleText.length > 0, "roleText 非空");
    assert.ok(roleText.includes("正文甲"), "roleText = 所选模板正文全文");
    assert.deepEqual(writes, ["整理后的要求"]);
  });

  it("菜单里的「直接整理」项与带 emoji/ description 的角色项均按模板渲染", async () => {
    stubOrganizeOk();
    const snapshot: FormSnapshot = snap({
      writable: true,
      value: {
        templates: [
          {
            id: "a",
            name: "有标记",
            description: "一句话介绍",
            text: "正文A",
            group: "工程",
            emoji: "🧪",
          },
        ],
      },
      revision: 1,
    });
    const { organize } = mountAll(snapshot);
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    const [role] = byFields(FIELD_ORGANIZE_ROLE_ITEM);
    assert.ok(role, "角色项已渲染");
    assert.equal(role.title, "一句话介绍");
    assert.match(textOf(role), /🧪 以「有标记」视角整理/u);
    await press(buttonWithText("直接整理（默认，不带角色）"));
    assert.deepEqual(writes, ["整理后的要求"], "菜单里的直接整理同样写回一次");
  });

  it("宿主回空表（用户从未设置）→ 菜单取内置精选集，不出空态", async () => {
    stubOrganizeOk();
    // 这就是真宿主在 settings 未写 templates 时递来的形状（host 无默认 → schemastery
    // 对 array cast 成 []→ describe 原样交上来），此前被当成"用户清空了列表"，页面全空。
    const { organize } = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    assert.equal(
      byFields(FIELD_ORGANIZE_ROLE_ITEM).length,
      DEFAULT_TEMPLATES.length,
      "空表按未设置处理 → 与「模板」下拉同源取内置精选集",
    );
    assert.doesNotMatch(text(), /无模板可选为整理视角/u);
  });

  it("templates 是非空数组但逐项非法 → 菜单才显示空态文案", async () => {
    stubOrganizeOk();
    // 空态唯一可达路径：宿主确实回了一条以上的原始项，但全部被 sanitizeTemplateList 剔除
    // （name/text 缺失或非字符串），此时 fromSettings 仍为 true。
    const { organize } = mountAll(
      snap({ value: { templates: [{}, { name: "", text: "" }] }, revision: 0 }),
    );
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    assert.match(text(), /无模板可选为整理视角/u);
  });

  it("失败：host 回 ok:false → 输入框保持原值并显示失败态（4 秒后回常态）", async () => {
    stubFetch((url) =>
      url.startsWith(ORGANIZE_URL)
        ? { body: { ok: false, error: "模型 context 超限" } }
        : { body: { ok: true, csrf: "tok", cwd: "/w", entries: [], provider: "p", model: "m" } },
    );
    const { organize } = mountAll();
    vi.useFakeTimers();
    await mount(React.createElement(organize, kitProps()));
    const button = buttonByField(FIELD_ORGANIZE_BTN);
    assert.ok(button, "主键存在");
    // 假时钟下不能用 press/flush（宏任务要手动推进）：点击 → 推进微任务链
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    assert.equal(writes.length, 0, "失败绝不覆写草稿");
    assert.equal(stateOf(FIELD_ORGANIZE_BTN), "error");
    assert.match(text(), /失败/u);
    assert.match(button.title, /模型 context 超限/u);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    assert.equal(stateOf(FIELD_ORGANIZE_BTN), "idle", "闪烁自动结束");
    vi.useRealTimers();
  });

  it("context 失败 → 组织失败文案；model 失败 → 读模型失败文案", async () => {
    stubFetch((url) => {
      if (url.startsWith(CONTEXT_URL)) {
        return { body: { ok: false, error: "无法确定会话 cwd" } };
      }
      return { body: { ok: true, csrf: "tok", provider: "p", model: "m" } };
    });
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(
      buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "",
      /目录上下文失败: 无法确定会话 cwd/u,
      "host 给的原文必须原样带出，不能吞成通用文案",
    );

    stubFetch((url) => {
      if (url.startsWith(MODEL_URL)) {
        return { body: { ok: false, error: "没有可用的模型服务" } };
      }
      return { body: { ok: true, csrf: "tok", cwd: "/w", entries: [] } };
    });
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(
      buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "",
      /读取模型失败: 没有可用的模型服务/u,
    );

    stubFetch((url) =>
      url.startsWith(CONTEXT_URL)
        ? { body: "整个响应不是对象" }
        : { body: { ok: true, csrf: "tok", provider: "p", model: "m" } },
    );
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(
      buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "",
      /目录上下文失败: 未知错误/u,
      "非对象回执连 error 都取不到 → 回落未知错误而不是崩",
    );

    stubFetch((url) =>
      url.startsWith(MODEL_URL)
        ? { body: { ok: true, csrf: "tok", provider: "p" } }
        : { body: { ok: true, csrf: "tok", cwd: "/w", entries: [] } },
    );
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(
      buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "",
      /读取模型失败/u,
      "缺 model 字段同样算读模型失败",
    );
  });

  it("整理回执整体不是对象 → 报「整理失败（未知错误）」", async () => {
    stubFetch((url) =>
      url.startsWith(ORGANIZE_URL)
        ? { body: "不是对象" }
        : { body: { ok: true, csrf: "t", cwd: "/w", entries: [], provider: "p", model: "m" } },
    );
    const { organize } = mountAll();
    writes.length = 0;
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(
      buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "",
      /整理失败（未知错误）/u,
      "回执坏到没有 error 时也要有话说",
    );
    assert.deepEqual(writes, [], "坏回执绝不覆写草稿");
  });

  it("宿主回执带 reasoningEffort / 目录被截断 → 截断事实随摘要进 prompt", async () => {
    stubFetch((url) => {
      if (url.startsWith(CONTEXT_URL)) {
        return {
          body: {
            ok: true,
            csrf: "tok-ctx",
            cwd: "/w",
            truncated: true,
            entries: [{ name: "a.ts", isDir: false, sizeBytes: 9 }],
          },
        };
      }
      if (url.startsWith(MODEL_URL)) {
        // host 的 /model 本来就会带 reasoningEffort（host.ts:840）：客户端投影必须
        // 容忍这个多余字段，不能因为不消费它就整包判成坏形状。
        return {
          body: { ok: true, csrf: "tok-model", provider: "p", model: "m", reasoningEffort: "high" },
        };
      }
      return { body: { ok: true, content: "整理后的要求" } };
    });
    const { organize } = mountAll();
    writes.length = 0;
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    const post = fetchCalls.find((call) => call.init.method === "POST");
    const body = jsonRecordOf(post?.init.body);
    assert.match(String(body["entriesSummary"]), /按上限截断/u, "截断声明必须提交给模型");
    assert.deepEqual(writes, ["整理后的要求"]);
  });

  it("空草稿 → 直接报输入框为空", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps({ useInput: undefined })));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /输入框为空/u);
  });

  it("两个响应都没有 csrf → 令牌缺失错误", async () => {
    stubFetch(() => ({ body: { ok: true, cwd: "/w", entries: [], provider: "p", model: "m" } }));
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /整理令牌缺失/u);
  });

  it.each(["http", "network", "abort"] as const)(
    "transport 失败（%s）→ 可见错误",
    async (throwOn) => {
      stubFetch((url) =>
        url.startsWith(ORGANIZE_URL)
          ? { throwOn }
          : { body: { ok: true, csrf: "t", cwd: "/w", entries: [], provider: "p", model: "m" } },
      );
      const { organize } = mountAll();
      await mount(React.createElement(organize, kitProps()));
      await press(buttonByField(FIELD_ORGANIZE_BTN));
      assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /整理失败/u);
      assert.deepEqual(writes, [], `${throwOn} 失败绝不覆写草稿`);
    },
  );

  it("响应坏形状（非对象 / 字段类型错）→ 按缺省降级且不炸", async () => {
    stubFetch((url) => {
      if (url.startsWith(CONTEXT_URL)) {
        return {
          body: {
            ok: true,
            cwd: 5,
            truncated: false,
            entries: ["不是对象", { name: 1, isDir: "x", sizeBytes: "z", snippet: 2 }],
          },
        };
      }
      if (url.startsWith(MODEL_URL)) {
        return { body: "not-an-object" };
      }
      return { body: { ok: true, content: "结果" } };
    });
    const { organize } = mountAll();
    writes.length = 0;
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /读取模型失败/u);
  });

  it("写回动作缺失 → 明确错误（不静默）", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps({ inputActions: undefined })));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /输入框动作不可用/u);
  });

  it("loading 期间重复点击被门禁（DOM disabled + 组件内 seq 双保险）", async () => {
    const gate = Promise.withResolvers<undefined>();
    stubFetch(async (url) => {
      if (url.startsWith(ORGANIZE_URL)) {
        await gate.promise;
        return { body: { ok: true, content: "迟到结果" } };
      }
      return { body: { ok: true, csrf: "t", cwd: "/w", entries: [], provider: "p", model: "m" } };
    });
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps()));
    const first = buttonByField(FIELD_ORGANIZE_BTN);
    assert.ok(first, "主键存在");
    await act(async () => {
      first.click();
    });
    await flush();
    assert.equal(stateOf(FIELD_ORGANIZE_BTN), "loading");
    assert.equal(buttonByField(FIELD_ORGANIZE_CARET)?.disabled, true, "loading 时 ▾ 禁用");
    // 直调 React onClick 绕过 DOM 的 disabled 门禁 → 组件自身的 loading 判定必须拦住
    await clickViaProps(buttonByField(FIELD_ORGANIZE_BTN));
    await act(async () => {
      gate.resolve(undefined);
    });
    await flush();
    const organizeCalls = fetchCalls.filter((call) => call.url.startsWith(ORGANIZE_URL));
    assert.equal(organizeCalls.length, 1, "第二次点击被 loading 门禁");
    assert.deepEqual(writes, ["迟到结果"], "未作废的首个结果照常写回");
  });

  it("在途成功响应被卸载作废（seq 代次校验：不写回、不 setState）", async () => {
    await expectStaleDiscarded({ ok: true, content: "卸载后才到" });
    assert.deepEqual(writes, [], "成功支：卸载后不写回");
  });

  it("在途失败响应被卸载作废（错误支同样不 setState）", async () => {
    await expectStaleDiscarded({ ok: false, error: "卸载后才到" });
    assert.deepEqual(writes, [], "失败支：卸载后不写回");
    assert.equal(byField(FIELD_ORGANIZE_BTN), null, "组件已卸载，无残留失败态");
  });

  it("useInput 返回 undefined → 草稿按空串处理", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    const kit: Record<string, unknown> = {
      ...dockKitProps(),
      sessionId: undefined,
      useInput: (selector: (state: { draft: string | undefined }) => string | undefined) =>
        selector({ draft: undefined }),
      inputActions: {
        setDraft: (value: string): void => {
          writes.push(value);
        },
      },
    };
    await mount(React.createElement(organize, kit));
    await press(buttonByField(FIELD_ORGANIZE_BTN));
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /输入框为空/u);
  });

  it("菜单外点击关闭；Esc 关闭；点击自身不误关", async () => {
    stubOrganizeOk();
    const { organize } = mountAll();
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    await act(async () => {
      container
        .querySelector<HTMLElement>("span")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.ok(byField(FIELD_ORGANIZE_MENU), "点自己的包裹节点不关闭");
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.equal(byField(FIELD_ORGANIZE_MENU), null, "点外部关闭");
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    assert.ok(byField(FIELD_ORGANIZE_MENU), "非 Esc 不关闭");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    assert.equal(byField(FIELD_ORGANIZE_MENU), null, "Esc 关闭");
  });
});

// ── 「模板」下拉按钮 ────────────────────────────────────────────────────────
describe("TemplateButton", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("按分组渲染；空 group 归入通用；点选追加到草稿", async () => {
    const snapshot: FormSnapshot = snap({
      writable: true,
      value: {
        templates: [
          { id: "a", name: "甲", description: "说明甲", text: "正文A", group: "工程", emoji: "🧪" },
          { id: "b", name: "乙", description: "", text: "正文B", group: "", emoji: "" },
        ],
      },
      revision: 0,
    });
    const { template } = mountAll(snapshot);
    writes.length = 0;
    await mount(React.createElement(template, kitProps({ sessionId: undefined })));
    assert.equal(buttonContaining("模板")?.disabled, false);
    await press(buttonContaining("模板"));
    const groups = [...container.querySelectorAll<HTMLElement>(".dpi-grouph")].map((node) =>
      textOf(node),
    );
    assert.deepEqual(groups, ["工程", "通用"]);
    const items = byFields(FIELD_TEMPLATE_ITEM);
    assert.equal(items.length, 2);
    assert.equal(items[0]?.title, "说明甲");
    assert.equal(items[1]?.title, "正文B", "description 缺省时 title 回落正文");
    await press(items[1]);
    assert.deepEqual(writes, [`原始草稿\n\n正文B`]);
  });

  it("宿主回空表 → 下拉仍取内置精选集（回归：0.1.7 里未设置的形状就是 []）", async () => {
    stubBuiltinTemplates();
    const { template } = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(template, kitProps()));
    await press(buttonContaining("模板"));
    assert.equal(byFields(FIELD_TEMPLATE_ITEM).length, DEFAULT_TEMPLATES.length);
    assert.doesNotMatch(text(), /无模板：在设置页/u);
  });

  it("无模板（非空数组但全非法）→ 空态提示", async () => {
    const { template } = mountAll(
      snap({ value: { templates: [{ note: "缺 name/text" }] }, revision: 0 }),
    );
    await mount(React.createElement(template, kitProps()));
    await press(buttonContaining("模板"));
    assert.match(text(), /无模板：在设置页/u);
  });

  it("宿主未注入 useInput + 从未设置过模板 → 按内置精选集渲染、按空草稿整段插入", async () => {
    stubBuiltinTemplates();
    const { template } = mountAll(snap({ revision: 0 }));
    writes.length = 0;
    await mount(React.createElement(template, kitProps({ useInput: undefined })));
    await press(buttonContaining("模板"));
    const items = byFields(FIELD_TEMPLATE_ITEM);
    assert.equal(items.length, DEFAULT_TEMPLATES.length, "fromSettings=false → 下拉同源内置默认");
    const [firstTpl] = DEFAULT_TEMPLATES;
    const [firstItem] = items;
    assert.ok(firstTpl && firstItem, "首条存在");
    await press(firstItem);
    assert.deepEqual(writes, [firstTpl.text], "缺 useInput 时草稿按空串处理（不拼 undefined）");
  });

  it("宿主 useInput 返回 undefined → 模板按空草稿插入", async () => {
    const { template } = mountAll();
    writes.length = 0;
    await mount(
      React.createElement(template, {
        ...dockKitProps(),
        sessionId: "s1",
        useInput: (selector: (state: { draft: string | undefined }) => string | undefined) =>
          selector({ draft: undefined }),
        inputActions: {
          setDraft: (value: string): void => {
            writes.push(value);
          },
        },
      }),
    );
    await press(buttonContaining("模板"));
    await press(byFields(FIELD_TEMPLATE_ITEM)[0] ?? null);
    assert.deepEqual(writes, ["正文甲"], "undefined 草稿 → 整段填入");
  });

  it("inputActions 缺失 → 按钮禁用并给出原因", async () => {
    const { template } = mountAll();
    await mount(
      React.createElement(template, {
        ...dockKitProps(),
        sessionId: "s1",
        useInput: (selector: (state: { draft: string }) => string) => selector({ draft: "" }),
      }),
    );
    const btn = buttonContaining("模板");
    assert.ok(btn, "模板按钮在位");
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /无法插入/u);
    await press(btn);
    assert.equal(byField(FIELD_TEMPLATE_MENU), null, "禁用时点了也不展开");
  });

  it("展开后点选时写回动作已失效 → 静默不炸", async () => {
    const { template } = mountAll();
    const actions: { setDraft?: ((value: string) => void) | undefined } = {
      setDraft: (value: string): void => {
        writes.push(value);
      },
    };
    await mount(
      React.createElement(template, {
        ...dockKitProps(),
        sessionId: "s1",
        useInput: (selector: (state: { draft: string }) => string) => selector({ draft: "旧内容" }),
        inputActions: actions,
      }),
    );
    await press(buttonContaining("模板"));
    actions.setDraft = undefined;
    const [item] = byFields(FIELD_TEMPLATE_ITEM);
    await press(item ?? null);
    assert.equal(byField(FIELD_TEMPLATE_MENU), null, "选完即关菜单");
  });

  it("外部点击关闭模板菜单", async () => {
    const { template } = mountAll();
    await mount(React.createElement(template, kitProps()));
    await press(buttonContaining("模板"));
    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    assert.equal(byField(FIELD_TEMPLATE_MENU), null);
  });
});

// ── 设置页「提示词模板」卡（TemplatesCard / TemplateRow / ImportPanel）───────

/** config 槽 inject 的形状守卫（框架把它映射为 TemplatesCard 的 props）。 */
interface CardInject {
  /** 官方 locale bind 出的取文案函数（卡片文案的唯一来源）。 */
  t: Translate;
  hooks: { card: unknown };
  /** 表单写入的直传：0.1.7 的 `ConfigForm.set/unset` 回 Promise<boolean>
   *  （installed config-form-types.d.ts:65/:73）。 */
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  readBack: () => unknown;
}

function isCardInject(value: unknown): value is CardInject {
  if (!isRecord(value)) {
    return false;
  }
  const { t, hooks, set, unset, readBack } = value;
  return (
    typeof t === "function" &&
    isRecord(hooks) &&
    typeof set === "function" &&
    typeof unset === "function" &&
    typeof readBack === "function"
  );
}

function cardPropsOf(injected: CardInject): Record<string, unknown> {
  const { card } = injected.hooks;
  assert.ok(isStoreView(card), "hooks.card 是 templatesStore");
  return {
    t: injected.t,
    useCard: useCardOf(card),
    set: injected.set,
    unset: injected.unset,
    readBack: injected.readBack,
  };
}

function injectOf(mounted: { cardInject: () => Record<string, unknown> }): CardInject {
  const injected: unknown = mounted.cardInject();
  assert.ok(isCardInject(injected), "config 槽 inject 形状：t + hooks.card + set/unset/readBack");
  return injected;
}

/** 打开设置卡并挂上（refresh = 外部快照变化后重挂，驱动草稿跟随）。
 *  translator 决定卡片语言；展开走 .dpic-header，与标题文案（语言）无关。 */
async function openCard(
  initial?: FormSnapshot,
  translator: Translate = tZh,
): Promise<{
  ctx: MockCtx;
  refresh: () => Promise<void>;
}> {
  const mounted = mountAll(initial, translator);
  const props = cardPropsOf(injectOf(mounted));
  await mount(React.createElement(mounted.card, props));
  await press(container.querySelector<HTMLButtonElement>(".dpic-header"));
  return {
    ctx: mounted.ctx,
    refresh: async () => {
      const next = cardPropsOf(injectOf(mounted));
      await rerender(React.createElement(mounted.card, next));
      await flush();
    },
  };
}

function inputByClass(cls: string, index: number): HTMLElement | null {
  const nodes = [...container.querySelectorAll<HTMLElement>(cls)];
  return nodes[index] ?? null;
}

/** 某类输入框的当前值（受控渲染，读 DOM 即读草稿）。 */
function rowValue(cls: string, index: number): string {
  const node = inputByClass(cls, index);
  assert.ok(node, `${cls}[${String(index)}] 存在`);
  const value = "value" in node ? node.value : "";
  return typeof value === "string" ? value : "";
}

/** 在某个输入框上敲回车（导入框：回车即提交）。 */
async function pressEnterOn(cls: string): Promise<void> {
  await pressKey(inputByClass(cls, 0), "Enter");
}

/** 宿主收到的第 index 次写入值（JSON 化后断言，避开 unknown 成员访问）。 */
function writeJson(ctx: MockCtx, index: number): string {
  const call = ctx.scope.writes[index];
  assert.ok(call, `第 ${String(index)} 次写入存在`);
  assert.equal(call.field, "templates");
  return JSON.stringify(call.value);
}

function saveButton(): HTMLButtonElement | null {
  return buttonByField("save");
}

/** 宿主收到的第 index 次写入（字段名 + JSON 值）：模板与允许目录共用一个保存条，
 *  断言必须能区分写了哪个字段。 */
function writeEntry(ctx: MockCtx, index: number): { field: string; value: string } {
  const call = ctx.scope.writes[index];
  assert.ok(call, `第 ${String(index)} 次写入存在`);
  return { field: call.field, value: JSON.stringify(call.value) };
}

function errText(): string {
  const node = container.querySelector<HTMLElement>(".dpic-err");
  return textOf(node);
}

function hintList(): string[] {
  return [...container.querySelectorAll<HTMLElement>(".dpic-hint")].map((node) => textOf(node));
}
describe("TemplatesCard 状态提示", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("未就绪 → 只读提示 + 全部按钮禁用（不假装可编辑）", async () => {
    const { ctx } = await openCard(
      snap({
        // 契约内的"还没就绪"= loading（官方 status 闭集之一）
        status: "loading",
        writable: false,
        value: { templates: [TPL] },
        revision: 0,
      }),
    );
    assert.match(text(), /设置源未就绪/u);
    assert.equal(saveButton()?.disabled, true);
    assert.equal(buttonContaining("新增模板")?.disabled, true);
    assert.equal(inputByClass(CLS_NAME, 0)?.hasAttribute("disabled"), true);
    assert.equal(inputByClass("input.dpic-importpath", 0)?.hasAttribute("disabled"), true);
    // 直调 React onClick 绕过 DOM disabled：门禁必须在组件自身也成立一次。
    await clickViaProps(saveButton());
    assert.equal(ctx.scope.writes.length, 0, "不可编辑时保存被组件门禁拦下");
  });

  it("就绪但不可写 → 给出不禁编辑原因，下拉仍按当前列表生效", async () => {
    const { ctx } = await openCard(
      snap({
        writable: false,
        value: { templates: [TPL] },
        revision: 1,
      }),
    );
    assert.match(text(), /设置源不可写/u);
    assert.equal(saveButton()?.disabled, true);
    await clickViaProps(saveButton());
    assert.equal(ctx.scope.writes.length, 0, "只读宿主下绝不写入");
  });

  it("就绪可写 + 未 dirty → 无提示行、保存/撤销禁用", async () => {
    const { ctx } = await openCard();
    assert.deepEqual(
      hintList().filter((line) => line.includes("设置源")),
      [],
    );
    assert.equal(saveButton()?.disabled, true, "无未保存修改时保存禁用");
    assert.equal(buttonByField("discard")?.disabled, true);
    await clickViaProps(saveButton());
    assert.equal(ctx.scope.writes.length, 0, "未 dirty 时直调 onClick 也不写宿主");
  });

  it("首个快照受理前（value/revision 缺席）→ 未就绪 + 无值 + revision 0", async () => {
    // 原用例喂的是「整个快照是 null」，官方快照面（7 位全必选）根本表示不出这种
    // 形状，src 里那条 `isRecord(snap) ? snap : {}` 也随类型回归官方而删除。这里改钉
    // 官方真会送来的那一态：provider 还没接受任何 section → status loading、
    // value/revision 均为 undefined。
    const mounted = mountAll(snap({ status: "loading", value: undefined, revision: undefined }));
    const readBack: unknown = injectOf(mounted).readBack();
    assert.ok(isRecord(readBack), "复读仍是对象");
    assert.equal(readBack["ready"], false, "status 不是 ready 就是没就绪");
    assert.equal(readBack["revision"], 0, "缺席的 revision 归 0");
    assert.deepEqual(readBack["templates"], []);
  });

  it("status 已 ready 而 revision 尚未有数 → 复读 ready=true + revision 0", async () => {
    // 官方 `revision: number | undefined`（"undefined before the first Host view"），
    // `value: T | undefined` 同理：这两位是真的会缺，故 `?? 0` / `?? {}` 是契约内兜底。
    // 原先伪造的 `revision:"3"`、`value:"不是对象"` 在官方面上不可表示，已改回契约内形状。
    const mounted = mountAll(snap({ value: undefined, revision: undefined }));
    const readBack: unknown = injectOf(mounted).readBack();
    assert.ok(isRecord(readBack), "复读仍是对象");
    assert.equal(readBack["ready"], true, "status 仍可认");
    assert.equal(readBack["revision"], 0, "无 revision 归 0：失败文案里不许出现假 revision");
    assert.deepEqual(readBack["templates"], [], "value 缺席视作未设置");
  });

  it("快照缺 templates 字段 → 回落内置精选集（fromSettings=false）", async () => {
    stubBuiltinTemplates();
    const { organize } = mountAll(snap({ revision: 0 }));
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    assert.equal(
      byFields(FIELD_ORGANIZE_ROLE_ITEM).length,
      DEFAULT_TEMPLATES.length,
      "角色菜单按内置默认渲染",
    );
  });
});
describe("TemplatesCard 编辑与保存", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("改名后失焦 → 保存启用 → 写入宿主并复读一致（无错误）", async () => {
    const { ctx } = await openCard();
    await type(inputByClass(CLS_NAME, 0), "改名后的甲");
    await blur(inputByClass(CLS_NAME, 0));
    assert.equal(saveButton()?.disabled, false, "有未保存修改");
    await press(saveButton());
    assert.equal(ctx.scope.writes.length, 1, "写入一次 templates");
    assert.deepEqual(ctx.scope.writes[0]?.value, [{ ...TPL, name: "改名后的甲" }]);
    assert.equal(errText(), "", "宿主已收下 → 不报错");
    assert.equal(saveButton()?.disabled, true, "保存后回到非 dirty");
  });

  it("两行草稿里改一行 → 只影响该行，其余行的值保持不变", async () => {
    await openCard(
      snap({
        writable: true,
        value: {
          templates: [
            { id: "a", name: "甲", description: "d1", text: "正文A", group: "工程", emoji: "🅰" },
            { id: "b", name: "乙", description: "d2", text: "正文B", group: "", emoji: "🅱" },
          ],
        },
        revision: 0,
      }),
    );
    await type(inputByClass(CLS_NAME, 0), "甲改名");
    await blur(inputByClass(CLS_NAME, 0));
    assert.equal(rowValue(CLS_NAME, 0), "甲改名");
    assert.equal(rowValue(CLS_NAME, 1), "乙", "另一行未被连带改写");
    assert.equal(rowValue(CLS_TEXT, 1), "正文B", "另一行正文保持");
    await press(saveButton());
    assert.equal(
      hintList().filter((line) => line.includes("保存失败")).length,
      0,
      "两行草稿保存后无错误回执",
    );
  });

  it("宿主以非 Error 值 reject（老桥 reject 字符串）→ 界面仍给一行可读错误", async () => {
    const mounted = mountAll();
    const injected = injectOf(mounted);
    const rejection: unknown = "不是 Error 的 reject 值";
    // 用 spyOn + mockRejectedValue 交出非 Error 值：老宿主桥确实会 reject 出字符串，
    // 界面必须仍然有话说（throw / Promise.reject 都被 lint 钉死只能给 Error）。
    // 顺序要紧：spyOn 就地换掉 injected.set，随后 cardPropsOf 取到的就是被换过的那一位。
    vi.spyOn(injected, "set").mockRejectedValue(rejection);
    const props = cardPropsOf(injected);
    await mount(React.createElement(mounted.card, props));
    await press(buttonContaining("提示词模板"));
    await type(inputByClass(CLS_NAME, 0), "改名");
    await blur(inputByClass(CLS_NAME, 0));
    await press(saveButton());
    assert.match(errText(), /保存失败：不是 Error 的 reject 值/u, "非 Error 值也走同一个归一");
  });

  it("超长 emoji / 带空白的名称 → 写宿主的是归一后的形状（界面所见即宿主所得）", async () => {
    const { ctx } = await openCard();
    await type(inputByClass(CLS_EMOJI, 0), "1234567890abcdef");
    await blur(inputByClass(CLS_EMOJI, 0));
    await type(inputByClass(CLS_NAME, 0), "  带空格的长名字  ");
    await blur(inputByClass(CLS_NAME, 0));
    await press(saveButton());
    const sent = writeJson(ctx, 0);
    assert.ok(sent.includes('"emoji":"1234567890ab"'), `emoji 截到 12 字符后才写宿主：${sent}`);
    assert.ok(sent.includes('"name":"带空格的长名字"'), "名称先 trim 再落盘");
    assert.equal(errText(), "", "归一后的回执与宿主值一致");
  });

  it("宿主拒绝写入（mutate 不 reject）→ 必须显示未生效，绝不显示成功", async () => {
    const { ctx } = await openCard();
    ctx.scope.acceptWrites = false;
    await type(inputByClass(CLS_NAME, 0), "被拒绝的名字");
    await blur(inputByClass(CLS_NAME, 0));
    await press(saveButton());
    assert.equal(ctx.scope.writes.length, 1, "确实发过一次写入");
    assert.match(errText(), /保存未生效：宿主拒绝了本次写入（当前 revision 3）/u);
    assert.equal(saveButton()?.disabled, false, "草稿保留，可重试");
  });

  it("写入后宿主回读源转为未就绪 → 回执不可确认", async () => {
    const { ctx } = await openCard();
    ctx.scope.goesStaleOnWrite = true;
    await type(inputByClass(CLS_TEXT, 0), "改了正文");
    await blur(inputByClass(CLS_TEXT, 0));
    await press(saveButton());
    assert.match(errText(), /保存结果不可确认：设置源未就绪/u);
  });

  it("清空名称/正文的失焦不上报草稿（避免静默删条目）", async () => {
    await openCard();
    await type(inputByClass(CLS_NAME, 0), "   ");
    await blur(inputByClass(CLS_NAME, 0));
    assert.equal(saveButton()?.disabled, true, "空名不并入草稿");
    await type(inputByClass(CLS_TEXT, 0), "正文也清空");
    await blur(inputByClass(CLS_TEXT, 0));
    await type(inputByClass(CLS_TEXT, 0), "");
    await blur(inputByClass(CLS_TEXT, 0));
    assert.equal(saveButton()?.disabled, true, "空正文同样不并入");
  });

  it("失焦但内容未变 → 不产生草稿变更", async () => {
    await openCard();
    await blur(inputByClass(CLS_NAME, 0));
    assert.equal(saveButton()?.disabled, true, "未改动 → 仍非 dirty");
  });

  it("emoji / 分组 / 一句话介绍三格都能改并随保存下发", async () => {
    const { ctx } = await openCard();
    await type(inputByClass(CLS_EMOJI, 0), "🧪");
    await blur(inputByClass(CLS_EMOJI, 0));
    await type(inputByClass(".dpic-group", 0), "工程");
    await blur(inputByClass(".dpic-group", 0));
    // .dpic-desc 同时是卡头说明 div 的类名 → 必须限定到 input
    await type(inputByClass("input.dpic-desc", 0), "一句话");
    await blur(inputByClass("input.dpic-desc", 0));
    await press(saveButton());
    assert.deepEqual(
      ctx.scope.writes[0]?.value,
      [{ ...TPL, emoji: "🧪", group: "工程", description: "一句话" }],
      "三格改动一并下发",
    );
  });

  it("撤销 → 丢弃本地草稿回到宿主当前值", async () => {
    await openCard();
    await type(inputByClass(CLS_NAME, 0), "临时改的");
    await blur(inputByClass(CLS_NAME, 0));
    await press(buttonByField("discard"));
    assert.equal(saveButton()?.disabled, true, "撤销后非 dirty");
    assert.equal(rowValue(CLS_NAME, 0), "甲", "输入框回到宿主值");
  });

  it("删除行 → 保存下发不含该条的列表", async () => {
    const two: FormSnapshot = snap({
      writable: true,
      value: {
        templates: [
          TPL,
          { id: "t2", name: "乙", description: "", text: "正文乙", group: "", emoji: "" },
        ],
      },
      revision: 5,
    });
    const { ctx } = await openCard(two);
    const deletes = [...container.querySelectorAll<HTMLElement>(".dpic-del")];
    assert.equal(deletes.length, 2);
    await press(deletes[0] ?? null);
    assert.equal(rowValue(CLS_NAME, 0), "乙", "第一行已移除");
    await press(saveButton());
    assert.deepEqual(
      ctx.scope.writes[0]?.value,
      [{ id: "t2", name: "乙", description: "", text: "正文乙", group: "", emoji: "" }],
      "删除条目不再下发",
    );
  });

  it("新增模板：id 来自 crypto.randomUUID", async () => {
    const uuids: string[] = [];
    const randomUUID = (): string => {
      uuids.push("11111111-1111-4111-8111-111111111111");
      return uuids[0] ?? "";
    };
    vi.stubGlobal("crypto", { randomUUID });
    const { ctx } = await openCard();
    await press(buttonContaining("新增模板"));
    assert.equal(rowValue(CLS_NAME, 1), "新模板 2");
    await press(saveButton());
    assert.match(writeJson(ctx, 0), /tpl-11111111-1111-4111-8111-111111111111/u);
    assert.equal(uuids.length, 1, "id 取自 crypto.randomUUID");
  });

  it("新增模板：crypto.randomUUID 抛错（非安全上下文）→ 回落时间戳 id 且仍可保存", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        throw new Error("crypto is not available in insecure contexts");
      },
    });
    const { ctx } = await openCard();
    await press(buttonContaining("新增模板"));
    await press(saveButton());
    assert.match(writeJson(ctx, 0), /"id":"tpl-[0-9a-z]+-[0-9a-z]+"/u, "兜底 id 形状");
    assert.equal(errText(), "", "兜底路径不报错");
  });

  it("外部改动且本地无编辑 → 草稿跟随；有未保存编辑 → 保留本地", async () => {
    const initial: FormSnapshot = snap({
      writable: true,
      value: { templates: [TPL] },
      revision: 1,
    });
    const { ctx, refresh } = await openCard(initial);
    ctx.scope.commit({
      ...initial,
      revision: 2,
      value: { templates: [{ ...TPL, name: "外部改的甲" }] },
    });
    await refresh();
    assert.equal(rowValue(CLS_NAME, 0), "外部改的甲", "干净草稿跟随外部值");

    await type(inputByClass(CLS_NAME, 0), "我的编辑");
    await blur(inputByClass(CLS_NAME, 0));
    const latest = ctx.scope.getSnapshot();
    ctx.scope.commit({
      ...latest,
      revision: (latest.revision ?? 0) + 1,
      value: { templates: [{ ...TPL, name: "又一次外部改动" }] },
    });
    await refresh();
    assert.equal(rowValue(CLS_NAME, 0), "我的编辑", "有未保存编辑时不被外部值覆盖");
  });
});
describe("TemplatesCard 恢复默认", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("两步确认：第一次只进确认态，4 秒不点自动撤销", async () => {
    await openCard();
    vi.useFakeTimers();
    const resetBtn = buttonContaining("恢复默认");
    assert.ok(resetBtn, "恢复默认按钮存在");
    await act(async () => {
      resetBtn.click();
    });
    assert.match(text(), /确认恢复默认？再点一次/u);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    assert.equal(buttonContaining("恢复默认")?.disabled, false, "确认态已自动撤销");
    vi.useRealTimers();
  });

  it("第二次点击 → unset 下发并核验宿主值", async () => {
    stubBuiltinTemplates();
    const { ctx } = await openCard();
    await press(buttonContaining("恢复默认"));
    await press(buttonContaining("确认恢复默认"));
    assert.deepEqual(ctx.scope.unsets, ["templates"], "unset 了 templates 键");
    assert.equal(errText(), "", "宿主回落到内置默认 → 核验一致");
  });

  it("宿主拒绝 unset → 报「恢复默认未生效」", async () => {
    stubBuiltinTemplates();
    const { ctx } = await openCard();
    ctx.scope.acceptWrites = false;
    await press(buttonContaining("恢复默认"));
    await press(buttonContaining("确认恢复默认"));
    assert.match(errText(), /恢复默认未生效：宿主拒绝了本次写入/u);
  });
});

// ── 内置精选表按需下发（表体在 host 侧，不再打进每次开页的 combo）────────────
describe("内置表按需下发", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("未就绪的菜单是占位行而不是「无模板」空态；表到达后自动列出", async () => {
    const gate = stubBuiltinPending();
    const { template } = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(template, kitProps()));
    await press(buttonContaining("模板"));
    assert.equal(defaultsCallCount(), 1, "打开菜单才拉");
    assert.ok(byFields("dpi-builtin-state")[0], "占位行在位");
    assert.equal(byFields(FIELD_TEMPLATE_ITEM).length, 0, "表没到就不列条目");
    assert.doesNotMatch(text(), /无模板：在设置页/u, "空态文案专属于用户真的删光了列表");
    gate.release();
    await flush();
    assert.equal(
      byFields(FIELD_TEMPLATE_ITEM).length,
      DEFAULT_TEMPLATES.length,
      "表到达 → store 换代 → 菜单自己列出（不重开菜单）",
    );
  });

  it("拉取失败 → 显示原因 + 重试；重试成功即列出", async () => {
    stubBuiltinTemplates("fail");
    const { template } = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(template, kitProps()));
    await press(buttonContaining("模板"));
    assert.match(text(), /内置模板加载失败：内置表暂不可用/u, "host 给的原文要原样带出");
    const retry = buttonContaining("重试");
    assert.ok(retry, "重试按钮在位");
    stubBuiltinTemplates("ok");
    await press(retry);
    assert.equal(byFields(FIELD_TEMPLATE_ITEM).length, DEFAULT_TEMPLATES.length);
  });

  it("传输层抛错也落失败面（不静默卡在占位行）", async () => {
    stubBuiltinTemplates("network");
    const { organize } = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(organize, kitProps()));
    await press(buttonByField(FIELD_ORGANIZE_CARET));
    assert.match(text(), /内置模板加载失败/u);
    assert.equal(byFields(FIELD_ORGANIZE_ROLE_ITEM).length, 0);
  });

  it("重复打开菜单只发一发；用户已有自己的模板时一发都不发", async () => {
    stubBuiltinTemplates();
    const empty = mountAll(snap({ value: { templates: [] }, revision: 0 }));
    await mount(React.createElement(empty.template, kitProps()));
    await press(buttonContaining("模板"));
    await press(buttonByField("dpi-template-btn"));
    await press(buttonByField("dpi-template-btn"));
    assert.equal(defaultsCallCount(), 1, "ready 后复用，不再发第二发");
    await unmount();
    const callsAfterFirstPhase = defaultsCallCount();

    const mine = mountAll(
      snap({
        value: {
          templates: [
            { id: "m1", name: "我的", description: "", text: "正文", group: "", emoji: "" },
          ],
        },
        revision: 1,
      }),
    );
    await mount(React.createElement(mine.template, kitProps()));
    resetBuiltinTemplates();
    await press(buttonContaining("模板"));
    assert.equal(
      defaultsCallCount(),
      callsAfterFirstPhase,
      "有自有模板 → 内置表一发都不发（计数取增量：fetchCalls 跨段累加）",
    );
    assert.equal(byFields(FIELD_TEMPLATE_ITEM).length, 1);
  });

  it("在飞期间并发调用只发一发", async () => {
    stubBuiltinTemplates();
    const [, second] = await Promise.all([loadBuiltinTemplates(), loadBuiltinTemplates()]);
    assert.equal(defaultsCallCount(), 1, "第二次撞在飞闸门：复用同一条 promise");
    assert.equal(second.phase, "ready");
  });

  it("载荷不是对象（老宿主/HTML 回执）→ 失败面带得出兜底文案", async () => {
    stubFetch((url) =>
      url.startsWith(DEFAULTS_URL) ? { body: "<!doctype html>" } : { body: { ok: true } },
    );
    const state = await loadBuiltinTemplates();
    assert.equal(state.phase, "error");
    assert.equal(state.error, BAD_PAYLOAD_ERROR, "非对象载荷没有 host 原文可带");
    assert.deepEqual(state.list, []);
  });

  it("{ok:false} 但 error 缺席/空串 → 仍走兜底文案（不把 undefined 显示给用户）", async () => {
    stubFetch((url) =>
      url.startsWith(DEFAULTS_URL) ? { body: { ok: false } } : { body: { ok: true } },
    );
    const missingReason = await loadBuiltinTemplates();
    assert.equal(missingReason.error, BAD_PAYLOAD_ERROR);
    stubFetch((url) =>
      url.startsWith(DEFAULTS_URL) ? { body: { ok: false, error: "   " } } : { body: { ok: true } },
    );
    resetBuiltinTemplates();
    const blankReason = await loadBuiltinTemplates();
    assert.equal(blankReason.error, BAD_PAYLOAD_ERROR, "空白原文等于没有原文");
  });

  it("store 面：idle→loading→ready，ready 后复用同一引用并通知订阅者", async () => {
    stubBuiltinTemplates();
    let notified = 0;
    const off = subscribeBuiltinTemplates(() => {
      notified += 1;
    });
    assert.equal(builtinTemplatesSnapshot().phase, "idle");
    await loadBuiltinTemplates();
    const ready = builtinTemplatesSnapshot();
    assert.equal(ready.phase, "ready");
    assert.equal(ready.list.length, DEFAULT_TEMPLATES.length);
    await loadBuiltinTemplates();
    assert.equal(builtinTemplatesSnapshot().list, ready.list, "第二次调用不换引用");
    assert.equal(defaultsCallCount(), 1);
    off();
    assert.ok(notified >= 1, "状态变化要惊动订阅者（否则菜单不会换代）");
  });

  it("恢复默认：内置表拉不到就不动 settings", async () => {
    stubBuiltinTemplates("fail");
    const { ctx } = await openCard();
    await press(buttonContaining("恢复默认"));
    await press(buttonContaining("确认恢复默认"));
    assert.deepEqual(ctx.scope.unsets, [], "拉不到表就 unset 等于把用户的模板清空了");
    assert.match(errText(), /内置表暂不可用/u, "报的是 host 原文，且没被吞成通用文案");
  });
});

const importBody = (value: unknown): Record<string, unknown> => ({ body: value });
describe("ImportPanel 角色导入", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("留空导入内置全部：回执带省略计数 → 句子如实显示", async () => {
    stubFetch((url) => {
      if (url !== IMPORT_URL) {
        return { body: { ok: true } };
      }
      return importBody({
        ok: true,
        count: 2,
        truncated: true,
        skipped: { tooLarge: 1, unreadable: 0, deeper: 40, unnamed: 2 },
        entries: [
          { id: "a", name: "甲", description: "", text: "正文", group: "工程", emoji: "" },
          { id: "b", name: "乙", description: "", text: "正文乙", group: "", emoji: "" },
        ],
      });
    });
    const { ctx } = await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(text(), /已从内置角色库导入全部 2 条/u);
    assert.match(text(), /40 个更深层/u, "省略计数必须显示");
    assert.equal(rowValue(CLS_IMPORT_PATH, 0), "", "导入后清空路径");
    assert.equal(ctx.scope.writes.length, 0, "导入只并入草稿，不直接写宿主");
    await press(saveButton());
    assert.equal(ctx.scope.writes.length, 1, "并入草稿后可保存");
  });

  it("填路径导入：消息带来源目录 + count 缺省时按 entries 长度", async () => {
    stubFetch((url) =>
      url === IMPORT_URL
        ? importBody({
            ok: true,
            entries: [{ id: "a", name: "甲", description: "", text: "正文", group: "", emoji: "" }],
          })
        : { body: { ok: true } },
    );
    const { ctx } = await openCard();
    await type(inputByClass(CLS_IMPORT_PATH, 0), ROLES_DIR);
    await pressEnterOn(CLS_IMPORT_PATH);
    assert.match(text(), /已从 \/Users\/me\/roles 导入 1 条/u, "回车即提交");
    assert.equal(ctx.scope.writes.length, 0);
  });

  it("导入 0 条 → 明确提示而不是空成功", async () => {
    stubFetch((url) =>
      url === IMPORT_URL
        ? importBody({ ok: true, count: 0, entries: [], skipped: {} })
        : { body: { ok: true } },
    );
    await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(errText(), /目录下没有符合条件的角色 .md/u);
  });

  it("host 回 ok:false → 显示 host 的错误文本", async () => {
    stubFetch((url) =>
      url === IMPORT_URL
        ? importBody({ ok: false, error: "导入路径含非法段（. / .. / 隐藏目录或文件）" })
        : { body: { ok: true } },
    );
    await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(errText(), /非法段/u);
  });

  it("坏形状回执（count 非数字 / entries 含非对象 / skipped 字段错）→ 按缺省降级不炸", async () => {
    stubFetch((url) =>
      url === IMPORT_URL
        ? importBody({
            ok: true,
            count: "12",
            truncated: "yes",
            skipped: { tooLarge: -1, unreadable: "x", deeper: null },
            entries: ["不是对象", { id: 1, name: null, text: 2 }],
          })
        : { body: { ok: true } },
    );
    await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(errText(), /目录下没有符合条件的角色 .md/u, "字段被降级为 0 条目");
  });

  it("请求失败（网络错误）→ 错误可见且按钮恢复可用", async () => {
    stubFetch((url) => (url === IMPORT_URL ? { throwOn: "network" } : { body: { ok: true } }));
    await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(errText(), /carrier down/u);
    assert.equal(buttonWithText("导入角色")?.disabled, false, "导入结束，按钮恢复");
  });

  it("重复点击在导入中被忽略（importBusy 门禁）", async () => {
    const gate = Promise.withResolvers<undefined>();
    let calls = 0;
    stubFetch(async (url) => {
      if (url === IMPORT_URL) {
        calls += 1;
        await gate.promise;
        return {
          body: {
            ok: true,
            count: 1,
            entries: [{ id: "a", name: "甲", description: "", text: "正文", group: "", emoji: "" }],
          },
        };
      }
      return { body: { ok: true } };
    });
    await openCard();
    await clickViaProps(buttonWithText("导入角色"));
    const busyButton = buttonWithText("导入中…");
    assert.ok(busyButton, "导入中态可见");
    await clickViaProps(busyButton);
    await act(async () => {
      gate.resolve(undefined);
    });
    await flush();
    assert.equal(calls, 1, "importBusy 期间的第二次点击被忽略");
    assert.match(text(), /已从内置角色库导入全部 1 条/u, "首个导入结果正常落地");
  });

  it("导入回执整体不是对象 → 报「导入失败（未知错误）」", async () => {
    stubFetch((url) => (url === IMPORT_URL ? importBody("不是对象") : { body: { ok: true } }));
    await openCard();
    await press(buttonWithText("导入角色"));
    assert.match(errText(), /导入失败（未知错误）/u);
  });

  it("导入框里敲普通字符不提交（只有回车才发请求）", async () => {
    stubFetch((url) =>
      url === IMPORT_URL ? importBody({ ok: true, entries: [TPL] }) : { body: { ok: true } },
    );
    await openCard();
    await pressKey(inputByClass(CLS_IMPORT_PATH, 0), "a");
    await flush();
    assert.equal(
      fetchCalls.filter((call) => call.url === IMPORT_URL).length,
      0,
      "打字过程中不能误发导入请求",
    );
    assert.equal(errText(), "", "也没冒出错误条");
  });

  it("不可编辑（宿主只读）→ 导入按钮禁用", async () => {
    await openCard(snap({ writable: false, value: { templates: [TPL] }, revision: 0 }));
    assert.equal(buttonWithText("导入角色")?.disabled, true);
  });
});

// ── 设置页「导入允许目录」（settings.importAllowRoots 的 UI 绑定 + 写入核验）───

/** 输入框当前值（happy-dom 的 HTMLElement 类型面没有 value，沿用 rowValue 的探测法）。 */
function valueOf(node: HTMLElement): string {
  const value = "value" in node ? node.value : "";
  return typeof value === "string" ? value : "";
}

/** 允许目录面板里的输入框：DOM 顺序 = 已登记目录若干 + 最后一个「新增」框。 */
function rootInputs(): HTMLElement[] {
  const box = container.querySelector<HTMLElement>('[data-field="allow-roots"]');
  assert.ok(box, "导入允许目录行已渲染");
  return [...box.querySelectorAll<HTMLElement>("input")];
}

/** 第 index 个已登记目录的输入框（越界即失败，不把 undefined 漏进调用面）。 */
function rootInputAt(index: number): HTMLElement {
  const node = rootInputs()[index];
  assert.ok(node, `第 ${String(index)} 个允许目录输入框存在`);
  return node;
}

/** 「新增」输入框（永远是最后一个）。 */
function pendingRootInput(): HTMLElement {
  const node = rootInputs().at(-1);
  assert.ok(node, "新增输入框存在");
  return node;
}

/** 允许目录面板里的按钮：DOM 顺序 = 各行「移除」 + 最后「登记目录」。 */
function rootButtons(): HTMLButtonElement[] {
  const box = container.querySelector<HTMLElement>('[data-field="allow-roots"]');
  assert.ok(box, "导入允许目录行已渲染");
  return [...box.querySelectorAll<HTMLButtonElement>("button")];
}

function addRootButton(): HTMLButtonElement {
  const node = rootButtons().at(-1);
  assert.ok(node, "登记目录按钮存在");
  return node;
}

function removeRootButton(index: number): HTMLButtonElement {
  const node = rootButtons()[index];
  assert.ok(node, `第 ${String(index)} 个移除按钮存在`);
  return node;
}

const ROOTS_SNAPSHOT: FormSnapshot = snap({
  writable: true,
  value: { templates: [TPL], importAllowRoots: [ROLES_DIR, LIBRARY_DIR] },
  revision: 1,
});
describe("AllowRootsPanel 导入允许目录", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("宿主已登记的目录 → 逐行渲染（权限口子必须在界面上可见可改，不只存在于 yaml）", async () => {
    await openCard(ROOTS_SNAPSHOT);
    assert.equal(rootInputs().length, 3, "两行已登记 + 一个新增框");
    assert.equal(valueOf(rootInputAt(0)), ROLES_DIR);
    assert.equal(valueOf(rootInputAt(1)), LIBRARY_DIR);
    assert.match(text(), /绝对路径默认拒绝/u, "规则原文就写在面板里");
  });

  it("未登记（快照无该字段）→ 空表合法，只剩新增框", async () => {
    await openCard();
    assert.equal(rootInputs().length, 1);
  });

  it("登记目录 → 保存只写 importAllowRoots（不碰 templates），复读一致才算成功", async () => {
    const { ctx } = await openCard();
    await type(pendingRootInput(), ROLES_DIR);
    await press(addRootButton());
    assert.equal(valueOf(rootInputAt(0)), ROLES_DIR, "已登记行");
    assert.equal(valueOf(pendingRootInput()), "", "登记后新增框清空");
    assert.equal(saveButton()?.disabled, false, "有待保存修改");
    await press(saveButton());
    assert.equal(ctx.scope.writes.length, 1, "只写一个字段");
    const written = writeEntry(ctx, 0);
    assert.equal(written.field, "importAllowRoots");
    assert.equal(written.value, JSON.stringify([ROLES_DIR]));
    assert.ok(!text().includes("保存失败"), "复读一致 → 不报错");
  });

  it("重复登记在保存时被归一（sanitizeAllowRoots 与 host 侧同一套语义）", async () => {
    const { ctx } = await openCard(ROOTS_SNAPSHOT);
    await type(pendingRootInput(), "/Users/me/new");
    await press(addRootButton());
    await type(pendingRootInput(), ROLES_DIR);
    await press(addRootButton());
    assert.equal(rootInputs().length, 5, "界面上出现重复行（4 行 + 新增框；归一发生在保存时）");
    await press(saveButton());
    const written = writeEntry(ctx, 0);
    assert.equal(written.field, "importAllowRoots");
    assert.equal(
      written.value,
      JSON.stringify([ROLES_DIR, LIBRARY_DIR, "/Users/me/new"]),
      "与宿主已有项重复 → 保存的是净化后的列表",
    );
  });

  it("编辑与移除某一行 → 保存写回改写后的列表", async () => {
    const { ctx } = await openCard(ROOTS_SNAPSHOT);
    await type(rootInputAt(0), AGENCY_ZH_DIR);
    await press(removeRootButton(1));
    assert.equal(valueOf(rootInputAt(0)), AGENCY_ZH_DIR);
    assert.equal(valueOf(rootInputAt(1)), "", "移除后只剩新增框");
    await press(saveButton());
    const written = writeEntry(ctx, 0);
    assert.equal(written.field, "importAllowRoots");
    assert.equal(written.value, JSON.stringify([AGENCY_ZH_DIR]));
  });

  it("宿主拒绝写入（mutate 不 reject）→ 报「保存未生效」而不是假成功", async () => {
    const { ctx } = await openCard();
    ctx.scope.acceptWrites = false;
    await type(pendingRootInput(), ROLES_DIR);
    await press(addRootButton());
    await press(saveButton());
    assert.match(errText(), /保存未生效：宿主拒绝了本次写入/u);
  });

  it("写入后宿主转未就绪 → 报「结果不可确认」（不猜成功）", async () => {
    const { ctx } = await openCard();
    ctx.scope.goesStaleOnWrite = true;
    await type(pendingRootInput(), ROLES_DIR);
    await press(addRootButton());
    await press(saveButton());
    assert.match(errText(), /保存结果不可确认/u);
  });

  it("撤销丢弃允许目录草稿（宿主值未被改写）", async () => {
    const { ctx } = await openCard(ROOTS_SNAPSHOT);
    await type(rootInputAt(0), "/tmp/nope");
    await press(buttonByField("discard"));
    assert.equal(valueOf(rootInputAt(0)), ROLES_DIR, "回到宿主当前值");
    assert.equal(ctx.scope.writes.length, 0, "撤销不写宿主");
  });

  it("宿主外部变更：本地无编辑则跟随，有编辑则保留（不被刷掉）", async () => {
    const following = await openCard(ROOTS_SNAPSHOT);
    following.ctx.scope.commit({
      ...ROOTS_SNAPSHOT,
      revision: 2,
      value: { templates: [TPL], importAllowRoots: [OTHER_ROLES_DIR] },
    });
    await following.refresh();
    assert.equal(valueOf(rootInputAt(0)), OTHER_ROLES_DIR, "干净草稿跟随宿主");

    const holding = await openCard(ROOTS_SNAPSHOT);
    await type(rootInputAt(0), "/Users/me/正在编辑");
    holding.ctx.scope.commit({
      ...ROOTS_SNAPSHOT,
      revision: 2,
      value: { templates: [TPL], importAllowRoots: [OTHER_ROLES_DIR] },
    });
    await holding.refresh();
    assert.equal(valueOf(rootInputAt(0)), "/Users/me/正在编辑", "未保存编辑不被外部变更覆盖");
  });

  it("只读（设置源不可写）→ 输入框与两个按钮都禁用", async () => {
    await openCard(
      snap({
        writable: false,
        value: { templates: [TPL], importAllowRoots: [ROLES_DIR] },
        revision: 0,
      }),
    );
    assert.equal(rootInputAt(0).hasAttribute("disabled"), true);
    assert.equal(removeRootButton(0).disabled, true, "移除按钮禁用");
    assert.equal(addRootButton().disabled, true, "登记按钮禁用");
  });

  it("新增框里敲回车 = 登记；普通字符不提交", async () => {
    const { ctx } = await openCard();
    await type(pendingRootInput(), ROLES_DIR);
    await pressKey(pendingRootInput(), "a");
    assert.equal(ctx.scope.writes.length, 0);
    assert.equal(rootInputs().length, 1, "非回车键不改变列表");
    await pressKey(pendingRootInput(), "Enter");
    assert.equal(rootInputs().length, 2, "回车即登记到草稿");
  });

  it("空白路径即便绕过 disabled 门禁也不会变成待保存修改", async () => {
    const { ctx } = await openCard();
    await clickViaProps(addRootButton());
    assert.equal(ctx.scope.writes.length, 0);
    assert.equal(saveButton()?.disabled, true, "sanitize 后与宿主一致 = 无修改");
  });
});

/** 非 2xx 但读不出可用 error 文本的三种形状（体不是 JSON / 体不是对象 /
 *  error 是空串）→ 一律回落状态码文案。这里只装配到"界面已渲染错误行"，
 *  并把那一行的文本交给用例——断言必须待在用例体内（expect-expect 只认体内直调）。
 *  三条各自一个用例：DOM 挂载不能在同一
 *  个循环里串起来跑（no-await-in-loop 之外，重挂同一次用例里也更容易互相污染）。 */
async function importErrorTextFor(route: FetchRoute): Promise<string> {
  stubFetch((url) => (url === IMPORT_URL ? route : { body: { ok: true } }));
  await openCard();
  await press(buttonWithText("导入角色"));
  return errText();
}
describe("fetch 非 2xx 的错误原因必须带进界面", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("403 + {ok:false,error} → 界面显示 host 的越界原因（不是 HTTP 403）", async () => {
    const shown = await importErrorTextFor({
      ok: false,
      status: 403,
      body: { ok: false, error: "导入路径越界：仅允许「会话 cwd …」之内" },
    });
    assert.match(shown, /导入路径越界/u);
    assert.ok(!shown.includes("HTTP 4"), "状态码不顶替原因文本");
  });

  it("非 2xx 且响应体不是 JSON → 回落 HTTP 状态码", async () => {
    assert.match(
      await importErrorTextFor({ ok: false, status: 403, jsonThrows: true }),
      /HTTP 403/u,
      "状态 403 回落状态码文本",
    );
  });

  it("非 2xx 且响应体不是对象（网关 HTML）→ 回落 HTTP 状态码", async () => {
    assert.match(
      await importErrorTextFor({ ok: false, status: 502, body: "网关 HTML" }),
      /HTTP 502/u,
      "状态 502 回落状态码文本",
    );
  });

  it("非 2xx 且 error 是空串 → 回落 HTTP 状态码（空原因不算原因）", async () => {
    assert.match(
      await importErrorTextFor({ ok: false, status: 500, body: { ok: false, error: "" } }),
      /HTTP 500/u,
      "状态 500 回落状态码文本",
    );
  });

  it("rootsPersistError：未就绪 / 不一致 / 一致 三分支", () => {
    assert.match(
      rootsPersistError(tZh, { ready: false, revision: 0, allowRoots: [] }, ["/a"], tZh("save")) ??
        "",
      /保存结果不可确认：设置源未就绪/u,
    );
    assert.match(
      rootsPersistError(
        tZh,
        { ready: true, revision: 9, allowRoots: ["/b"] },
        ["/a"],
        tZh("save"),
      ) ?? "",
      /保存未生效：宿主拒绝/u,
    );
    assert.equal(
      rootsPersistError(tZh, { ready: true, revision: 9, allowRoots: ["/a"] }, ["/a"], tZh("save")),
      undefined,
    );
  });
});
describe("客户端 fetch 超时与卸载清理", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  it("整理请求 125 秒未完成 → 超时错误可见（客户端不悬挂）", async () => {
    stubFetch(async (url: string, init: FetchInit) => {
      if (!url.startsWith(ORGANIZE_URL)) {
        return { body: { ok: true, csrf: "t", cwd: "/w", entries: [], provider: "p", model: "m" } };
      }
      const { signal } = init;
      assert.ok(signal, "client 必须带 AbortSignal（超时靠它取消）");
      const gate = Promise.withResolvers<undefined>();
      signal.addEventListener(
        "abort",
        () => {
          gate.resolve(undefined);
        },
        { once: true },
      );
      await gate.promise;
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const { organize } = mountAll();
    vi.useFakeTimers();
    await mount(React.createElement(organize, kitProps()));
    const button = buttonByField(FIELD_ORGANIZE_BTN);
    assert.ok(button, "主键存在");
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(126_000);
    });
    assert.match(buttonByField(FIELD_ORGANIZE_BTN)?.title ?? "", /整理失败：请求超时/u);
    vi.useRealTimers();
  });

  it("插件卸载：样式标签随 effect 清理移除；清理绝不 dispose provider 持有的表单", async () => {
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    assert.ok(document.querySelector("#dir-prep-organize-css"), "样式已注入");
    // 绊线在位（桩件的 dispose 一被调用就抛）→ 下面那句"清理不 dispose 表单"是实测而非声称：
    // 0.1.7 的 `ConfigForm` 面里没有 dispose（installed config-form-types.d.ts:36-74），
    // 把 scope.dispose() 写回 disposer 会当场炸在这里。
    assert.throws(() => {
      ctx.scope.dispose();
    }, /不得 dispose/u);
    assert.doesNotThrow(() => {
      drainDisposers(ctx);
    });
    await flush();
    assert.equal(document.querySelector("#dir-prep-organize-css"), null, "样式随 effect 清理移除");
  });

  it("slot collapse 后重跑工厂：写入仍落到同一张共享表单（表单跨清理长活）", async () => {
    // 0.1.6 的 settingsScope 在 slot collapse 里被永久 dispose，之后每次保存被静默丢弃；
    // 0.1.7 的表单归 provider 持有（installed config-form.d.ts:138-142），disposer 只
    // unregister，所以工厂重跑后写入照旧可达——这条正是"别再往 disposer 里塞 dispose"的
    // 行为锁（配合上一根的抛错绊线）。
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    const configFactory = ctx.slotFactories.get(SLOT_BUNDLE_CONFIG);
    assert.ok(configFactory, "config 槽已注入工厂");
    const cleanupFirst = configFactory();
    const before = ctx.registers.find((item) => item.name === SLOT_BUNDLE_CONFIG);
    assert.ok(before?.inject, "设置卡已占位");
    const beforeInjected: unknown = before.inject();
    assert.ok(isCardInject(beforeInjected), "collapse 前 inject 形状合法");
    cleanupFirst?.();
    assert.equal(
      ctx.registers.find((item) => item.name === SLOT_BUNDLE_CONFIG),
      undefined,
      "disposer 注销了设置卡",
    );
    configFactory();
    const after = ctx.registers.find((item) => item.name === SLOT_BUNDLE_CONFIG);
    assert.ok(after?.inject, "重跑工厂后按同 key 重新占位");
    const afterInjected: unknown = after.inject();
    assert.ok(isCardInject(afterInjected), "重跑后 inject 形状合法");
    await beforeInjected.set("templates", [TPL]);
    await afterInjected.unset("importAllowRoots");
    assert.deepEqual(
      ctx.scope.writes.map((call) => call.field),
      ["templates"],
      "collapse 前后的写入都到达同一张表单（没有被清理杀掉的写入源）",
    );
    assert.deepEqual(ctx.scope.unsets, ["importAllowRoots"], "unset 同样到达同一张表单");
    assert.equal(ctx.formEntryIds.length, 1, "取表单只发生在 apply：重跑工厂不再 get");
  });

  it("两个槽的 disposer 各自注销 occupant", () => {
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    const dockFactory = ctx.slotFactories.get(SLOT_INPUT_RIGHT);
    const configFactory = ctx.slotFactories.get(SLOT_BUNDLE_CONFIG);
    assert.ok(dockFactory && configFactory, "两个槽都已注入工厂");
    assert.equal(ctx.registers.length, 0, "inject 只登记工厂，框架调用时才占位");
    const disposeDock = dockFactory();
    const disposeConfig = configFactory();
    assert.equal(ctx.registers.length, 3, "整理 + 模板 + 设置卡");
    disposeDock?.();
    disposeConfig?.();
    assert.equal(ctx.registers.length, 0, "注销后槽位清空");
  });

  it("config 槽 inject 的 t/set/unset/readBack 直通 locale、表单与 store", async () => {
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    ctx.slotFactories.get(SLOT_BUNDLE_CONFIG)?.();
    const reg = ctx.registers.find((item) => item.name === SLOT_BUNDLE_CONFIG);
    assert.ok(reg?.inject, "设置卡带 inject");
    const injected: unknown = reg.inject();
    assert.ok(isCardInject(injected), "inject 形状：t + hooks.card + set/unset/readBack");
    assert.equal(injected.t, tZh, "t 来自 ctx.locale.bind（宿主绑到哪份字典由语言决定）");
    // 0.1.7 的受理位直通：set/unset 回 Promise<boolean>（installed
    // config-form-types.d.ts:65/:73），宿主拒绝 → false 而不是 reject。
    assert.equal(await injected.set("templates", [TPL]), true, "受理成功回 true");
    assert.deepEqual(ctx.scope.writes[0]?.value, [TPL], "set 直通表单");
    const readBack: unknown = injected.readBack();
    assert.ok(isRecord(readBack) && Array.isArray(readBack["templates"]), "readBack 复读宿主值");
    ctx.scope.acceptWrites = false;
    assert.equal(await injected.set("templates", [TPL]), false, "宿主拒绝回 false（不 reject）");
    assert.equal(await injected.unset("templates"), false, "unset 同契约");
    ctx.scope.acceptWrites = true;
    assert.equal(await injected.unset("templates"), true, "unset 受理回 true");
    assert.deepEqual(ctx.scope.unsets, ["templates", "templates"], "unset 直通表单");
  });
});

// ── i18n：卡片文案取自官方 locale 字典（切语言 = 换 translator）───────────────

describe("设置卡双语（@deepseek-ai/dsh-client-locale 契约）", () => {
  beforeEach(domFixtureSetup);

  afterEach(domFixtureTeardown);

  /** 数据全 ASCII 的快照：模板名/正文属用户数据（刻意不进字典），en 用例里
   *  整卡 textContent 因此必须一个汉字都没有。 */
  const READY_ASCII: FormSnapshot = snap({
    writable: true,
    value: {
      templates: [{ id: "t1", name: "Alpha", description: "", text: "body", group: "", emoji: "" }],
    },
    revision: 1,
  });

  it("apply 向官方 locale 一次性注册本包两语字典（同 ns，zh/en 齐）", () => {
    const ctx = makeCtx();
    clientApply(ctx as unknown as Parameters<typeof clientApply>[0]);
    assert.deepEqual(
      ctx.localeCalls.map((row) => row.ns),
      [ENTRY_ID],
      "字典按本包命名空间注册进官方 locale，且只注册一次（官方类型化重载两语一次交齐）",
    );
    // 首条记录先 assert 到位再取字段：`?.` 是类型面上的冗余守卫（数组元素的 at(0) 在
    // 这里被解析成非空元素类型），而且真缺席时它会退化成 undefined ≠ string 的软失败。
    const localeCall = ctx.localeCalls.at(0);
    assert.ok(localeCall, "字典注册记录在位（上一句已钉恰好一次）");
    assert.equal(localeCall.dicts.zh.cardTitle, UI_MESSAGES.zh.cardTitle);
    assert.equal(localeCall.dicts.en.cardTitle, UI_MESSAGES.en.cardTitle);
  });

  it("en 字典渲染整张设置卡：标题/按钮/面板是英文，且不残留中文", async () => {
    await openCard(READY_ASCII, tEn);
    const body = text();
    assert.match(body, /Prompt templates/u, "英文标题");
    assert.match(body, /Save/u, "英文保存按钮");
    assert.match(body, /Import roles/u, "英文导入按钮");
    assert.match(body, /Import allowed directories/u, "英文允许目录标题");
    assert.doesNotMatch(body, /提示词模板|保存|撤销|删除|导入角色|登记目录|移除/u, "整卡不混中文");
  });

  it("zh 字典渲染同一张设置卡：中文标题在位（两语走同一渲染路径）", async () => {
    await openCard(READY_ASCII);
    assert.match(text(), /提示词模板（输入框「模板」下拉）/u);
  });

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    const keys = Object.keys(UI_MESSAGES.zh) as (keyof UiMessages)[];
    assert.ok(keys.length > 50, "字典覆盖面（设置卡全部文案）");
    // placeholders 按花括号切段，整条就是一个词的文案（"Save" / "Delete"）会被它
    // 误认成占位符，故只比对任一侧真带 { 的模板；另一侧漏写插值同样进比对。
    const interpolated = keys.filter(
      (key) => UI_MESSAGES.zh[key].includes("{") || UI_MESSAGES.en[key].includes("{"),
    );
    assert.ok(interpolated.length >= 10, "带变量的整句都走官方插值，不是手工拼串");
    for (const key of interpolated) {
      assert.deepEqual(
        placeholders(UI_MESSAGES.en[key]),
        placeholders(UI_MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });
});
