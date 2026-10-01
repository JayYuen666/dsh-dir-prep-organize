// createRouteHandlers + apply 的 HTTP 契约测试。
//
// 覆盖口径（重写后的覆盖面）：
//   · 五个端点（defaults/context/model/organize/importAgent）的 405 / 403 跨域 / 403 CSRF /
//     413 body 超限 / 400 坏流 / 400 非法 JSON / 服务缺失降级 / 正常回执。
//   · 审计修复锁死：读 body 与 JSON.parse 分开的回执（原先超限被糊成
//     200 {ok:false,error:"请求体不是合法 JSON"}）。
//   · apply 装配：settings 页面策略登记一次且 owner 是本插件 fiber / settings 缺独有
//     成员守卫不认 / describe 抛错兜住（回落中文、路由照常）/ webServer 缺成员跳过 /
//     ctx 无 get 面；注册的 handler 反向驱动，覆盖四个惰性服务 getter 的命中与未命中两支。
//
// req/res 用最小实现 + `as unknown as IncomingMessage`（宿主真类型有上百成员，
// 结构替身只能整体收窄；这是测试面的必要断言，src 侧禁同类断言）。
//
// 文案双语：回执文案来自注入的字典（纯函数不读设置）。本文件的 createRouteHandlers
// 包装器统一喂 HOST_MESSAGES.zh（下方用例锁的都是迁移前的中文回执）；英文链路与
// 「现读官方 locale 命名空间」的整条装配在 apply 装配一节里直接调原始实现。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LOCALE_SETTINGS_NAMESPACE } from "@jayyuen66/dsh-plugin-shared/lib/locale";
import { apply, createRouteHandlers as createRouteHandlersWithDict } from "../host.ts";
import type {
  Config,
  DerivedMessageView,
  FsDirEntry,
  FsService,
  FsTarget,
  LlmService,
  LlmStreamOptions,
  RouteDeps,
  SessionLike,
  SessionsService,
  StreamChunk,
} from "../host.ts";
import { HOST_MESSAGES } from "../src/host-messages.ts";
import { DEFAULT_TEMPLATES } from "../src/templates.ts";
import type { TemplateEntry } from "../src/templates.ts";

/** 字典包装器：与迁移前同签名（回执锁中文），en 侧另有直调原始实现的用例。 */
function createRouteHandlers(
  deps: RouteDeps,
  csrf: string,
): ReturnType<typeof createRouteHandlersWithDict> {
  return createRouteHandlersWithDict(deps, csrf, () => HOST_MESSAGES.zh);
}

const BODY_MAX = 64 * 1024 * 1024;

/** 返回 undefined 的服务替身（`get: () => undefined` 会踩 no-useless-undefined，
 *  箭头空体会踩 no-empty-function，故写成带说明的函数声明）。 */
function returnsNothing(): undefined {
  // 占位：形状要求"取不到值"（会话不存在 / 无需清理动作）
}

/** 以**非 Error 值**抛出：覆盖 catch 里 `String(error)` 兜底支的正规手段。
 *  `throw "字面量"` 被 only-throw-error / no-throw-literal 判 error，而运行时
 *  非 Error 的失败原因是真实存在的形状（`AbortController.abort("...")` 后
 *  signal.reason 原样携带任意值，throwIfAborted() 就把它抛出去）。 */
function throwNonError(reason: unknown): void {
  const controller = new AbortController();
  controller.abort(reason);
  controller.signal.throwIfAborted();
}

/** 假请求：shared readBody 只用 headers + AsyncIterable 面。 */
function makeReq(partial: {
  method: string;
  url?: string;
  headers?: Record<string, unknown>;
  body?: string;
  declareLength?: number;
  failStream?: boolean;
}): IncomingMessage {
  const headers: Record<string, unknown> = { ...partial.headers };
  if (partial.declareLength !== undefined) {
    headers["content-length"] = String(partial.declareLength);
  }
  const raw: Record<string | symbol, unknown> = {
    method: partial.method,
    url: partial.url ?? "/",
    headers,
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async (): Promise<IteratorResult<Buffer>> => {
          if (partial.failStream === true) {
            throw new Error("stream aborted");
          }
          if (sent || partial.body === undefined) {
            return { value: undefined, done: true };
          }
          sent = true;
          return { value: Buffer.from(partial.body, "utf8"), done: false };
        },
      };
    },
  };
  return raw as unknown as IncomingMessage;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  headersSent: boolean;
  writableEnded: boolean;
}

/** 假响应：shared sendJson 用 writeHead/end/headersSent/writableEnded。 */
function makeRes(): { res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: "",
    headersSent: false,
    writableEnded: false,
  };
  const raw: Record<string | symbol, unknown> = {
    out,
    setHeader(name: string, value: string | number) {
      out.headers[name] = value;
      return raw;
    },
    getHeader(name: string) {
      return out.headers[name];
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      out.statusCode = status;
      if (headers !== undefined) {
        Object.assign(out.headers, headers);
      }
      out.headersSent = true;
      return raw;
    },
    end(data?: string | Buffer) {
      out.body = String(data ?? "");
      out.writableEnded = true;
      return raw;
    },
  };
  return { res: raw as unknown as ServerResponse, out };
}

/** 端点 JSON 回执：投影成 unknown 索引对象（字段按需用 `body["x"]` / 结构化断言读，
 *  满足 noPropertyAccessFromIndexSignature 与 exactOptionalPropertyTypes）。 */
const parsed = (out: FakeResponse): Record<string, unknown> =>
  JSON.parse(out.body) as Record<string, unknown>;

/** import 端点请求体 JSON 化（提到模块作用域：不捕获 describe 作用域变量）。 */
const bodyOf = (value: unknown): string => JSON.stringify(value);

/** 回执里的数组字段（unknown → 数组；非数组直接断言失败，不静默）。 */
function fieldArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "回执字段必须是数组");
  return value;
}

/** 端点回执断言的小助手：状态码 + body.ok/error 关键片段。 */
async function callOrganize(
  handlers: { organize: (req: IncomingMessage, res: ServerResponse) => Promise<void> },
  req: IncomingMessage,
): Promise<FakeResponse> {
  const { res, out } = makeRes();
  await handlers.organize(req, res);
  return out;
}

/** fs target 替身：`targetKey` 是官方品牌 `FsTargetKey`（installed dsh-fs types.d.ts:14），
 *  合法构造口只有官方 `brandString`（恒等函数）——替身也走它，不用 `as` 绕过；品牌位直接
 *  索引官方成员形状（dsh-fs 根模块未 re-export 该名字）。 */
function fsTargetOf(full: string): FsTarget {
  return { targetKey: brandString<FsTarget["targetKey"]>(full), displayPath: full };
}

/** 会话服务替身：所有 id 都拿到同一个 session（undefined = 会话不存在）。 */
function sessionsReturning(session: SessionLike | undefined): SessionsService {
  return { get: (): SessionLike | undefined => session };
}

/** 会话服务替身：仅 s1 命中给定 cwd，其它 id 不存在。 */
function sessionsOfCwd(cwd: string): SessionsService {
  return {
    get: (sessionId: string): SessionLike | undefined =>
      sessionId === "s1" ? { header: { cwd } } : undefined,
  };
}

/** 会话服务替身：任何 id 都查无会话（cwd 不可确定的失败路径）。 */
const sessionsReturningNone = sessionsReturning(undefined);

/** node:fs 假 fs 服务：直接实现 host 导出的 FsService 契约（不再自造影子接口）。 */
function realFsService(): FsService {
  return {
    resolve: async (target: string) => fsTargetOf(target),
    listDir: async (dir: FsTarget) => {
      const { readdir, stat } = await import("node:fs/promises");
      const names = await readdir(dir.targetKey, { withFileTypes: true });
      return Promise.all(
        names.map(async (dirent): Promise<FsDirEntry> => {
          const full = path.join(dir.targetKey, dirent.name);
          const target: FsTarget = fsTargetOf(full);
          if (dirent.isDirectory()) {
            return { name: dirent.name, type: "directory", target };
          }
          const fileStat = await stat(full);
          return { name: dirent.name, type: "file", target, size: fileStat.size };
        }),
      );
    },
    readText: async (target: FsTarget) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(target.targetKey, "utf8");
    },
  };
}

