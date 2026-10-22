// test/integration/settings-boot.test.ts —— 任务 #4：真 `dsh-settings` + 真 Loader 装载本包 Config。
//
// 为什么值得把真 Loader 请进来：此前所有设置面用例都在**手搓 describe() 返回值**上跑
// （test/routes.test.ts 的 locale 那一族、test/client.test.ts 的 ConfigForm 桩），于是
// 「宿主到底把哪些字段投影成可编辑面、写完怎么回流到 volatile 引用」从来没被跑过。
// 这层用的是官方自己的装配法（deepseek-harness packages/settings/settings/tests/
// configuration-fixture.ts）：真临时 profile + 真 cordis.patch.yml + 真 ConfigEditor +
// 真 SettingsForms，条目 id 就是本包 cordis.patch.yml 里那枚 `dir-prep-organize`。
//
// 契约证据（deepseek-harness @ dsh-v0.2.1-alpha.2）：
//  · `SettingsForms` 硬注入 `configEditor` + `profileContext`：packages/settings/settings/src/index.ts；
//    服务名 'settings' 与 `Context.settings` 合并。
//  · 投影面：`describe()` 只收**有 volatile 字段**的条目（volatileForm 回 undefined 即整条跳过）
//    descriptor 必填位 ns/autoGenerate/schema/value/revision/applies；
//    `base`/`user` 只在 redactSecrets 请求下额外给，不带 options 时也有；
//    revision 取 JSON.stringify([fiber.uid, schema.toJSON(), entry.options.config]) 的指纹，
//    变化即 `settings/document-updated`。
//  · volatile 选取规则：`volatileForm` 递归取"最近一个 volatile 祖先"（schema.ts），
//    `plainSchema` 保留 meta.default 但删掉 volatile 标记——这正是本包不把整张
//    内置精选表写进 .default 的理由（host.ts 的 configShape 上方那段注释在此处得到实证）。
//  · 写入面：`update` 合并、`replace` 整段、`mutate` 逐路径；三者在持久化前
//    先过 `cloneJsonShaped`（只放 JSON 形：Date/Map/BigInt/环都拒）与
//    `isVolatilePath` 校验（非 volatile → `Config field "x" is not volatile`）；
//    带 expectedRevision 且对不上 → `SettingsConflictError`（code SETTINGS_CONFLICT）。
//  · 页面策略 `configure({auto}, owner)`：同一 fiber 重复登记抛，缺省 owner 是**服务自己的**
//    fiber，故本包必须显式带 ctx.fiber。
import { afterEach, describe, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { boot, initProfile, readProfilePatches } from "@deepseek-ai/dsh-app-boot";
import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { ConfigEditor } from "@deepseek-ai/dsh-config-editor";
import Settings from "@deepseek-ai/dsh-settings";
import type { SettingsDescriptor } from "@deepseek-ai/dsh-settings";
import Schema from "@deepseek-ai/schemastery";
import { LOCALE_SETTINGS_NAMESPACE } from "@jayyuen66/dsh-plugin-shared/lib/locale";

import { apply, Config, inject } from "../../host.ts";
import type { Config as HostConfig } from "../../host.ts";
import { HOST_MESSAGES } from "../../src/host-messages.ts";
import { DiskFileSystem } from "./real-fs.ts";

/** 本包 cordis.patch.yml 里那枚条目 id：设置页与 describe() 都以此寻址，绝不另起名字。 */
const ENTRY_ID = "dir-prep-organize";

/** profile 台上反复出现的文件名（铺一次与读一次都指向同一枚名字，不留字面量副本）。 */
const PKG_JSON = "package.json";
const PATCH_YML = "cordis.patch.yml";
const CORDIS_YML = "cordis.yml";
/** 临时 profile 里那枚 bundle 的名字（铺盘、patch 行、startedBundles 三处共用同一枚）。 */
const TEST_BUNDLE = "test-bundle";
/** 本包 Remote 读面的最小投影（服务经真 ctx.get 取出）。 */
interface DirPrepRemoteShape {
  context: (request: { sessionId: string }) => Promise<Record<string, unknown>>;
}

function remoteOf(ctx: { get: (name: string) => unknown }): DirPrepRemoteShape {
  const service = ctx.get("dirPrepOrganize") as DirPrepRemoteShape | undefined;
  assert.ok(service !== undefined, "Remote 服务没注册到上下文");
  return service;
}

/** 设置里登记的允许导入目录（行 config、写面、门禁三处指同一枚路径）。 */
const ALLOWED_DIR = "/opt/roles";

/** 装载选项。 */
interface BootOptions {
  /** locale 行 config（决定宿主回执语言的那一条真读数）。 */
  localePreference?: string;
  /** 本包行 config（走 patch 的 config 位，与真实安装同形）。 */
  row?: Record<string, unknown>;
  /** 再挂真磁盘 fs：本包 context 路由先判 fs 再判 cwd（host.ts 的 context handler），
   *  想让回执落到 cwdUnknown 就必须给它一位 fs。 */
  withFs?: boolean;
}

/** 一条装载结果。 */
interface Booted {
  home: string;
  profile: ProfileContext;
  ctx: Awaited<ReturnType<typeof boot>>;
  /** 本包 apply 第二参数（cordis 校验+填默认后的 Config 引用表）——volatile 现读的落点。 */
  config: HostConfig;
  /** 卸载并清临时目录（用例结束时必调，否则临时 profile 会攒下来）。 */
  cleanup: () => Promise<void>;
}

/** locale 条目的最小真形状：只一枚 volatile `preference`，与宿主 dsh-client-locale 的命名空间同形。 */
const LocaleEntry = {
  Config: Schema.object({ preference: Schema.string().default("zh").volatile() }),
  apply: () => {
    /* 该条目只为给 describe() 提供一枚跨命名空间可读位，本身无副作用 */
  },
};

/** 装一台真 profile + 真 Loader + 真 SettingsForms + 本包条目。
 * @param options.localePreference locale 行 config（决定宿主文案语言那一条真读数）
 * @param options.row 本包行 config（走 patch 的 config 位，与真实安装同形）
 */
async function bootRealSettings(options: BootOptions = {}): Promise<Booted> {
  const made = await mkdtemp(path.join(os.tmpdir(), "organize-settings-"));
  // macOS 的 /var → /private/var 是软链：profile 的落点一律用 realpath 后的拼写，
  // 否则 cleanup 与断言会拿两种拼比互相比较。
  const home = await realpath(made);
  const dir = path.join(home, "profiles", "test");
  initProfile(dir, [TEST_BUNDLE]);
  const bundle = path.join(dir, "node_modules", TEST_BUNDLE);
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(home, PKG_JSON), '{"name":"test-installation"}\n');
  await writeFile(
    path.join(bundle, PKG_JSON),
    JSON.stringify({
      name: "test-bundle",
      version: "1.0.0",
      dsh: { bundle: { patch: "cordis.patch.yml" } },
    }),
  );
  // patch 里三条：宿主的 config-editor / settings，本包的 locale 与 dir-prep-organize。
  // 条目 id 用本包 cordis.patch.yml 的同一枚，名字经 builtins 交真件。
  await writeFile(
    path.join(bundle, PATCH_YML),
    JSON.stringify([
      {
        insert: [
          { id: "config-editor", name: "cordis:editor" },
          { id: "settings", name: "cordis:settings" },
          {
            id: LOCALE_SETTINGS_NAMESPACE,
            name: "cordis:locale",
            // 偏好走行 config（真实安装里就是用户在「设置 → 常规」改出来的那一位）
            config:
              options.localePreference === undefined
                ? {}
                : { preference: options.localePreference },
          },
          { id: ENTRY_ID, name: "cordis:organize", config: options.row ?? {} },
        ],
      },
    ]),
  );
  await writeFile(path.join(dir, CORDIS_YML), "[]\n");
  const profile: ProfileContext = {
    name: "test",
    startedBundles: [TEST_BUNDLE],
    dir,
    patchPath: path.join(dir, PATCH_YML),
    installAnchor: path.join(home, PKG_JSON),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  };
  let captured: HostConfig | undefined;
  let cleaned = false;
  const ctx = await boot(
    "test",
    path.join(dir, CORDIS_YML),
    readProfilePatches("test", profile),
    (root) => {
      root.provide("profileContext", profile);
      root.provide("appReady", {
        onReady: (listener: () => void) => {
          listener();
          return () => {
            /* appReady 的 disposer 在本测试面无人订阅 */
          };
        },
      });
      Object.assign(root.loader.builtins, {
        editor: ConfigEditor,
        settings: Settings,
        locale: LocaleEntry,
        // 本包条目的入口形状与发布物一致：{ Config, inject, apply }
        organize: {
          Config,
          inject,
          apply: (child: Parameters<typeof apply>[0], config: HostConfig) => {
            captured = config;
            apply(child, config);
          },
        },
      });
    },
  );
  if (options.withFs === true) {
    /* oxlint-disable-next-line no-new -- FileSystem 的构造即注册（Service 超类把自己
       provide 到 ctx 的服务名上），本用例要的就是这个副作用；赋给变量再丢弃反而是假动作。 */
    new DiskFileSystem(ctx);
  }
  const config = captured;
  if (config === undefined) {
    throw new Error("本包条目没装起来（apply 未被调用）");
  }
  return {
    home,
    profile,
    ctx,
    config,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      await ctx.fiber.dispose();
      await rm(home, { recursive: true, force: true });
    },
  };
}

