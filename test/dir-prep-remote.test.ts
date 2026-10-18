// 设置卡读面（官方 Typert Remote）的直测：descriptor 与宿主标记对质、边界码器、
// 命名空间缺口的报错面，以及五个方法的位置传参。真实卡片链路在 test/client.test.ts。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import type { InvocationDescriptor, TypertCodec } from "@deepseek-ai/dsh-typert-protocol";

import {
  createRemotePayloads,
  DirPrepRemoteService,
  DIR_PREP_REMOTE_NAMESPACE,
  installDirPrepRemote,
} from "../host.ts";
import type { LlmService, RouteDeps } from "../host.ts";
import { createDirPrepReader, DIR_PREP_DESCRIPTORS } from "../src/remote.ts";
import { HOST_MESSAGES } from "../src/host-messages.ts";

const PACKAGE_NAME = "@jayyuen66/dsh-dir-prep-organize";
const SERVICE_KEY = `remote.${DIR_PREP_REMOTE_NAMESPACE}`;

function depsOf(partial: Partial<RouteDeps> = {}): RouteDeps {
  return {
    limits: () => ({
      organizeTimeoutMs: 1000,
      maxSnippetBytes: 1024,
      readConcurrency: 1,
    }),
    ...partial,
  };
}

function scopeOf(deps: RouteDeps = depsOf()): {
  deps: RouteDeps;
  messagesOf: () => typeof HOST_MESSAGES.zh;
  limitsOf: () => {
    organizeTimeoutMs: number;
    maxSnippetBytes: number;
    readConcurrency: number;
  };
} {
  return {
    deps,
    messagesOf: () => HOST_MESSAGES.zh,
    limitsOf: () => ({
      organizeTimeoutMs: 1000,
      maxSnippetBytes: 1024,
      readConcurrency: 1,
    }),
  };
}

function noService(): undefined {
  // 缺服务（与真实 ctx.get 未提供时同形）
}

function descriptorOf(method: string): InvocationDescriptor {
  const found = DIR_PREP_DESCRIPTORS.find((descriptor) => descriptor.method === method);
  assert.ok(found !== undefined, `${method} 必须有 descriptor`);
  return found;
}

function strictOf(method: string): TypertCodec & { mode: "strict" } {
  const [parameter] = descriptorOf(method).parameters;
  assert.ok(parameter !== undefined, `${method} 必须有业务参数`);
  if (parameter.codec.mode !== "strict") {
    throw new Error(`${method} 的码器不是 strict`);
  }
  return parameter.codec;
}