/** 只在 listDir 上抛错的 fs 服务（模拟目录不存在/无权限）。 */
function brokenListDirFs(): FsService {
  return {
    resolve: async (target: string) => fsTargetOf(target),
    listDir: async (): Promise<FsDirEntry[]> => {
      throw new Error("ENOENT");
    },
    readText: async () => "",
  };
}

/** listDir 恒返回给定条目、readText 恒返回空串的内存 fs（导入端点用）。 */
function fsReturning(children: FsDirEntry[]): FsService {
  return {
    resolve: async (target: string) => fsTargetOf(target),
    listDir: async () => children,
    readText: async () => "",
  };
}

const depsOf = (partial: Record<string, unknown>): RouteDeps => partial;

/** 一条正常完成的整理流（text-delta + finish(stop)）。
 *  `satisfies` 校验它确实是 host 的 LlmService，同时保留"stream 无参"的调用面。 */
const okStream = {
  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: "text-delta", index: 0, text: "已整理" };
    yield { type: "finish", reason: { kind: "stop" } };
  },
} satisfies LlmService;

// ── apply 装配的 ctx 替身（提到模块作用域：不捕获 describe 作用域，且供多组用例共用）──

interface RouteRecord {
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** 一次 settings.configure() 的调用记录（页面策略断言用）。 */
interface ConfigureCall {
  presentation: { auto?: boolean };
  owner: unknown;
}

/** apply 第二参数（cordis 交进来的 volatile 引用）背后的那份可变值。
 *  两个字段都是 Config 里的 volatile 字段：host 半只读 importAllowRoots（导入策略），
 *  templates 从不读（下拉列表由 client 半现读，未设置即 undefined → 回落内置精选集）。 */
interface ConfigValue {
  templates: TemplateEntry[] | undefined;
  importAllowRoots: string[];
}

interface Harness {
  effects: (() => (() => void) | undefined)[];
  /** effect factory 立即执行后收集的 disposer（apply 期即注册完成）。 */
  disposers: (() => void)[];
  routes: RouteRecord[];
  /** settings.configure 的调用记录（页面策略只该登记一次，owner 必须是本插件 fiber）。 */
  configureCalls: ConfigureCall[];
  /** ctx.inject(deps, cb) 收到的依赖清单。 */
  injected: (readonly string[])[];
  /** 本插件 fiber 的替身：configure 的 owner 必须原样带回它（身份断言用）。 */
  fiber: unknown;
  /** volatile 引用背后的当前值：改它即等价于"用户在设置卡上改了设置"。 */
  configValue: ConfigValue;
  /** settings.describe() 的行；空数组 = 官方 locale 插件未注册该命名空间。 */
  describeRows: { ns: string; value: unknown }[];
  /** settings.describe() 的调用记录（每次请求现读，不许缓存跨命名空间的值）。 */
  describeCalls: unknown[];
  /** 非 undefined = describe() 一律抛它（Error 与非 Error 都要测到）。 */
  describeThrows?: unknown;
  serviceRegistry: Record<string, unknown>;
}

/** 造一个 ctx 替身的数据面：get 从 serviceRegistry 取值，effect 收集 factory 并立即执行，
 *  inject 同步以**同一个 ctx** 回调一次（cordis 语义：依赖已就绪，子上下文解析同一批服务）。
 *  服务形状刻意做成"真成员名"（describe+configure / register+registerFallback），
 *  以便走通 isSettingsService / isWebServerService 的守卫。 */
function harness(overrides: Record<string, unknown> = {}): Harness {
  const env: Harness = {
    effects: [],
    disposers: [],
    routes: [],
    configureCalls: [],
    injected: [],
    fiber: { id: "dir-prep-organize-fiber" },
    configValue: { templates: undefined, importAllowRoots: [] },
    describeRows: [],
    describeCalls: [],
    serviceRegistry: {
      settings: {
        /** 页面策略登记：宿主据此决定要不要自动生成表单页。 */
        configure: (presentation: { auto?: boolean }, owner?: unknown) => {
          env.configureCalls.push({ presentation, owner });
          return returnsNothing;
        },
        /** 跨命名空间读的官方入口：本包只用它挑 locale 那条的 value（文案语言）。 */
        describe: (options?: unknown) => {
          env.describeCalls.push(options);
          if (env.describeThrows !== undefined) {
            // oxlint-disable-next-line typescript/only-throw-error -- 替身按用例注入任意抛出值（Error 与非 Error 串都要能注入，见下面两枚 describeThrows），包成 new Error 就测不到 errorText 的 String 兜底支
            throw env.describeThrows;
          }
          return env.describeRows;
        },
      },
      webServer: {
        register: (route: RouteRecord) => {
          env.routes.push(route);
          return () => {
            env.routes = env.routes.filter((item) => item.path !== route.path);
          };
        },
        registerFallback: () => returnsNothing,
      },
      sessions: sessionsReturningNone,
      fs: fsReturning([]),
      llm: { stream: () => okStream.stream() },
      agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
      ...overrides,
    },
  };
  return env;
}

/** 把 Harness 包成 host 认识的 ctx（apply 用到 get/effect/inject/fiber 四面）。 */
interface CtxStub {
  get: (name: string) => unknown;
  effect: (factory: () => (() => void) | undefined, label?: string) => void;
  fiber: unknown;
  inject: (deps: readonly string[], attach: (child: CtxStub) => void) => void;
}

function ctxOf(env: Harness): CtxStub {
  const ctx: CtxStub = {
    fiber: env.fiber,
    get: (name: string) => env.serviceRegistry[name],
    effect(factory: () => (() => void) | undefined): void {
      env.effects.push(factory);
      const dispose = factory();
      if (typeof dispose === "function") {
        env.disposers.push(dispose);
      }
    },
    inject: (deps, attach) => {
      env.injected.push(deps);
      // cordis 用带齐依赖的子上下文同步回调；替身沿用同一个 ctx（服务解析结果一致）
      attach(ctx);
    },
  };
  return ctx;
}

/** volatile 引用替身：与真实引用同构（cosmokit 的 Volatile<T> 只有一个 get()），
 *  get() 现读 value 对象上的字段 —— "改设置 → 下一个请求读到新值"因此可测。 */
function configOf(value: ConfigValue): Config {
  return {
    templates: { get: () => value.templates },
    importAllowRoots: { get: () => value.importAllowRoots },
    // organizeTimeoutMs 是 volatile（引用形态），另三位是非 volatile 普通值。
    organizeTimeoutMs: { get: () => 120_000 },
    maxSnippetBytes: 256 * 1024,
    readConcurrency: 8,
    importBodyMaxBytes: 8 * 1024 * 1024,
  };
}

/** apply 后把注册到的 4 条路由各驱动一次（GET），返回各自回执。 */
async function runRoutes(env: Harness): Promise<FakeResponse[]> {
  const driven = await Promise.all(
    env.routes.map(async (route): Promise<FakeResponse> => {
      const { res, out } = makeRes();
      await route.handler(makeReq({ method: "GET", url: route.path }), res);
      return out;
    }),
  );
  return driven;
}

/** 把 ctx 替身交给 host.apply（host 的 Context 有上百成员，结构替身只能整体收窄）。
 *  第二参数是 cordis 交进来的 volatile 引用替身（0.1.7 起 apply 收两参）。 */
function applyTo(env: Harness): void {
  apply(ctxOf(env) as unknown as Parameters<typeof apply>[0], configOf(env.configValue));
}

/** 五条注册路由的 path 常量（与 host.ts 一致）。 */
const CONTEXT_PATH = "/_dsh/dir-prep/context";
const ORGANIZE_PATH = "/_dsh/dir-prep/organize";
const IMPORT_PATH = "/_dsh/dir-prep/import";
const DEFAULTS_PATH = "/_dsh/dir-prep/default-templates";

// ── 请求夹具单源（重复 3 次以上的输入值集中在此）────────────────────────────
// 这些是**喂给 handler 的输入**与**断言用的期望值**，刻意写死而不引 host.ts / shared
// 里的同名常量：拿实现自己的常量当期望值，断言就退化成同义反复。

/** DNS 重绑定用例的恶意 Host 值（Origin 与 sec-fetch-site 都能自洽，只有 Host 腿拒得了）。 */
const EVIL_HOST = "evil.test:8787";
/** sec-fetch-site 的跨站取值（闸门与自家 isCrossOrigin 支共用的那一档）。 */
const CROSS_SITE = "cross-site";
/** 带会话查询位的 context URL（handler 只读 query，路由匹配在 dispatcher 侧，path 随意）。 */
const CONTEXT_QUERY_URL = "/c?sessionId=s";
/** 三类允许根之外的绝对路径（策略必须默认拒绝的那一类）。 */
const OUTSIDE_IMPORT_PATH = "/etc/passwd.md";
/** per-apply CSRF 令牌夹具值（下发面与回填面必须同一个串才验得出闸门真在比对）。 */
const CSRF_TOKEN = "secret-token";

/** context 的正常查询请求（sessionId=s1）。 */
const getCtxQuery = { method: "GET", url: `${CONTEXT_PATH}?sessionId=s1` };

/** 驱动一条注册路由并取回响应快照。 */
async function driveRoute(route: RouteRecord, req: IncomingMessage): Promise<FakeResponse> {
  const { res, out } = makeRes();
  await route.handler(req, res);
  return out;
}

/** 按 path 后缀取注册路由（找不到即失败，不静默）。 */
function routeOf(env: Harness, suffix: string): RouteRecord {
  const found = env.routes.find((route) => route.path.endsWith(suffix));
  assert.ok(found, `路由 ${suffix} 已注册`);
  return found;
}

/** importAgent 的 POST 调用（该端点不校 CSRF）。 */
async function callImportAgent(
  handlers: { importAgent: (req: IncomingMessage, res: ServerResponse) => Promise<void> },
  body: string,
): Promise<FakeResponse> {
  const { res, out } = makeRes();
  await handlers.importAgent(makeReq({ method: "POST", url: "/i", body }), res);
  return out;
}

/** 带 locale 行的 settings 替身见 harness()：0.1.7 里跨命名空间读只剩 describe()，
 *  host 侧文案语言就是从它的行里挑 `ns === 'locale'` 那条的 value 现读的（官方 locale
 *  插件把自己解析出的 `{ preference }` 持久在该命名空间）。`env.locale = undefined`
 *  = 该条目没被投影（没装 locale 插件）；改 `env.locale` 即验证「改偏好 → 下一个请求
 *  即切文案」而不必重新 apply。 */

/** 会话替身：s1 命中 cwd，并带回给定消息史（organize 的 recentTurns 路径）。 */
function sessionsWithMessages(
  cwd: string,
  messages: readonly DerivedMessageView[],
): SessionsService {
  return {
    get: (sessionId: string): SessionLike | undefined =>
      sessionId === "s1" ? { header: { cwd }, deriveMessages: () => messages } : undefined,
  };
}

describe("defaults 端点（内置精选角色表的按需读面）", () => {
  it("非 GET → 405 + Allow: GET + JSON 体", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.defaults(makeReq({ method: "POST", url: DEFAULTS_PATH }), res);
    assert.equal(out.statusCode, 405);
    assert.equal(out.headers["Allow"], "GET");
    assert.match(out.body, /"error":"GET only"/u, "F1-3：405 也回 JSON 体");
  });

  it("闸门在方法判定之前：恶意 Host 的 POST 回 403 而不是 405", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.defaults(
      makeReq({ method: "POST", url: DEFAULTS_PATH, headers: { host: EVIL_HOST } }),
      res,
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /untrusted host/u);
  });