const booted: Booted[] = [];

/** 起一台并登记回收（用例失败也要收，否则临时 profile 留在盘上）。 */
async function start(options: Parameters<typeof bootRealSettings>[0] = {}): Promise<Booted> {
  const instance = await bootRealSettings(options);
  booted.push(instance);
  return instance;
}

/* 台子是全局的（每次 start 起一台真 profile 装配），hooks 属装配不属任何一族用例；
   回收必须**串行** dispose——并发拆多台下会把 dispose 失败归因不清。 */
/* oxlint-disable vitest/require-top-level-describe, no-await-in-loop */
afterEach(async () => {
  const pending = booted.splice(0);
  for (const instance of pending) {
    await instance.cleanup();
  }
});
/* oxlint-enable vitest/require-top-level-describe, no-await-in-loop */

/** 取某命名空间的 descriptor，缺席即红：有了这一道显式判据，后面逐位访问不必再挂 `?.`。 */
function describeEntry(
  ctx: Awaited<ReturnType<typeof boot>>,
  ns: string,
): SettingsDescriptor | undefined {
  return ctx.settings.describe().find((row) => row.ns === ns);
}

/** profile 条目 id 的命名空间轴（describe() 的 ns 位即它，host.ts 的 inject 也指它）。 */
function requireRow(ctx: Context, ns: string): SettingsDescriptor {
  const row = describeEntry(ctx, ns);
  assert.ok(row !== undefined, `describe() 里找不到 ${ns}`);
  return row;
}