describe("设置卡读面（官方 Typert Remote）", () => {
  it("五条 descriptor 与宿主标记逐项对质", () => {
    const service = new DirPrepRemoteService(new Context(), scopeOf());
    const markers = remoteMethods(service)
      .map((marker) => marker.method)
      .toSorted();
    assert.deepEqual(
      DIR_PREP_DESCRIPTORS.map((descriptor) => descriptor.method).toSorted(),
      markers,
    );
    for (const descriptor of DIR_PREP_DESCRIPTORS) {
      assert.equal(
        descriptor.id,
        `${PACKAGE_NAME}#${DIR_PREP_REMOTE_NAMESPACE}/${descriptor.method}`,
      );
      assert.equal(descriptor.service, DIR_PREP_REMOTE_NAMESPACE);
      assert.equal(descriptor.namespace, DIR_PREP_REMOTE_NAMESPACE);
      assert.equal(descriptor.invocation.kind, "direct");
      assert.equal(descriptor.result.mode, "src-json");
    }
    assert.deepEqual(
      DIR_PREP_DESCRIPTORS.filter((descriptor) => descriptor.parameters.length === 0).map(
        (descriptor) => descriptor.method,
      ),
      ["defaults"],
    );
  });

  it("边界码器只收声明的字符串字段，且丢掉未声明字段", () => {
    const session = strictOf("context");
    assert.deepEqual(session.create().parse({ sessionId: "s1", extra: 1 }), { sessionId: "s1" });
    for (const bad of [null, [], {}, { sessionId: 42 }]) {
      assert.throws(() => session.create().parse(bad), /string sessionId/u);
    }
    assert.equal(strictOf("model"), session, "context 与 model 共用一枚码器");

    const organize = strictOf("organize");
    assert.deepEqual(
      organize.create().parse({
        sessionId: "s1",
        prompt: "p",
        entriesSummary: "e",
        roleText: "r",
        extra: true,
      }),
      { sessionId: "s1", prompt: "p", entriesSummary: "e", roleText: "r" },
    );
    assert.deepEqual(
      organize.create().parse({ sessionId: "s1", prompt: "p", entriesSummary: "e" }),
      { sessionId: "s1", prompt: "p", entriesSummary: "e" },
    );
    for (const bad of [
      null,
      { sessionId: "s1" },
      { sessionId: "s1", prompt: "p" },
      { sessionId: "s1", prompt: "p", entriesSummary: "e", roleText: 42 },
    ]) {
      assert.throws(() => organize.create().parse(bad), /organize request/u);
    }

    const importCodec = strictOf("importTemplates");
    assert.deepEqual(importCodec.create().parse({ path: "", sessionId: "" }), {
      path: "",
      sessionId: "",
    });
    for (const bad of [null, { path: 1, sessionId: "" }, { path: "" }]) {
      assert.throws(() => importCodec.create().parse(bad), /string path and sessionId/u);
    }
  });

  it("没有 remote 读面或它没有挂载口 → undefined", () => {
    assert.equal(createDirPrepReader({}), undefined);
    assert.equal(createDirPrepReader({ get: () => null }), undefined);
    assert.equal(createDirPrepReader({ get: () => ({ $mount: 42 }) }), undefined);
  });

  it("五个方法只挂一次命名空间，并把参数按位置传下去", async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const namespace = {
      defaults: async () => {
        calls.push({ method: "defaults", args: [] });
        return { ok: true, value: { templates: [] } };
      },
      context: async (request: unknown) => {
        calls.push({ method: "context", args: [request] });
        return { ok: true, value: { ok: true, cwd: "/w" } };
      },
      model: async (request: unknown) => {
        calls.push({ method: "model", args: [request] });
        return { ok: true, value: { provider: "p", model: "m" } };
      },
      organize: async (request: unknown) => {
        calls.push({ method: "organize", args: [request] });
        return { ok: true, value: { content: "c" } };
      },
      importTemplates: async (request: unknown) => {
        calls.push({ method: "importTemplates", args: [request] });
        return { ok: true, value: { ok: true } };
      },
    };
    let mounts = 0;
    const ctx = {
      get: (name: string, _strict?: boolean): unknown => {
        if (name === "remote") {
          return {
            $mount: async (): Promise<void> => {
              mounts += 1;
            },
          };
        }
        return name === SERVICE_KEY ? namespace : undefined;
      },
    };
    const reader = createDirPrepReader(ctx);
    assert.ok(reader !== undefined);
    assert.deepEqual(await reader.defaults(), { templates: [] });
    assert.deepEqual(await reader.context("s1"), { ok: true, cwd: "/w" });
    assert.deepEqual(await reader.model("s1"), { provider: "p", model: "m" });
    assert.deepEqual(await reader.organize({ sessionId: "s1", prompt: "p", entriesSummary: "e" }), {
      content: "c",
    });
    assert.deepEqual(await reader.importTemplates({ path: "", sessionId: "" }), { ok: true });
    assert.equal(mounts, 1, "五次调用共用同一次 $mount");
    assert.deepEqual(calls, [
      { method: "defaults", args: [] },
      { method: "context", args: [{ sessionId: "s1" }] },
      { method: "model", args: [{ sessionId: "s1" }] },
      { method: "organize", args: [{ sessionId: "s1", prompt: "p", entriesSummary: "e" }] },
      { method: "importTemplates", args: [{ path: "", sessionId: "" }] },
    ]);
  });

  it("命名空间缺席或任一方法不像函数 → 点名读不到的键", async () => {
    const broken: unknown[] = [undefined, null, "not-a-namespace", {}, { defaults: 42 }];
    const full = {
      defaults: async (): Promise<unknown> => ({ ok: true, value: {} }),
      context: async (): Promise<unknown> => ({ ok: true, value: {} }),
      model: async (): Promise<unknown> => ({ ok: true, value: {} }),
      organize: async (): Promise<unknown> => ({ ok: true, value: {} }),
      importTemplates: async (): Promise<unknown> => ({ ok: true, value: {} }),
    };
    for (const key of Object.keys(full)) {
      broken.push({ ...full, [key]: 42 });
    }
    const readers = broken.map((candidate) => {
      const reader = createDirPrepReader({
        get: (name: string): unknown =>
          name === "remote" ? { $mount: () => Promise.resolve() } : candidate,
      });
      assert.ok(reader !== undefined);
      return reader;
    });
    await Promise.all(
      readers.map((reader) => assert.rejects(reader.defaults(), /remote\.dirPrepOrganize 未提供/u)),
    );
  });

  it("失败结果折成带 code 与 message 的 Error", async () => {
    const reader = createDirPrepReader({
      get: (name: string): unknown =>
        name === "remote"
          ? { $mount: () => Promise.resolve() }
          : {
              defaults: async () => ({
                ok: false,
                error: { code: "unavailable", message: "gateway down" },
              }),
              context: async () => ({ ok: true, value: {} }),
              model: async () => ({ ok: true, value: {} }),
              organize: async () => ({ ok: true, value: {} }),
              importTemplates: async () => ({ ok: true, value: {} }),
            },
    });
    assert.ok(reader !== undefined);
    await assert.rejects(reader.defaults(), /unavailable: gateway down/u);
  });

  it("宿主上下文没有注册口 → 只少掉读面，不抛错", () => {
    assert.equal(installDirPrepRemote({} as never, scopeOf() as never), false);
  });

  it("服务方法直接调用：默认模板、上下文、模型、整理与导入", async () => {
    const service = new DirPrepRemoteService(
      new Context(),
      scopeOf(
        depsOf({
          loadDefaultTemplates: async () => [],
          fs: noService,
          llm: noService,
          sessions: noService,
          agentDefaultModel: () => ({ currentSelection: () => ({ provider: "p", model: "m" }) }),
        }),
      ),
    );
    assert.deepEqual(await service.defaults(), { ok: true, templates: [] });
    const contextBody = await service.context({ sessionId: "s1" });
    assert.equal(contextBody["ok"], false);
    assert.deepEqual(service.model({ sessionId: "s1" }), { ok: true, provider: "p", model: "m" });
    const organized = await service.organize(null as never);
    assert.equal(organized["ok"], false);
    const importService = new DirPrepRemoteService(
      new Context(),
      scopeOf(depsOf({ fs: () => ({}) as never })),
    );
    const imported = await importService.importTemplates({ path: 42 as never, sessionId: "" });
    assert.equal(imported["status"], 400);
  });

  it("坏形状请求与缺省 limits 走同一条读面", async () => {
    const llm = {
      async *stream() {
        yield { type: "finish", reason: { kind: "stop" } } as const;
      },
    } satisfies LlmService;
    const service = new DirPrepRemoteService(
      new Context(),
      scopeOf(
        depsOf({
          llm: () => llm,
          sessions: () => ({
            get: () => ({ header: { cwd: "/tmp" }, deriveMessages: () => [] }),
          }),
          agentDefaultModel: noService,
        }),
      ),
    );
    const contextBody = await service.context(null as never);
    assert.equal(contextBody["ok"], false, "非对象请求按无会话处理");
    const organized = await service.organize(null as never);
    assert.equal(organized["ok"], false, "空 body 交回整理失败，而不是抛穿");

    const payloads = createRemotePayloads(
      {
        fs: () =>
          ({
            resolve: async () => ({ targetKey: "/tmp", displayPath: "/tmp" }),
            contains: () => true,
            listDir: async () => [],
            readText: async () => "",
            stat: async () => ({ version: "v", type: "file" }),
          }) as never,
        sessions: () => ({ get: () => ({ header: { cwd: "/tmp" } }) }),
      },
      () => HOST_MESSAGES.zh,
    );
    const collected = await payloads.context("s1");
    assert.equal(collected["ok"], true, "缺省 limits 走 DEFAULT_LIMITS");
  });
});