  it("GET → ok:true，且下发的就是 host 侧那份表（单源，不在 client 复制）", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.defaults(makeReq({ method: "GET", url: DEFAULTS_PATH }), res);
    const body = parsed(out);
    assert.equal(body["ok"], true);
    const list = body["templates"];
    assert.ok(Array.isArray(list), "templates 必须是数组");
    assert.equal(list.length, DEFAULT_TEMPLATES.length, "下发条数与 host 侧同源");
    const first = list[0] as TemplateEntry;
    assert.deepEqual(
      Object.keys(first).toSorted(),
      ["description", "emoji", "group", "id", "name", "text"].toSorted(),
      "六字段齐全（client 直接当 TemplateEntry 用，缺字段即渲染空洞）",
    );
    assert.ok(first.text.length > 0 && !first.text.includes("`"), "正文非空且不含反引号");
  });

  it("表里没有csrf/凭据面：这条 GET 无需 token 也零副作用", async () => {
    const handlers = createRouteHandlers(depsOf({}), "secret-csrf");
    const { res, out } = makeRes();
    handlers.defaults(makeReq({ method: "GET", url: DEFAULTS_PATH }), res);
    assert.doesNotMatch(out.body, /secret-csrf/u, "只读端点不下发 token（跨源脚本拿不到写面）");
  });
});

describe("context 端点", () => {
  it("非 GET → 405 + Allow: GET", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "POST", url: "/_dsh/dir-prep/context" }), res);
    assert.equal(out.statusCode, 405);
    assert.equal(out.headers["Allow"], "GET");
  });

  it("跨域（sec-fetch-site=cross-site）→ 403", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.context(
      makeReq({ method: "GET", url: "/c", headers: { "sec-fetch-site": CROSS_SITE } }),
      res,
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /cross-origin/u);
  });

  it("fs 服务缺失 → ok:false", async () => {
    const handlers = createRouteHandlers(depsOf({ sessions: () => sessionsReturningNone }), "t");
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "/c?sessionId=s1" }), res);
    assert.match(String(parsed(out)["error"]), /fs 服务不可用/u);
  });

  it("sessionId 缺失 → ok:false（无法确定 cwd）", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => realFsService() }), "t");
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "/c" }), res);
    assert.match(String(parsed(out)["error"]), /cwd/u);
  });

  it("正常路径：csrf/cwd/entries/skipped 齐全", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-ctx-"));
    await writeFile(path.join(root, "a.ts"), "export const x = 1\n");
    await mkdir(path.join(root, "sub"));
    const handlers = createRouteHandlers(
      depsOf({ sessions: () => sessionsOfCwd(root), fs: () => realFsService() }),
      "test-csrf",
    );
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "/c?sessionId=s1" }), res);
    const body = parsed(out);
    assert.equal(body["ok"], true);
    assert.equal(body["csrf"], "test-csrf");
    assert.equal(body["cwd"], root);
    assert.equal(body["truncated"], false);
    assert.equal(fieldArray(body["entries"]).length, 2, "a.ts + sub 两条");
    assert.deepEqual(body["skipped"], { tooLarge: 0, unreadable: 0, deeper: 0, unnamed: 0 });
  });

  it("collectDirContext 报错 → ok:false 透传", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        sessions: () => sessionsReturning({ header: { cwd: "/no/such/dir-xyz" } }),
        fs: () => realFsService(),
      }),
      "t",
    );
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: CONTEXT_QUERY_URL }), res);
    assert.equal(parsed(out)["ok"], false);
    assert.match(String(parsed(out)["error"]), /读取目录失败/u);
  });

  it("服务 getter 自身抛错 → 收集异常回执", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        fs: () => realFsService(),
        sessions: () => {
          throw new Error("sessions 炸了");
        },
      }),
      "t",
    );
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: CONTEXT_QUERY_URL }), res);
    assert.match(String(parsed(out)["error"]), /收集异常: sessions 炸了/u);
  });

  it("url 非法定型 → queryParam 回落 null（不抛）", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => realFsService() }), "t");
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "::::" }), res);
    assert.match(String(parsed(out)["error"]), /cwd/u);
  });
});

