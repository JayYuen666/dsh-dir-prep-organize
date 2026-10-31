// 端到端：**构建产物态**装载 + 真宿主服务链。integration 层的 settings-boot/roundtrip
// 都装源码态；本文件把 buildHost() 的 rolldown 产物写进独立临时目录（绝不放进被扫描的
// 工程目录，否则产物自己会出现在目录表里）、按 Node 原生 import 装载（freshness 门禁
// 只比字节、从不执行产物——「产物能不能被宿主装上」只有这一步能证），再驱动
// context → organize → 模型可见消息的全链。装配复用 test/integration/host-stack.ts 的
// bootHostStack（module 注入口为本层新增，缺省仍装源码）。
import { afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import { buildHost } from "../../build-host.mjs";
import type { Context } from "@deepseek-ai/cordis";
import type Schema from "@deepseek-ai/schemastery";
import { bootHostStack, textReply } from "../integration/host-stack.ts";
import type { HostStack } from "../integration/host-stack.ts";

const INDEX_BODY = "export const core = 1;\n";
const INDEX_SNIPPET = "export const core = 1;";

interface Rig {
  host: HostStack;
  project: string;
  productDir: string;
}

const rigs: Rig[] = [];

/** 产物态装配：内存构建 → 独立临时目录落盘（与 dist 布局同构）→ 原生 import → 真宿主装配。 */
async function bootProduct(options: {
  script: readonly string[];
}): Promise<{ host: HostStack; productDir: string }> {
  const productDir = await mkdtemp(path.join(os.tmpdir(), "organize-artifact-"));
  try {
    const artifacts = await buildHost();
    let hostEntry = "";
    await Promise.all(
      Array.from(artifacts, async ([absolute, code]) => {
        const relative = path.relative(process.cwd(), absolute);
        const target = path.join(productDir, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, code, "utf8");
        if (relative.endsWith("host.js")) {
          hostEntry = target;
        }
      }),
    );
    assert.ok(hostEntry !== "", `产物缺 host.js：${String([...artifacts.keys()])}`);
    const product = (await import(pathToFileURL(hostEntry).href)) as {
      inject: readonly string[];
      Config: Schema<any, any>;
      apply: (ctx: Context, config: any) => any;
    };
    assert.equal(typeof product.apply, "function", "产物缺 apply 导出（构建面漂移时这里先红）");
    // 产物不导出 name：条目名由 cordis.patch.yml 给 loader（值与本仓 patch 同源）。
    const host = await bootHostStack({
      module: {
        name: "dir-prep-organize",
        inject: product.inject,
        Config: product.Config,
        apply: product.apply,
      },
      script: options.script.map((reply) => textReply(reply)),
    });
    return { host, productDir };
  } catch (error) {
    await rm(productDir, { recursive: true, force: true });
    throw error;
  }
}

/** 铺一个真工程目录 + 产物态宿主，登记进回收队列。 */
async function boot(replies: readonly string[], files: Record<string, string>): Promise<Rig> {
  const stamp = await mkdtemp(path.join(os.tmpdir(), "organize-product-"));
  const project = await realpath(stamp);
  await Promise.all(
    Object.entries(files).map(([name, body]) => writeFile(path.join(project, name), body, "utf8")),
  );
  let mounted: { host: HostStack; productDir: string };
  try {
    mounted = await bootProduct({ script: replies });
  } catch (error) {
    await rm(project, { recursive: true, force: true });
    throw error;
  }
  mounted.host.session("s1", project);
  const rig: Rig = { host: mounted.host, project, productDir: mounted.productDir };
  rigs.push(rig);
  return rig;
}

/** Remote 读面的本包投影（与 roundtrip.test.ts 同一面）。 */
function serviceOf(host: HostStack): {
  defaults: () => Promise<unknown>;
  context: (request: { sessionId: string }) => Promise<Record<string, unknown>>;
  organize: (request: {
    sessionId: string;
    prompt: string;
    entriesSummary: string;
  }) => Promise<Record<string, unknown>>;
} {
  const service: unknown = host.ctx.get("dirPrepOrganize");
  assert.equal(typeof service, "object", "产物态的 Remote 服务没注册到上下文");
  assert.ok(service !== null);
  const face = service as Record<string, unknown>;
  for (const method of ["defaults", "context", "organize"] as const) {
    assert.equal(typeof face[method], "function", `产物态服务缺方法 ${method}`);
  }
  return service as ReturnType<typeof serviceOf>;
}

describe("构建产物态装载", () => {
  afterEach(async () => {
    const pending = rigs.splice(0);
    const outcomes = await Promise.allSettled(
      pending.map(async ({ host, project, productDir }) => {
        await host.dispose();
        await rm(project, { recursive: true, force: true });
        await rm(productDir, { recursive: true, force: true });
      }),
    );
    const failures = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, "产物态端到端台回收失败");
    }
  });

  it("rolldown 产物经原生 import 装进真宿主，defaults 读面可调", async () => {
    const { host } = await boot(["不被调用"], { "a.ts": "export const a = 1;\n" });
    const defaults = await serviceOf(host).defaults();
    assert.ok(defaults !== null && typeof defaults === "object");
  }, 60_000);

  it("产物态全链：真目录 → context → organize → 模型真收到（cwd 在 system、摘要进围栏）", async () => {
    const { host, project } = await boot(["整理后的正文"], {
      "notes.md": "---\nname: 评审官\n---\n正文\n",
      "index.ts": INDEX_BODY,
    });
    const service = serviceOf(host);
    const context = await service.context({ sessionId: "s1" });
    assert.equal(context["cwd"], project, "产物态的 context 读面交回真会话 cwd");
    const { entries } = context;
    assert.ok(Array.isArray(entries), "目录表经真 fs 读出");
    const names = (entries as { name: string }[]).map((entry) => entry.name);
    assert.deepEqual(names.toSorted(), ["index.ts", "notes.md"], "产物目录不在工程内、不进目录表");

    const organized = await service.organize({
      sessionId: "s1",
      prompt: "把上面那份笔记整理成评审要点",
      entriesSummary: `notes.md\n${INDEX_SNIPPET}`,
    });
    assert.equal(organized["content"], "整理后的正文", "脚本模型回执原样递回");

    // 模型可见面：cwd 在 system，摘要与草稿进 user 帧——两半字段名漂移任何一处都空串。
    const [request] = host.adapter.requests;
    assert.ok(request !== undefined, "真 LlmRuntime 把请求交到了适配器");
    assert.ok((request.system ?? "").includes(project), "会话 cwd 进 system");
    const [frame] = request.messages;
    assert.ok(frame !== undefined);
    assert.equal(frame.role, "user");
    const blocks = frame.content;
    assert.ok(Array.isArray(blocks));
    const userText = blocks
      .map((block) =>
        typeof block === "object" && block !== null
          ? (block as { text?: unknown }).text
          : undefined,
      )
      .filter((text): text is string => typeof text === "string")
      .join("");
    assert.ok(userText.includes("notes.md"), "目录表进模型");
    assert.ok(userText.includes(INDEX_SNIPPET), "关键文件正文进模型");
    assert.ok(userText.includes("把上面那份笔记整理成评审要点"), "草稿原文进 user 帧");
  }, 60_000);
});