/** descriptor 的 value 位是 unknown：本测试面按"键存在 + 值形"读，不开断言。 */
function sectionOf(row: SettingsDescriptor | undefined): Record<string, unknown> {
  assert.ok(row !== undefined, "describe() 里找不到该命名空间");
  const { value } = row;
  assert.equal(typeof value, "object");
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe("真 Loader + 真 dsh-settings 装载本包 Config", () => {
  it("条目 id 就是 cordis.patch.yml 那枚，且被投影成 live 表单", async () => {
    const { ctx } = await start();
    const namespaces = ctx.settings.describe().map((row) => String(row.ns));
    assert.ok(
      namespaces.includes(ENTRY_ID),
      `describe() 应含 ${ENTRY_ID}，实际 ${namespaces.join(",")}`,
    );
    // config-editor / settings 自己没有 volatile 字段 → 整条被跳过（index.ts 的 `describe()`），
    // 这条"缺席"本身就是投影规则的判据，不许悄悄当成空表单渲染出来。
    assert.equal(namespaces.includes("config-editor"), false);
    const row = requireRow(ctx, ENTRY_ID);
    assert.equal(row.applies, "live");
    assert.equal(row.revision, 0, "首次读为 0（:313-315）");
    // 页面策略：本包 apply 里 configure({auto:false}) 真进了 descriptor，宿主不再生成自动页
    assert.equal(row.autoGenerate, false, "configure({auto:false}) 的效果位（:312）");
  });

  it("volatile 投影只交可热更的那三位，其余部署值不出面", async () => {
    const { ctx } = await start();
    const value = sectionOf(describeEntry(ctx, ENTRY_ID));
    assert.deepEqual(Object.keys(value).toSorted(), [
      "importAllowRoots",
      "organizeTimeoutMs",
      "templates",
    ]);
    const schema = describeEntry(ctx, ENTRY_ID)?.schema;
    assert.equal(typeof schema, "object");
    const form = JSON.stringify(schema);
    // 非 volatile 的两位（maxSnippetBytes/readConcurrency）连 schema 都不出
    for (const hidden of ["maxSnippetBytes", "readConcurrency"]) {
      assert.equal(form.includes(hidden), false, `${hidden} 不该出现在设置表单里`);
    }
  });

  it("写入 volatile 位后：revision +1、document-updated 触发、配置引用当场读到新值", async () => {
    const { ctx, config } = await start();
    const events: { ns: unknown; revision: unknown }[] = [];
    ctx.effect(() =>
      ctx.on("settings/document-updated", (ns, revision) => {
        events.push({ ns, revision });
      }),
    );
    await ctx.settings.update(ENTRY_ID, {
      templates: [{ id: "t1", name: "评审官", text: "正文" }],
    });
    const row = describeEntry(ctx, ENTRY_ID);
    assert.equal(row?.revision, 1);
    assert.deepEqual(
      events.filter((event) => String(event.ns) === ENTRY_ID).map((event) => event.revision),
      [1],
      "revision 变化必发 document-updated（:316-318）",
    );
    // base/user/value 三位各按其义，且**形状彼此不同**（这条只在真件上看得出）：
    // `user` 是补丁里的原文（projectForm 只按 schema 声明丢字段，不填默认，见 index.ts 与
    // schema.ts 的 projectForm），`value` 是 cordis 校验填过默认的现行配置，`base` 是继承层。
    const user = requireRow(ctx, ENTRY_ID).user as Record<string, unknown>;
    assert.deepEqual(user["templates"], [{ id: "t1", name: "评审官", text: "正文" }]);
    assert.deepEqual(sectionOf(row)["templates"], [
      { id: "t1", name: "评审官", description: "", text: "正文", group: "", emoji: "" },
    ]);
    // **volatile 现读**：不重装插件，本包 apply 拿到的引用当场读到新值（这就是 .volatile() 的全部意义）
    assert.deepEqual(config.templates.get(), [
      { id: "t1", name: "评审官", description: "", text: "正文", group: "", emoji: "" },
    ]);
    // 缺省 array 位在"未设置"时读回 []，不是 undefined（client 半的回落判据据此成立）
    assert.deepEqual(config.importAllowRoots.get(), []);
  });

  it("非 volatile 位写入即拒，坏 JSON 形状与坏 schema 也各归各位", async () => {
    const { ctx } = await start();
    await assert.rejects(
      () => ctx.settings.update(ENTRY_ID, { maxSnippetBytes: 1 }),
      /is not volatile/u,
      "index.ts:388/:406 的 volatile 校验",
    );
    // ⚠ 真件给的事实（本层跑出来的，不是推断）：**写入路径不跑 schema 校验**。
    // `update` 只做 cloneJsonShaped + volatile 路径校验（index.ts），
    // 于是缺必填 `text` 的条目会被**接受**并落进 volatile 引用，读回来仍是缺那一位
    // （schemastery 只为有 .default 的字段补默认，必填位无人补）。设置卡的最后防线因此在
    // 消费侧：src/templates.ts 的 sanitizeTemplateList 逐条 normalizeEntry，坏条目丢弃。
    await ctx.settings.update(ENTRY_ID, { templates: [{ id: "x", name: "y" }] });
    const damaged = describeEntry(ctx, ENTRY_ID);
    assert.deepEqual(
      sectionOf(damaged)["templates"],
      [{ id: "x", name: "y", description: "", group: "", emoji: "" }],
      "缺必填位的条目照原样进读面：text 既不存在也不补默认",
    );
    // cloneJsonShaped：Date 不是 JSON 形，持久化前就拒
    await assert.rejects(
      () =>
        ctx.settings.update(ENTRY_ID, { importAllowRoots: [new Date()] as unknown as string[] }),
      /contains a Date/u,
    );
    // 数组下标越界（applyPathOp）
    await assert.rejects(
      () =>
        ctx.settings.mutate(ENTRY_ID, [
          { op: "set", path: ["importAllowRoots", "3", "0"], value: "x" },
        ]),
      /out of range/u,
    );
  });

  it("带 expectedRevision 的写：对不上即 SETTINGS_CONFLICT，绝不覆盖别人的改动", async () => {
    const { ctx, config } = await start();
    await ctx.settings.update(ENTRY_ID, { organizeTimeoutMs: 30_000 });
    await assert.rejects(
      () => ctx.settings.update(ENTRY_ID, { organizeTimeoutMs: 60_000 }, 0),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "SETTINGS_CONFLICT");
        assert.match(String(error), /changed since it was read/u);
        return true;
      },
    );
    assert.equal(config.organizeTimeoutMs.get(), 30_000, "被拒的写不得落到配置上");
  });

  it("行 config 的继承层：patch 给的 importAllowRoots 进 base，并被本包门禁真的读用", async () => {
    const { ctx, config } = await start({
      row: { importAllowRoots: [ALLOWED_DIR], organizeTimeoutMs: 5000 },
    });
    const row = describeEntry(ctx, ENTRY_ID);
    assert.deepEqual((row?.base as Record<string, unknown> | undefined)?.["importAllowRoots"], [
      ALLOWED_DIR,
    ]);
    assert.deepEqual(config.importAllowRoots.get(), [ALLOWED_DIR]);
    assert.equal(config.organizeTimeoutMs.get(), 5000);
    // 写空表即 fail-closed：登记目录是用户的显式动作，清空后绝对路径一律不放
    await ctx.settings.update(ENTRY_ID, { importAllowRoots: [] });
    assert.deepEqual(config.importAllowRoots.get(), []);
  });

  it("跨命名空间 locale 读：宿主 locale 偏好经真 describe() 决定 host 回执语言", async () => {
    // 这一条把「本包只读 locale 那一位」的实现放到真件上跑：文案表来自真 SettingsForms.describe()
    // 的投影结果，而不是手搓的 rows。读面是官方 Remote 服务，直接在真 ctx 上调用。
    const zh = await start({ withFs: true });
    const zhRemote = remoteOf(zh.ctx);
    const zhContext = await zhRemote.context({ sessionId: "none" });
    assert.equal(zhContext["error"], HOST_MESSAGES.zh.cwdUnknown);

    const en = await start({ localePreference: "en", withFs: true });
    // locale 条目自己的 volatile 位读得出，且与本包 ns 同处一张 describe() 表
    assert.equal(sectionOf(describeEntry(en.ctx, LOCALE_SETTINGS_NAMESPACE))["preference"], "en");
    const enRemote = remoteOf(en.ctx);
    const enContext = await enRemote.context({ sessionId: "none" });
    assert.equal(enContext["error"], HOST_MESSAGES.en.cwdUnknown);
    // 改偏好即切语言（现读、不重启）：写 locale 而不是写本包
    await en.ctx.settings.update(LOCALE_SETTINGS_NAMESPACE, { preference: "zh" });
    const backToZh = await enRemote.context({ sessionId: "none" });
    assert.equal(
      backToZh["error"],
      HOST_MESSAGES.zh.cwdUnknown,
      "改偏好即切语言（现读、不重启）：写 locale 而不是写本包",
    );
  });
});