describe("model 端点", () => {
  it("非 GET → 405", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.model(makeReq({ method: "POST", url: "/m" }), res);
    assert.equal(out.headers["Allow"], "GET");
  });

  it("跨域 → 403", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.model(
      makeReq({ method: "GET", url: "/m", headers: { "sec-fetch-site": CROSS_SITE } }),
      res,
    );
    assert.equal(out.statusCode, 403);
  });

  it("服务缺失 → ok:false", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    handlers.model(makeReq({ method: "GET", url: "/m" }), res);
    assert.match(String(parsed(out)["error"]), /agentDefaultModel/u);
  });

  it("正常：csrf/provider/model/reasoningEffort", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        agentDefaultModel: () => ({
          currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "high" }),
        }),
      }),
      "csrf-m",
    );
    const { res, out } = makeRes();
    handlers.model(makeReq({ method: "GET", url: "/m" }), res);
    const body = parsed(out) as Record<string, string>;
    assert.equal(body["ok"], true);
    assert.equal(body["csrf"], "csrf-m");
    assert.equal(body["reasoningEffort"], "high");
  });

  it("currentSelection 抛错 → ok:false（不炸）", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        agentDefaultModel: () => ({
          currentSelection: () => {
            throw new Error("selection unavailable");
          },
        }),
      }),
      "t",
    );
    const { res, out } = makeRes();
    handlers.model(makeReq({ method: "GET", url: "/m" }), res);
    assert.match(String(parsed(out)["error"]), /读取模型选择失败: selection unavailable/u);
  });
});

describe("organize 端点", () => {
  const csrfHeaders = { "x-dir-prep-csrf": "tok" };
  const csrfHeadersOf = (): Record<string, unknown> => csrfHeaders;

  it("非 POST → 405 + Allow: POST", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.organize(makeReq({ method: "GET", url: "/o" }), res);
    assert.equal(out.headers["Allow"], "POST");
  });

  it("跨域 → 403（guardBody 先拒，不读 body）", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const out = await callOrganize(
      handlers,
      makeReq({
        method: "POST",
        url: "/o",
        headers: { "sec-fetch-site": CROSS_SITE },
        body: "{}",
      }),
    );
    assert.equal(out.statusCode, 403);
  });

  it("CSRF 缺失/错误 → 403 invalid csrf token", async () => {
    const handlers = createRouteHandlers(depsOf({}), "right-token");
    const out = await callOrganize(
      handlers,
      makeReq({ method: "POST", url: "/o", headers: { "x-dir-prep-csrf": "wrong" }, body: "{}" }),
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /csrf/u);
  });

  it("模型服务缺失（getter 返回 undefined）→ 当前无可用模型选择", async () => {
    const handlers = createRouteHandlers(
      depsOf({ llm: () => okStream, sessions: () => sessionsReturning({ header: { cwd: "/w" } }) }),
      "tok",
    );
    const out = await callOrganize(
      handlers,
      makeReq({
        method: "POST",
        url: "/o",
        headers: csrfHeadersOf(),
        body: JSON.stringify({ prompt: "x", sessionId: "s" }),
      }),
    );
    assert.equal(String(parsed(out)["error"]), "当前无可用模型选择");
  });

  it("content-length 超限 → 413（不再被糊成 JSON 错误）", async () => {
    const handlers = createRouteHandlers(depsOf({ llm: () => okStream }), "tok");
    const out = await callOrganize(
      handlers,
      makeReq({ method: "POST", url: "/o", headers: csrfHeaders, declareLength: BODY_MAX + 1 }),
    );
    assert.equal(out.statusCode, 413);
    assert.match(String(parsed(out)["error"]), /too large/u);
  });

  it("流中断（读 body 抛错）→ 400 request body unreadable", async () => {
    const handlers = createRouteHandlers(depsOf({ llm: () => okStream }), "tok");
    const out = await callOrganize(
      handlers,
      makeReq({ method: "POST", url: "/o", headers: csrfHeaders, failStream: true }),
    );
    assert.equal(out.statusCode, 400);
    assert.match(String(parsed(out)["error"]), /unreadable/u);
  });

  it("读到 body 但非 JSON → 400（与超限分路）", async () => {
    const handlers = createRouteHandlers(depsOf({ llm: () => okStream }), "tok");
    const out = await callOrganize(
      handlers,
      makeReq({ method: "POST", url: "/o", headers: csrfHeaders, body: "not-json{{{" }),
    );
    assert.equal(out.statusCode, 400);
    assert.match(String(parsed(out)["error"]), /合法 JSON/u);
  });

  it("body 是数组（非对象）→ 按空 body 处理，回 cwd 错误", async () => {
    const handlers = createRouteHandlers(depsOf({ llm: () => okStream }), "tok");
    const out = await callOrganize(
      handlers,
      makeReq({ method: "POST", url: "/o", headers: csrfHeaders, body: "[1,2]" }),
    );
    assert.match(String(parsed(out)["error"]), /cwd/u);
  });

  it("llm 服务缺失 → ok:false（不调流）", async () => {
    const handlers = createRouteHandlers(depsOf({ sessions: () => sessionsReturningNone }), "tok");
    const out = await callOrganize(
      handlers,
      makeReq({
        method: "POST",
        url: "/o",
        headers: csrfHeaders,
        body: JSON.stringify({ prompt: "整理", sessionId: "s" }),
      }),
    );
    assert.match(String(parsed(out)["error"]), /llm 服务不可用/u);
  });

  it("正常：聚合流返回 content（含 roleText/effort 全链路）", async () => {
    const calls: LlmStreamOptions[] = [];
    const recordingLlm = {
      stream(options: LlmStreamOptions): AsyncIterable<StreamChunk> {
        calls.push(options);
        return okStream.stream();
      },
    } satisfies LlmService;
    const handlers = createRouteHandlers(
      depsOf({
        llm: () => recordingLlm,
        sessions: () =>
          sessionsWithMessages("/w", [
            { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "上文" }] },
          ]),
        agentDefaultModel: () => ({
          currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "low" }),
        }),
      }),
      "tok",
    );
    const req = makeReq({
      method: "POST",
      url: "/o",
      headers: csrfHeaders,
      body: bodyOf({
        prompt: "帮我整理",
        sessionId: "s1",
        roleText: "纵深防御",
        entriesSummary: "📄 a.ts",
      }),
    });
    const out = await callOrganize(handlers, req);
    assert.equal(parsed(out)["ok"], true);
    assert.equal(parsed(out)["content"], "已整理");
    const [firstCall] = calls;
    assert.ok(firstCall, "stream 收到一次调用");
    const system = firstCall.system ?? "";
    // 审计修复主证：roleText 必须进 system（旧版漏传 → 角色整理是 no-op）
    assert.match(system, /参考角色/u);
    assert.ok(system.includes("纵深防御"), "system 含角色正文");
    assert.ok(system.includes("会话最近对话"), "system 含最近对话");
    assert.ok(system.includes("📄 a.ts"), "system 含目录摘要");
    assert.equal(firstCall.reasoningEffort, "low");
    assert.equal(firstCall.messages.length, 1, "只发一条 user 消息");
  });

  it("流以非 Error 值失败 → ok:false 原样回执（errorText 的 String() 支）", async () => {
    const failingLlm = {
      async *stream(): AsyncGenerator<StreamChunk> {
        yield { type: "text-delta", index: 0, text: "x" };
        throwNonError("provider timeout");
        yield { type: "finish", reason: { kind: "stop" } };
      },
    } satisfies LlmService;
    const handlers = createRouteHandlers(
      depsOf({
        llm: () => failingLlm,
        sessions: () => sessionsReturning({ header: { cwd: "/w" } }),
        agentDefaultModel: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
      }),
      "tok",
    );
    const req = makeReq({
      method: "POST",
      url: "/o",
      headers: csrfHeaders,
      body: bodyOf({ prompt: "x", sessionId: "s" }),
    });
    const out = await callOrganize(handlers, req);
    assert.equal(parsed(out)["ok"], false);
    assert.equal(parsed(out)["error"], "provider timeout", "非 Error 原因按 String() 展示");
  });

  it("整理流程内部抛错 → 整理异常回执", async () => {
    const throwingDerive = {
      header: { cwd: "/w" },
      deriveMessages: (): never => {
        throw new Error("derive 炸了");
      },
    } satisfies SessionLike;
    const handlers = createRouteHandlers(
      depsOf({
        llm: () => okStream,
        agentDefaultModel: () => ({
          currentSelection: (): never => {
            throw new Error("模型选择炸了");
          },
        }),
        sessions: () => sessionsReturning(throwingDerive),
      }),
      "tok",
    );
    const req = makeReq({
      method: "POST",
      url: "/o",
      headers: csrfHeaders,
      body: bodyOf({ prompt: "x", sessionId: "s", roleText: "  " }),
    });
    const out = await callOrganize(handlers, req);
    // resolveRecentTurns 吞掉 derive 抛错（回空串），resolveModel 同理（无模型）
    assert.equal(String(parsed(out)["error"]), "当前无可用模型选择");
  });
});

describe("importAgent 端点", () => {
  it("非 POST → 405", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.importAgent(makeReq({ method: "GET", url: "/i" }), res);
    assert.equal(out.headers["Allow"], "POST");
  });

  it("跨域 → 403", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.importAgent(
      makeReq({
        method: "POST",
        url: "/i",
        headers: { "sec-fetch-site": CROSS_SITE },
        body: "{}",
      }),
      res,
    );
    assert.equal(out.statusCode, 403);
  });

  it("body 超限 → 413", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => realFsService() }), "t");
    const { res, out } = makeRes();
    await handlers.importAgent(
      makeReq({ method: "POST", url: "/i", declareLength: BODY_MAX + 1 }),
      res,
    );
    assert.equal(out.statusCode, 413);
  });

  it("非法 JSON → 400", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => realFsService() }), "t");
    const { res, out } = makeRes();
    await handlers.importAgent(makeReq({ method: "POST", url: "/i", body: "nope" }), res);
    assert.equal(out.statusCode, 400);
  });

  it("fs 服务缺失 → ok:false", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    const req = makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "/x" }) });
    await handlers.importAgent(req, res);
    assert.match(String(parsed(out)["error"]), /fs 服务不可用/u);
  });

  it("外部角色目录（登记为 importAllowRoots）：count/entries/skipped 回执", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-imp-"));
    const rolesDir = path.join(root, "roles");
    await mkdir(rolesDir);
    const roleText = "---\nname: 架构师\ndescription: 系统架构\nemoji: 🏛️\n---\n角色正文";
    await writeFile(path.join(rolesDir, "architect.md"), roleText, "utf8");
    const handlers = createRouteHandlers(
      depsOf({ fs: () => realFsService(), importAllowRoots: () => [root] }),
      "t",
    );
    const { res, out } = makeRes();
    const req = makeReq({ method: "POST", url: "/i", body: bodyOf({ path: rolesDir }) });
    await handlers.importAgent(req, res);
    const body = parsed(out);
    assert.equal(body["ok"], true);
    assert.equal(body["count"], 1);
    assert.equal(body["truncated"], false);
    assert.deepEqual(body["skipped"], { tooLarge: 0, unreadable: 0, deeper: 0, unnamed: 0 });
    assert.equal(fieldArray(body["entries"]).length, 1, "回执带出导入条目");
  });

  it("路径不存在 → ok:false + 导入失败", async () => {
    const handlers = createRouteHandlers(
      depsOf({ fs: () => brokenListDirFs(), importAllowRoots: () => ["/tmp"] }),
      "t",
    );
    const { res, out } = makeRes();
    const req = makeReq({
      method: "POST",
      url: "/i",
      body: bodyOf({ path: "/tmp/no-such-roles-xyz" }),
    });
    await handlers.importAgent(req, res);
    assert.match(String(parsed(out)["error"]), /导入失败: ENOENT/u);
  });

  it("getter 抛错 → 导入异常回执", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        fs: () => {
          throw new Error("fs 不可达");
        },
      }),
      "t",
    );
    const { res, out } = makeRes();
    const req = makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "/x" }) });
    await handlers.importAgent(req, res);
    assert.match(String(parsed(out)["error"]), /导入异常: fs 不可达/u);
  });
});

/** 在 fn（可为 async）执行期间收走某个 console 方法（跑完原样装回），返回按序收集的文本行。
 *  缺席分支必须**大声**说明「页面策略未登记」（否则设置卡静默换成宿主自动表单页没人知道），
 *  取表分支必须**安静**（守卫挡掉了就不该再调 describe 然后抛错刷屏）——两个方向都要能断言。
 *  只在该用例期间接管，不改动本文件其它用例照常打印的 stderr。 */
async function captureConsole(
  method: "warn" | "error",
  fn: () => void | Promise<void>,
): Promise<string[]> {
  const original = console[method];
  const seen: string[] = [];
  console[method] = (...args: unknown[]): void => {
    seen.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return seen;
}

describe("apply 装配（服务形状守卫 + 注册/注销）", () => {
  it("settings+webServer 就绪：页面策略登记 1 次 + 4 路由，effect disposer 注销全部", () => {
    const env = harness();
    const { disposers } = env;
    applyTo(env);
    assert.deepEqual(
      env.injected,
      [["settings"], ["webServer"]],
      "页面策略经 inject(['settings'])，四条路由经 inject(['webServer']) 子 fiber",
    );
    assert.equal(env.configureCalls.length, 1, "configure 恰好一次（重复登记会被宿主抛）");
    assert.deepEqual(env.configureCalls.at(0)?.presentation, { auto: false });
    assert.equal(
      env.configureCalls.at(0)?.owner,
      env.fiber,
      "owner 必须显式是本插件 fiber（缺省是 settings 服务自己的 fiber，传错等于给别人的页面定策略）",
    );
    assert.equal(env.routes.length, 5);
    for (const dispose of disposers) {
      dispose();
    }
    assert.equal(env.routes.length, 0, "路由 effect 的 disposer 注销 5 条路由");
  });

  it("注册的 handler 可直接驱动（四个惰性 getter 全部命中形状守卫）", async () => {
    const env = harness();
    applyTo(env);
    const outs = await runRoutes(env);
    assert.equal(env.routes.length, 5);
    assert.equal(outs.length, 5, "五条路由都拿到了回执");
  });

  it("服务全部形状不符（settings 只有 register / webServer 只有 register）→ 守卫不认，跳过且不抛", () => {
    const env = harness({
      settings: { register: () => ({}) },
      webServer: { register: () => returnsNothing },
      sessions: { notGet: 1 },
      fs: { notResolve: 1 },
      llm: { notStream: 1 },
      agentDefaultModel: { notSelection: 1 },
    });
    applyTo(env);
    assert.equal(env.configureCalls.length, 0, "settings 形状不认（无 describe）→ 不登记页面策略");
    assert.equal(env.routes.length, 0, "webServer 形状不认 → 不注册路由");
  });

  // 上面那条只覆盖到「装配期什么都不注册」。host.ts:1478 那个三元还有一支在**请求期**：
  // localeMessages() 每次取表都要 getService("settings") 再过 isSettingsService，
  // 假支（缺席 / 形状不符）此前从没被执行过——因为那两条用例的 webServer 也是坏的，
  // 路由一条没注册，取表路径压根没跑起来。真宿主少装/换形 settings 时走的就是这支，
  // 而它落的注释（"没装官方 locale 插件或 settings 形状不符 → 取到 undefined →
  // 落中文默认，不抛"）当时是一句没测过的话。
  // ⚠ describeCalls 恒空是关键判据：它把「守卫假支」与「守卫真支但 describe() 里没有
  // locale 那一行」（另一条用例，见下方「locale 命名空间未注册」）真正分开——两者都回
  // 中文，只看文案分不出来。
  it("settings 缺席而 webServer 就绪：路由照常服务，取表走守卫假支 → 中文默认且 describe 从不被调用", async () => {
    const env = harness({ fs: realFsService(), settings: undefined });
    const warns = await captureConsole("warn", () => {
      applyTo(env);
    });
    assert.equal(env.routes.length, 5, "settings 缺席不影响五个端点");
    assert.equal(env.configureCalls.length, 0, "没有可 configure 的面 → 页面策略未登记");
    assert.equal(warns.length, 1, "缺席要大声警告一次（宿主会退回自动表单页），且只警告一次");
    assert.match(warns[0] ?? "", /dir-prep-organize.*settings 服务不可用/u);
    let out: FakeResponse | undefined;
    const errors = await captureConsole("error", async () => {
      out = await driveRoute(
        routeOf(env, "import"),
        makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "   " }) }),
      );
    });
    assert.ok(out, "端点拿到了回执");
    assert.equal(out.statusCode, 400, "取表路径的守卫假支不影响端点回执");
    assert.match(String(parsed(out)["error"]), /不能只含空白字符/u, "读不到 locale → 中文默认");
    assert.doesNotMatch(String(parsed(out)["error"]), /whitespace/u, "不得混进英文文案");
    // 守卫假支是**短路**：既不碰 describe（下面这条），也不该留下 describe 抛错的 error
    // （缺席时真去调就是 `undefined.describe()` 的 TypeError → 每个请求一条 error）。
    assert.deepEqual(errors, [], "缺席不得变成每请求一条 error 噪音");
    assert.deepEqual(env.describeCalls, [], "守卫假支：连 describe() 都不该被调用");
  });

  it("settings 形状不符（只有 register，无 describe/configure）而 webServer 就绪：同一条假支的另一成因", async () => {
    // 「装了但形状不是 0.1.7 的 settings」与「没装」在 getService 眼里都是 undefined，
    // 但只有两条都跑到才算钉住那半个三元：0.1.7 移除了 register、换上 describe/configure，
    // 一个 0.1.6 形状的服务残留在这里就必须被守卫挡掉。
    const env = harness({ fs: realFsService(), settings: { register: () => ({}) } });
    const warns = await captureConsole("warn", () => {
      applyTo(env);
    });
    assert.equal(env.routes.length, 5, "webServer 就绪 → 路由照常");
    assert.equal(env.configureCalls.length, 0, "形状不认 → 不登记页面策略");
    assert.equal(warns.length, 1, "同样只警告一次");
    let out: FakeResponse | undefined;
    const errors = await captureConsole("error", async () => {
      out = await driveRoute(
        routeOf(env, "import"),
        makeReq({ method: "POST", url: "/i", body: bodyOf({ path: OUTSIDE_IMPORT_PATH }) }),
      );
    });
    assert.ok(out, "端点拿到了回执");
    // 走完整策略判定路径（不是空白字符早退），确认文案是中文那份
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /越界/u, "取不到 locale → 中文默认");
    assert.deepEqual(errors, [], "形状不符也不该退化成 describe 抛错的 error");
    assert.deepEqual(env.describeCalls, [], "形状不符也不给 describe 机会");
  });

  it("settings 缺席时两个效应仍各回一个 disposer：占位那个调用不抛、不误注销，路由那个才是真注销", () => {
    // 0.1.7 起 apply 期唯一的 settings 动作挂在注入效应上，缺席时它回的是
    // host.ts:1446 的占位 noopDisposer。此前没人调用过它（函数覆盖 99.56% 的缺项就是
    // 这一处）：cordis 要求每个效应可回收，占位实现若被顺手改成会抛的东西，卸载即炸宿主。
    const env = harness({ settings: undefined });
    applyTo(env);
    assert.equal(env.effects.length, 2, "页面策略效应 + 路由效应");
    assert.equal(env.disposers.length, 2, "两个效应都回了 disposer（缺席也不许回 undefined）");
    const [presentationDispose, routesDispose] = env.disposers;
    assert.equal(typeof presentationDispose, "function");
    assert.equal(typeof routesDispose, "function");
    assert.doesNotThrow(() => {
      presentationDispose?.();
    }, "占位 disposer 必须可调用且不抛");
    assert.equal(env.routes.length, 5, "占位 disposer 什么都不做：不得顺手拆掉路由");
    assert.equal(env.configureCalls.length, 0);
    assert.doesNotThrow(() => {
      routesDispose?.();
    });
    assert.equal(env.routes.length, 0, "路由效应那条才是真注销");
  });

  it("ctx 无 get 面 → getService 一律 undefined（缺服务分支）", () => {
    const effects: (() => (() => void) | undefined)[] = [];
    const ctx: Record<string, unknown> = {
      fiber: { id: "no-get-fiber" },
      effect(factory: () => (() => void) | undefined): void {
        effects.push(factory);
        factory();
      },
    };
    // inject 同步以同一个 ctx 回调：隐式注册后 apply 期唯一的 settings 动作挂在它上面
    ctx["inject"] = (_deps: readonly string[], attach: (child: unknown) => void): void => {
      attach(ctx);
    };
    apply(
      ctx as unknown as Parameters<typeof apply>[0],
      configOf({ templates: undefined, importAllowRoots: [] }),
    );
    assert.equal(effects.length, 2);
    for (const factory of effects) {
      assert.equal(typeof factory(), "function", "两个 effect 都返回 disposer");
    }
  });

  it("settings.describe() 抛错（0.1.7 里唯一还会抛的宿主调用）→ 兜住并大声 error，插件不炸", async () => {
    // 旧断言盯的是 settings.register 的 try/catch（存量配置坏一段就直接抛出 apply）。
    // register 已被宿主移除：配置非法在**装载期**由 cordis 按 Config schema 校验时抛，
    // 插件侧不再有可兜的那条路。仍然可达的同类故障只剩 describe()（跨命名空间读 locale），
    // 它落在每个请求的取表路径上，故按同一口径 re-anchor：装配不炸、路由照常、文案回落中文。
    const env = harness({ fs: realFsService() });
    env.describeThrows = new Error("settings service is not ready");
    assert.doesNotThrow(() => {
      applyTo(env);
    });
    assert.equal(env.routes.length, 5, "路由不受 settings 失败影响");
    assert.equal(env.configureCalls.length, 1, "页面策略与 describe 无关，照常登记");
    const out = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "   " }) }),
    );
    assert.equal(out.statusCode, 400, "describe 抛错只影响取表，端点回执照常");
    assert.match(String(parsed(out)["error"]), /不能只含空白字符/u, "取不到 locale → 回落中文默认");
  });

  it("describe() 抛非 Error 值 → 兜底支路仍收得住（errorText 的 String 支）", async () => {
    const env = harness({ fs: realFsService() });
    env.describeThrows = "settings exploded";
    applyTo(env);
    const out = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "   " }) }),
    );
    assert.equal(out.statusCode, 400);
    assert.match(String(parsed(out)["error"]), /不能只含空白字符/u);
  });

  it("官方 locale 偏好 en → 导入回执切英文；改回 zh 后下一个请求即切回（不重启）", async () => {
    const env = harness({ fs: realFsService() });
    env.describeRows = [{ ns: LOCALE_SETTINGS_NAMESPACE, value: { preference: "en-GB" } }];
    applyTo(env);
    const importRoute = routeOf(env, "import");
    const english = await driveRoute(
      importRoute,
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: OUTSIDE_IMPORT_PATH }) }),
    );
    assert.equal(english.statusCode, 403);
    assert.match(String(parsed(english)["error"]), /out of bounds/u);
    assert.doesNotMatch(String(parsed(english)["error"]), /越界/u, "英文回执不该混进中文");
    env.describeRows = [{ ns: LOCALE_SETTINGS_NAMESPACE, value: { preference: "zh-CN" } }];
    const chinese = await driveRoute(
      importRoute,
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: OUTSIDE_IMPORT_PATH }) }),
    );
    assert.match(String(parsed(chinese)["error"]), /越界/u, "同一次 apply 内即切回中文");
    assert.ok(env.describeCalls.length >= 2, "每个请求都重新 describe 一遍（跨命名空间读不缓存）");
  });

  it("locale 命名空间未注册（describe 里没有那一行）→ 中文默认，不抛", async () => {
    const env = harness({ fs: realFsService() });
    applyTo(env);
    const out = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: "   " }) }),
    );
    assert.equal(out.statusCode, 400);
    assert.match(String(parsed(out)["error"]), /不能只含空白字符/u);
  });

  it("en 偏好下的整理：发给模型的 system 提示也是英文", async () => {
    const calls: LlmStreamOptions[] = [];
    const recordingLlm = {
      stream(options: LlmStreamOptions): AsyncIterable<StreamChunk> {
        calls.push(options);
        return okStream.stream();
      },
    } satisfies LlmService;
    const env = harness({
      sessions: sessionsWithMessages("/Users/me/w", []),
      fs: fsReturning([]),
      llm: recordingLlm,
    });
    env.describeRows = [{ ns: LOCALE_SETTINGS_NAMESPACE, value: { preference: "en-US" } }];
    applyTo(env);
    const csrfOut = await driveRoute(routeOf(env, "context"), makeReq(getCtxQuery));
    const csrf = String(parsed(csrfOut)["csrf"]);
    const out = await driveRoute(
      routeOf(env, "organize"),
      makeReq({
        method: "POST",
        url: "/o",
        headers: { "x-dir-prep-csrf": csrf },
        body: bodyOf({ prompt: "整理这段", sessionId: "s1" }),
      }),
    );
    assert.equal(parsed(out)["ok"], true);
    const [call] = calls;
    assert.ok(call, "stream 收到一次调用");
    const system = call.system ?? "";
    assert.match(system, /drafting assistant/u, "system 用英文规则正文");
    assert.doesNotMatch(system, /整理/u, "中文规则不该出现");
  });

  it("可选服务形状全不符 → 四个 getter 的否定支各走一遍", async () => {
    const env = harness({
      sessions: 5,
      fs: { nope: 1 },
      llm: { nope: 1 },
      agentDefaultModel: "not-a-service",
    });
    applyTo(env);
    const driven = await Promise.all(
      env.routes.map(async (route): Promise<{ path: string; out: FakeResponse }> => {
        const isPost = route.path === ORGANIZE_PATH || route.path === IMPORT_PATH;
        const req = makeReq(
          isPost
            ? { method: "POST", url: route.path, body: "{}" }
            : { method: "GET", url: route.path },
        );
        return { path: route.path, out: await driveRoute(route, req) };
      }),
    );
    assert.equal(driven.length, 5);
    for (const item of driven) {
      // defaults 不依赖任何惰性服务（内置表就在 host 侧），依赖全缺席时它仍该回 ok:true——
      // 它是这条"缺依赖 → ok:false"归纳断言里唯一的例外，显式标出来而不是绕开。
      const expectsOk = item.path === DEFAULTS_PATH;
      assert.equal(
        parsed(item.out)["ok"],
        expectsOk,
        `${item.path} 缺依赖时的回执（defaults=${String(expectsOk)}）`,
      );
    }
  });

  it("apply 全链路：GET 拿 csrf → POST organize/import（走通 getter 肯定支）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-apply-"));
    await writeFile(path.join(root, "a.ts"), "export const x = 1", "utf8");
    const env = harness({
      sessions: sessionsWithMessages(root, []),
      fs: realFsService(),
      llm: okStream,
      agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    });
    applyTo(env);
    const contextRoute = routeOf(env, "context");
    const ctxOut = await driveRoute(contextRoute, makeReq(getCtxQuery));
    const csrf = String(parsed(ctxOut)["csrf"]);
    assert.ok(csrf.length > 0, "context 下发 per-apply csrf");
    const orgReq = makeReq({
      method: "POST",
      url: "/o",
      headers: { "x-dir-prep-csrf": csrf },
      body: bodyOf({ prompt: "整理", sessionId: "s1" }),
    });
    const organizeRoute = routeOf(env, "organize");
    assert.equal(parsed(await driveRoute(organizeRoute, orgReq))["ok"], true);
    // 显式 path + 字符串 sessionId：走用户输入策略分支并读会话 cwd
    const impReq = makeReq({
      method: "POST",
      url: "/i",
      body: bodyOf({ sessionId: "s1", path: root }),
    });
    const importRoute = routeOf(env, "import");
    const imp = parsed(await driveRoute(importRoute, impReq));
    assert.equal(imp["ok"], true);
    assert.equal(imp["count"], 0, "临时目录里没有角色 .md");
  });

  it("apply：importAllowRoots 从 volatile 引用现读（登记目录内的路径可导入）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-scope-"));
    const rolesDir = path.join(root, "roles");
    await mkdir(rolesDir);
    await writeFile(path.join(rolesDir, "a.md"), "---\nname: 后端\n---\n你是后端。", "utf8");
    const env = harness({ fs: realFsService() });
    applyTo(env);
    // apply **之后**才改引用背后的值：等价于用户在设置卡上登记目录而不重启插件
    env.configValue.importAllowRoots = [root];
    const out = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: rolesDir }) }),
    );
    assert.equal(out.statusCode, 200);
    assert.equal(parsed(out)["count"], 1, "登记目录内的绝对路径放行");
    const denied = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: OUTSIDE_IMPORT_PATH }) }),
    );
    assert.equal(denied.statusCode, 403, "登记之外的绝对路径仍默认拒绝");
  });

  it("apply：引用里是 .default([]) 的空表 → 只剩内置库根（绝对路径一律 403）", async () => {
    // 旧版这条盯的是「register 未返回可用 scope」；scope 这个概念已随 register 消失。
    // 仍然要锁的是同一件事的**策略面**：读不到登记目录 = 空表 = 不放行绝对路径。
    const env = harness({ fs: realFsService() });
    applyTo(env);
    assert.deepEqual(
      env.configValue.importAllowRoots,
      [],
      "cordis 按 .default([]) 交进来的就是空表",
    );
    const out = await driveRoute(
      routeOf(env, "import"),
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: OUTSIDE_IMPORT_PATH }) }),
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /越界/u);
  });

  it("apply 的 getter 抛错 → 收集异常回执（Error 支）", async () => {
    const env = harness({
      sessions: {
        get: (): SessionLike => {
          throw new Error("sessions-string-error");
        },
      },
    });
    applyTo(env);
    const out = await driveRoute(
      routeOf(env, "context"),
      makeReq({ method: "GET", url: CONTEXT_QUERY_URL }),
    );
    assert.match(String(parsed(out)["error"]), /收集异常: sessions-string-error/u);
  });

  it("organize 的 llm getter 抛错 → 整理异常回执", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        llm: () => {
          throw new Error("llm 服务抖动");
        },
        sessions: () => sessionsReturning({ header: { cwd: "/w" } }),
      }),
      "tok",
    );
    const out = await callOrganize(
      handlers,
      makeReq({
        method: "POST",
        url: "/o",
        headers: { "x-dir-prep-csrf": "tok" },
        body: bodyOf({ prompt: "x", sessionId: "s" }),
      }),
    );
    assert.match(String(parsed(out)["error"]), /整理异常: llm 服务抖动/u);
  });

  it("path 缺字段 / 非字符串 → 400 拒绝（不再静默降级成「导入内置全部」）", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => fsReturning([]) }), "t");
    const { res: resArray, out: outArray } = makeRes();
    await handlers.importAgent(makeReq({ method: "POST", url: "/i", body: "[3]" }), resArray);
    assert.equal(outArray.statusCode, 400, "body 不是对象 → path 缺失 → 400");
    assert.match(String(parsed(outArray)["error"]), /必须是字符串/u);
    const badPath = await callImportAgent(handlers, bodyOf({ path: 42, sessionId: {} }));
    assert.equal(badPath.statusCode, 400);
  });

  it("path 只含空白 → 400 拒绝（空串哨兵不给降级空间）", async () => {
    const handlers = createRouteHandlers(depsOf({ fs: () => fsReturning([]) }), "t");
    const out = await callImportAgent(handlers, bodyOf({ path: "   " }));
    assert.equal(out.statusCode, 400);
    assert.match(String(parsed(out)["error"]), /空白字符/u);
  });

  it("精确空串仍走内置库分支（fs 只见 AGENTS_DIR，不经用户输入策略）", async () => {
    // 空目录假 fs：内置库分支走 AGENTS_DIR，但 listDir 返回 [] → 快且 count 0
    const handlers = createRouteHandlers(depsOf({ fs: () => fsReturning([]) }), "t");
    const builtin = await callImportAgent(handlers, bodyOf({ path: "" }));
    assert.equal(builtin.statusCode, 200);
    assert.equal(parsed(builtin)["count"], 0);
  });

  it("越界绝对路径 → 403 + {ok:false,error}（错误文本点名允许区）", async () => {
    const handlers = createRouteHandlers(
      depsOf({
        fs: () => realFsService(),
        sessions: () => sessionsReturning({ header: { cwd: "/Users/me/w" } }),
      }),
      "t",
    );
    const { res, out } = makeRes();
    await handlers.importAgent(
      makeReq({
        method: "POST",
        url: "/i",
        body: bodyOf({ path: OUTSIDE_IMPORT_PATH, sessionId: "s" }),
      }),
      res,
    );
    assert.equal(out.statusCode, 403);
    const body = parsed(out);
    assert.equal(body["ok"], false);
    assert.match(String(body["error"]), /越界/u);
    assert.match(String(body["error"]), /内置角色库/u);
  });

  it("会话 cwd 内的绝对路径 → 200 正常导入（不设 allowRoots 也放行）", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-cwd-"));
    const rolesDir = path.join(root, "roles");
    await mkdir(rolesDir);
    await writeFile(path.join(rolesDir, "a.md"), "---\nname: 前端\n---\n你是前端。", "utf8");
    const handlers = createRouteHandlers(
      depsOf({ fs: () => realFsService(), sessions: () => sessionsOfCwd(root) }),
      "t",
    );
    const { res, out } = makeRes();
    await handlers.importAgent(
      makeReq({ method: "POST", url: "/i", body: bodyOf({ path: rolesDir, sessionId: "s1" }) }),
      res,
    );
    assert.equal(out.statusCode, 200);
    assert.equal(parsed(out)["count"], 1);
  });

  it("llm 形状不符（有 csrf 但 stream 缺失）→ llm 服务不可用", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dirprep-llm-"));
    const env = harness({
      sessions: sessionsReturning({ header: { cwd: root } }),
      fs: realFsService(),
      llm: { notStream: 1 },
    });
    applyTo(env);
    const ctxOut = await driveRoute(routeOf(env, "context"), makeReq(getCtxQuery));
    const csrf = String(parsed(ctxOut)["csrf"]);
    const orgReq = makeReq({
      method: "POST",
      url: "/o",
      headers: { "x-dir-prep-csrf": csrf },
      body: bodyOf({ prompt: "x", sessionId: "s1" }),
    });
    const orgOut = await driveRoute(routeOf(env, "organize"), orgReq);
    assert.match(String(parsed(orgOut)["error"]), /llm 服务不可用/u);
  });

  it("apply 取到的 sessions 形状合法但查无会话 → handler 内降级", async () => {
    const env = harness();
    applyTo(env);
    const out = await driveRoute(
      routeOf(env, "context"),
      makeReq({ method: "GET", url: "/c?sessionId=z" }),
    );
    assert.match(String(parsed(out)["error"]), /cwd/u);
  });
});

describe("信任闸门：/_dsh/dir-prep/* 的五条路由", () => {
  /** DNS 重绑定的真实形状：Host 是外域、Origin 与 sec-fetch-site 都自洽 ⇒ 只有 Host 腿拒得了。 */
  const REBINDING: Record<string, unknown> = {
    host: EVIL_HOST,
    origin: "http://evil.test:8787",
    "sec-fetch-site": "same-origin",
  };

  it("token 下发的 context GET 被重绑定时：403 且响应里不许带出 csrf", async () => {
    const handlers = createRouteHandlers(depsOf({}), CSRF_TOKEN);
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "/c", headers: REBINDING }), res);
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /untrusted host/u);
    assert.doesNotMatch(out.body, /secret-token/u, "被拒的体里泄露 token 等于闸门白装");
  });

  it("写端点 organize 同样先过闸门（恶意 Host 即便带对 csrf 也拒）", async () => {
    const handlers = createRouteHandlers(depsOf({}), CSRF_TOKEN);
    const { res, out } = makeRes();
    await handlers.organize(
      makeReq({
        method: "POST",
        url: "/o",
        body: JSON.stringify({ cwd: "/tmp/x", entries: [] }),
        headers: { ...REBINDING, "x-dir-prep-csrf": CSRF_TOKEN },
      }),
      res,
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /untrusted host/u);
  });

  it("判据次序：恶意 Host 与 cross-site 同现时报 Host 腿那句", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.context(
      makeReq({
        method: "GET",
        url: "/c",
        headers: { host: EVIL_HOST, "sec-fetch-site": CROSS_SITE },
      }),
      res,
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /untrusted host/u);
  });

  it("缺 Host 是本地 CLI 面（既有 60 个手搓构造点的常态）⇒ 闸门不插手", async () => {
    // 只钉"没被闸门拒"这一件事：成功路径的 csrf 字段由上面「正常路径：csrf/cwd/entries/skipped
    // 齐全」那条用例覆盖（它要喂满 deps），这里 `depsOf({})` 拿到的是本 handler 自己的降级答复。
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.context(makeReq({ method: "GET", url: "/c" }), res);
    assert.equal(out.statusCode, 200);
    assert.doesNotMatch(out.body, /untrusted host|cross-origin/u);
  });

  it("/import 这唯一无 CSRF token 的端点：闸门落地后它是第一道也是唯一一道防线", async () => {
    // host.ts 里那条例外注释（"import 由本地代理发起，不校 CSRF"）在闸门落地之前意味着这条路由
    // 对浏览器侧请求**毫无**判据；现在它至少要求权威是本机的。这条用例钉的就是这个差集。
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.importAgent(
      makeReq({ method: "POST", url: "/i", body: "{}", headers: REBINDING }),
      res,
    );
    assert.equal(out.statusCode, 403);
    assert.match(String(parsed(out)["error"]), /untrusted host/u);
  });
});

describe("405 的统一回执", () => {
  it("methodNotAllowed 现在也回 JSON 体（原先是空体）", async () => {
    const handlers = createRouteHandlers(depsOf({}), "t");
    const { res, out } = makeRes();
    await handlers.organize(makeReq({ method: "GET", url: "/o" }), res);
    assert.equal(out.statusCode, 405);
    assert.equal(out.headers["Allow"], "POST");
    assert.match(out.body, /"error":"POST only"/u);
  });
});
