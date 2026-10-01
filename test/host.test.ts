// dir-prep-organize host 半单测（vitest，node 环境）。
// 契约（webServer 重写后；不截断）：
//   collectDirContext(fs, cwd)  注入假 fs 服务：目录枚举+关键文件全文摘要+错误降级
//   runOrganize(llm, input)     注入假 llm stream：text-delta 聚合 / 非 stop 终态报错
//   buildOrganizeSystem         system 提示含 cwd 与目录摘要
// 文案双语：以上纯函数**不读设置**，字典一律由调用方注入（见下方 zhXxx 包装）。
// 本文件绝大多数用例锁的是迁移前的**中文**输出，故包装器统一喂 HOST_MESSAGES.zh；
// 英文链路在「host 文案字典」一节直接调原始实现，断言文案切语言且不残留中文。

import { describe, it, vi } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, mkdir, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";

import {
  collectDirContext as collectDirContextWithDict,
  runOrganize as runOrganizeWithDict,
  buildOrganizeSystem as buildOrganizeSystemWithDict,
  drainStreamToText as drainStreamToTextWithDict,
  importPathError as importPathErrorWithDict,
  collectAgentTemplates as collectAgentTemplatesWithDict,
  Config,
  extractRecentTurns,
  importAllowRootsOf,
} from "../host.ts";
import type {
  CollectResult,
  DerivedMessageView,
  FsDirEntry,
  FsService,
  FsTarget,
  ImportResult,
  LlmService,
  LlmStreamOptions,
  OrganizeInput,
  StreamChunk,
} from "../host.ts";
import { HOST_MESSAGES } from "../src/host-messages.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

// ── 字典注入包装：函数面与迁移前一致（只喂中文表），断言无需改动 ──────────────

const { zh } = HOST_MESSAGES;

// ── 夹具单源 ────────────────────────────────────────────────────────────────
// 本文件里重复 3 次以上的字面量集中在此。**刻意写死、不引被测模块的常量**：
// 断言要钉的是「实现交出什么」，拿实现自己的常量去比实现自己就没人检查任何东西了。

/** 官方 StreamChunk 的 text 增量判别位。 */
const TEXT_DELTA = "text-delta";
/** 假「当前默认模型」交出的模型名（provider 位每次都是 deepseek，未重复到判据线）。 */
const TEST_MODEL = "test-model";
/** 导入策略用例的参照根：假会话 cwd。 */
const SESSION_CWD = "/Users/me/w";
/** 一条参考角色正文：必须整段进发给模型的 system，不得被丢掉。 */
const ROLE_TEXT = "你是安全工程师。关键规则：纵深防御。";
/** 断言消息：一次整理只该发一次 stream 调用。 */
const ONLY_ONE_STREAM_CALL = "stream 收到一次调用";

async function collectDirContext(
  fs: Pick<FsService, "resolve" | "listDir" | "readText">,
  cwd: string | undefined,
): Promise<CollectResult> {
  return collectDirContextWithDict(fs, cwd, zh);
}

function importPathError(
  requested: string,
  cwd: string | undefined,
  allowRoots: readonly string[],
): string | undefined {
  return importPathErrorWithDict(requested, cwd, allowRoots, zh);
}

async function collectAgentTemplates(
  fs: Pick<FsService, "resolve" | "listDir" | "readText">,
  requested: string,
  cwd: string | undefined,
  opts?: { skipPolicy?: boolean; allowRoots?: readonly string[] },
): Promise<ImportResult> {
  return collectAgentTemplatesWithDict(fs, requested, cwd, zh, opts);
}

function buildOrganizeSystem(input: Omit<OrganizeInput, "prompt">): string {
  return buildOrganizeSystemWithDict(input, zh);
}

async function runOrganize(llm: LlmService, input: OrganizeInput): Promise<{ content: string }> {
  return runOrganizeWithDict(llm, input, zh);
}

async function drainStreamToText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  return drainStreamToTextWithDict(stream, zh);
}

/** fs target 替身：dsh 的 targetKey/displayPath 在本包就是路径本身。
 *  `targetKey` 是官方品牌 `FsTargetKey`（installed @deepseek-ai/dsh-fs/lib/types/
 *  types.d.ts:14/:52-60，本包 host 侧已按官方 re-export），唯一的合法构造口是官方
 *  `brandString`（@deepseek-ai/dsh-brand/lib/types/index.d.ts:28，恒等函数）——替身也走它，
 *  不用 `as` 绕过（那正是本仓禁的类型体操）。品牌位直接索引官方成员：dsh-fs 根模块没有
 *  re-export `FsTargetKey` 这个名字。 */
function targetOf(full: string): FsTarget {
  return { targetKey: brandString<FsTarget["targetKey"]>(full), displayPath: full };
}

/** 以非 Error 值抛出：覆盖 catch 里 `String(error)` 兜底支。
 *  `throw "字面量"` 被 only-throw-error 判 error，而 `AbortController.abort(v)`
 *  后 signal.reason 原样携带任意值（throwIfAborted 把它抛出）是真实形状。 */
function throwNonError(reason: unknown): void {
  const controller = new AbortController();
  controller.abort(reason);
  controller.signal.throwIfAborted();
}

function makeDirEntry(
  name: string,
  full: string,
  isDir: boolean,
  size: number | undefined,
): FsDirEntry {
  return {
    name,
    type: isDir ? ("directory" as const) : ("file" as const),
    target: targetOf(full),
    ...(size === undefined ? {} : { size }),
  };
}

/** 会话消息构造（偶数 user/奇数 assistant，供 extractRecentTurns 测试）。 */
function msgs(count: number): {
  role: "user" | "assistant";
  source: { kind: "user" | "model" };
  content: { type: string; text: string }[];
}[] {
  return Array.from({ length: count }, (_idx, idx) => ({
    role: idx % 2 === 0 ? ("user" as const) : ("assistant" as const),
    source: { kind: idx % 2 === 0 ? ("user" as const) : ("model" as const) },
    content: [{ type: "text", text: `消息${String(idx)}` }],
  }));
}

/** node:fs → host 的 FsService 契约适配器（resolve → listDir → 按 target readText）。 */
function realFs(): FsService {
  return {
    resolve: async (target) => targetOf(target),
    listDir: async (dir) => {
      const base = dir.targetKey;
      const names = await readdir(base, { withFileTypes: true });
      const entries = await Promise.all(
        names.map(async (dirent): Promise<FsDirEntry> => {
          const full = path.join(base, dirent.name);
          if (dirent.isDirectory()) {
            return makeDirEntry(dirent.name, full, true, undefined);
          }
          const fileStat = await stat(full);
          return makeDirEntry(dirent.name, full, false, fileStat.size);
        }),
      );
      return entries.toSorted((left, right) => left.name.localeCompare(right.name));
    },
    readText: async (target) => readFile(target.targetKey, "utf8"),
  };
}

// ── collectDirContext ──────────────────────────────────────────────────────

describe("collectDirContext", () => {
  it("cwd 为空 → error", async () => {
    const result: CollectResult = await collectDirContext(realFs(), "");
    assert.ok(result.error !== undefined, "空 cwd 应返回 error");
    assert.equal(result.entries.length, 0);
  });

  it("正常目录：条目+关键文件摘要+目录无摘要", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-ctx-"));
    await writeFile(path.join(dir, "a.ts"), "export const a = 1\n", "utf8");
    await writeFile(path.join(dir, "b.json"), '{"v":2}', "utf8");
    await writeFile(path.join(dir, "README.md"), "# Title\n\nbody", "utf8");
    await writeFile(path.join(dir, "image.png"), "binary", "utf8");
    await writeFile(path.join(dir, "notes.yaml"), "token: sk-xxx\n", "utf8");
    await writeFile(path.join(dir, ".credentials.yaml"), "VISION_API_KEY: sk-yyy\n", "utf8");
    await mkdir(path.join(dir, "sub"));

    const result = await collectDirContext(realFs(), dir);
    assert.equal(result.error, undefined);
    assert.equal(result.truncated, false);
    assert.equal(result.cwd, dir);
    const byName: Record<
      string,
      { name: string; isDir: boolean; sizeBytes: number; snippet: string | undefined }
    > = {};
    for (const entry of result.entries) {
      byName[entry.name] = entry;
    }

    assert.ok(byName["a.ts"], "a.ts 存在");
    // 取条目走 `Array.prototype.find` 而不是 `Record` 下标：下标在 tsc
    // （noUncheckedIndexedAccess）里是 `T | undefined`，而 oxlint 的类型引擎不接这条
    // ⇒ 显式守卫会撞 no-unnecessary-condition、可选链会撞「non-nullish」，两套类型面
    // 必炸一头；find() 在两边都是 `T | undefined`，可选链两头都过且断言强度不变。
    const aTsEntry = result.entries.find((item) => item.name === "a.ts");
    assert.equal(aTsEntry?.snippet?.includes("export"), true, "a.ts snippet 含 export");
    assert.ok(byName["b.json"]!.snippet!.includes("v"), "b.json snippet 含 v");
    assert.ok(byName["README.md"]!.snippet!.includes("Title"), "README snippet 含 Title");
    assert.equal(byName["image.png"]!.snippet, undefined, "png 无摘要");
    assert.equal(byName["sub"]!.isDir, true, "sub 是目录");
    assert.equal(byName["sub"]!.snippet, undefined, "目录无摘要");
    // 敏感面排除（实测 .credentials.yaml 摘要带出 API key）：
    // yaml 不在 KEY_EXT；credentials 命中 SECRET_MARKERS 双保险。
    assert.equal(byName["notes.yaml"]!.snippet, undefined, "yaml 不取摘要");
    assert.equal(byName[".credentials.yaml"]!.snippet, undefined, "credentials 永不取摘要");
  });

  it("条目全量返回（不截断，用户拍板）：250 个文件全部列出", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-limit-"));
    await Promise.all(
      Array.from({ length: 250 }, (_idx, idx) =>
        writeFile(
          path.join(dir, `f${String(idx).padStart(3, "0")}.ts`),
          "export const x = 1",
          "utf8",
        ),
      ),
    );
    const result = await collectDirContext(realFs(), dir);
    assert.equal(result.truncated, false);
    assert.equal(
      result.entries.length,
      250,
      `条目数应全量 250，实际 ${String(result.entries.length)}`,
    );
    assert.ok(
      result.entries.some((entry) => entry.name === "f249.ts"),
      "末尾文件也列出（无截断）",
    );
  });

  it("关键文件摘要是全文而非 200 字符截断（用户拍板）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-full-"));
    const fullBody = `# 标题\n${"内容行 ".repeat(120)}尾部标记`;
    await writeFile(path.join(dir, "long.ts"), fullBody, "utf8");
    const result = await collectDirContext(realFs(), dir);
    assert.equal(result.error, undefined);
    const found = result.entries.find((entry) => entry.name === "long.ts");
    assert.ok(found !== undefined, "long.ts 列出");
    // 不依赖 `!`（oxc 判多余、tsc noUncheckedIndexedAccess 又要处理 undefined）：
    // 先收窄到 snippet 文本与长度再断言。
    const snippetText = found.snippet;
    assert.ok((snippetText ?? "").includes("尾部标记"), "摘要含全文末尾（未截断）");
    const snippetLength = snippetText?.length ?? 0;
    assert.ok(snippetLength > 200, `全文保留，实际 ${snippetLength}`);
  });

  it("目录不存在 → error 而非异常", async () => {
    const result = await collectDirContext(realFs(), path.join(tmpdir(), "dsh-dp-nonexistent-xyz"));
    assert.ok(result.error !== undefined, "不存在目录应返回 error");
  });

  it("关键文件读取失败 → snippet 降级 undefined，不炸", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-bad-"));
    await writeFile(path.join(dir, "a.ts"), "export const a = 1", "utf8");
    const fsBad = {
      ...realFs(),
      readText: async () => {
        throw new Error("boom");
      },
    };
    const result = await collectDirContext(fsBad, dir);
    assert.equal(result.error, undefined);
    const found = result.entries.find((entry) => entry.name === "a.ts");
    assert.ok(found !== undefined, "a.ts 仍列出");
    assert.equal(found.snippet, undefined, "读取失败 snippet 为 undefined");
  });
});

// ── runOrganize（假 llm stream）────────────────────────────────────────────

async function* streamOf(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** 记下每次 stream 入参的假 LlmService（断言 system/messages/effort 用）。 */
function fakeLlm(chunks: readonly StreamChunk[]): {
  calls: LlmStreamOptions[];
  stream: (options: LlmStreamOptions) => AsyncIterable<StreamChunk>;
} {
  const calls: LlmStreamOptions[] = [];
  return {
    calls,
    stream(options: LlmStreamOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      return streamOf(chunks);
    },
  };
}

/** 畸形块夹具：官方 `StreamChunk` 是判别联合，缺必填位的坏形状在类型面上已不可
 *  表示，而这几条测的正是"宿主真送来坏块时本包不得当成成功"（fail-closed），
 *  与类型合法性无关——故经 unknown 显式造坏形状，而不是把生产类型放宽回可选。 */
const badChunk = (chunk: Record<string, unknown>): StreamChunk => chunk as unknown as StreamChunk;

/** 正常完成的一条整理流。 */
const stopStream: StreamChunk[] = [
  { type: TEXT_DELTA, index: 0, text: "整理后的" },
  { type: TEXT_DELTA, index: 0, text: "要求" },
  { type: "finish", reason: { kind: "stop" } },
];

describe("runOrganize", () => {
  it("roleText 端到端：必须真的进到发给模型的 system（审计修复主证）", async () => {
    // 审计原证：runOrganize 组 system 时曾从不传 input.roleText，
    // buildOrganizeSystem 支持、路由也传了，但中间这一跳断了 → 选任何角色
    // 的输出都与「直接整理」一致，界面还报成功。这里把这一跳钉住。
    const withRole = fakeLlm(stopStream);
    await runOrganize(withRole, {
      prompt: "帮我看看这个项目",
      cwd: "/w/proj",
      entriesSummary: "📄 a.ts",
      model: { provider: "deepseek", model: TEST_MODEL },
      roleText: ROLE_TEXT,
    });
    const roleSystem = withRole.calls[0]?.system ?? "";
    assert.ok(roleSystem.includes("- 参考角色:"), "角色段进了 system");
    assert.ok(roleSystem.includes("纵深防御"), "角色正文全文进 system，不得被丢掉");

    const plain = fakeLlm(stopStream);
    await runOrganize(plain, {
      prompt: "帮我看看这个项目",
      cwd: "/w/proj",
      model: { provider: "deepseek", model: TEST_MODEL },
    });
    assert.ok(
      !(plain.calls[0]?.system ?? "").includes("- 参考角色:"),
      "直接整理（无 roleText）不注入角色段（规则文案里也带这些字，故只认注入行的前缀）",
    );
  });

  it("正常流：聚合 text-delta 返回 content，请求带 system+prompt", async () => {
    const llm = fakeLlm([
      { type: "block-start", index: 0, blockType: "text" },
      { type: TEXT_DELTA, index: 0, text: "整理后的" },
      { type: TEXT_DELTA, index: 0, text: "要求" },
      { type: "block-end", index: 0, block: { type: "text", text: "整理后的要求" } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    const result = await runOrganize(llm, {
      prompt: "帮我看看这个项目",
      cwd: "/w/proj",
      entriesSummary: "📄 a.ts",
      model: { provider: "deepseek", model: TEST_MODEL },
    });
    assert.equal(result.content, "整理后的要求");
    const [req] = llm.calls;
    assert.ok(req, ONLY_ONE_STREAM_CALL);
    assert.equal(req.provider, "deepseek");
    assert.equal(req.model, TEST_MODEL);
    assert.ok((req.system ?? "").includes("/w/proj"), "system 含 cwd");
    assert.equal(req.messages.length, 1);
    const [message] = req.messages;
    assert.ok(message, "一条 user 消息");
    assert.equal(message.role, "user");
    const [firstBlock] = message.content;
    assert.equal(firstBlock?.type === "text" ? firstBlock.text : undefined, "帮我看看这个项目");
    // 0.1.7 的 request-only 契约：整理帧从不落持久消息位，故走 `RequestUserInput`
    // （installed @deepseek-ai/dsh-llm/lib/types/types.d.ts:457-462，两面都是
    // `?: never`）。旧断言盯的"归属本插件的 source.kind"正是被这条政策移除的形状——
    // 决策记录 dsh 仓 .agents/notes/implemented/architecture/
    // 2026-09-17-persistence-attribution-policy.md："Request-only prompts need no
    // durable identity"。键必须**根本不存在**，而不是存在但为 undefined。
    assert.ok(!Object.hasOwn(message, "id"), "request-only 输入不得带自造 id");
    assert.ok(!Object.hasOwn(message, "source"), "request-only 输入不得声明 source");
    assert.equal(message.id, undefined, "读不到 id（契约里是 never）");
    assert.equal(message.source, undefined, "读不到 source（契约里是 never）");
    assert.ok(req.signal, "带 AbortSignal（超时可取消）");
  });

  it("空 prompt → error（不调 llm）", async () => {
    const llm = fakeLlm([]);
    await assert.rejects(() => runOrganize(llm, { prompt: "", cwd: "/w" }), /用户要求为空/u);
    assert.equal(llm.calls.length, 0);
  });

  it("缺模型 → error", async () => {
    const llm = fakeLlm([]);
    await assert.rejects(() => runOrganize(llm, { prompt: "x", cwd: "/w" }), /模型/u);
  });

  it("finish 非 stop（error）→ 抛错并带 failure 信息", async () => {
    const llm = fakeLlm([
      { type: TEXT_DELTA, index: 0, text: "部分输出" },
      {
        type: "finish",
        reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "provider 429" } },
      },
    ]);
    await assert.rejects(
      () => runOrganize(llm, { prompt: "x", cwd: "/w", model: { provider: "p", model: "m" } }),
      /provider 429/u,
    );
  });

  it("流缺 finish → 报错", async () => {
    const llm = fakeLlm([{ type: TEXT_DELTA, index: 0, text: "x" }]);
    await assert.rejects(
      () => runOrganize(llm, { prompt: "x", cwd: "/w", model: { provider: "p", model: "m" } }),
      /finish/u,
    );
  });

  it('模型输出全空白 → 报"结果为空"', async () => {
    const llm = fakeLlm([
      { type: TEXT_DELTA, index: 0, text: "   \n " },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    await assert.rejects(
      () => runOrganize(llm, { prompt: "x", cwd: "/w", model: { provider: "p", model: "m" } }),
      /为空/u,
    );
  });
});

// ── buildOrganizeSystem ────────────────────────────────────────────────────

describe("buildOrganizeSystem", () => {
  it("含 cwd 与目录摘要；无摘要时省略目录行", () => {
    const sys = buildOrganizeSystem({ cwd: "/w/proj", entriesSummary: "📄 a.ts" });
    assert.ok(sys.includes("/w/proj"));
    assert.ok(sys.includes("📄 a.ts"));
    const sys2 = buildOrganizeSystem({ cwd: "", entriesSummary: "" });
    assert.ok(!sys2.includes("目录结构摘要"));
  });

  it("有 recentTurns 时注入对话行；为空/缺省时省略（首次对话场景）", () => {
    const sys = buildOrganizeSystem({
      cwd: "/w",
      entriesSummary: "",
      recentTurns: "user: 帮我看看 a.ts\nassistant: 已分析",
    });
    assert.ok(sys.includes("会话最近对话"), "注入对话标题行");
    assert.ok(sys.includes("user: 帮我看看 a.ts"));
    const sysEmpty = buildOrganizeSystem({ cwd: "/w", entriesSummary: "", recentTurns: "" });
    assert.ok(!sysEmpty.includes("会话最近对话"), "空 recentTurns 不注入");
    const sysUndef = buildOrganizeSystem({ cwd: "/w", entriesSummary: "" });
    assert.ok(!sysUndef.includes("会话最近对话"), "缺省 recentTurns 不注入");
  });

  it("只整理不执行：显式禁止把草稿当任务执行（写代码/答题/生成内容）", () => {
    const sys = buildOrganizeSystem({ cwd: "/w", entriesSummary: "" });
    assert.ok(sys.includes("不执行草稿中要求的任何任务"), "显式禁止执行草稿任务");
    assert.ok(sys.includes("不写代码"), "禁止写代码");
    assert.ok(sys.includes("不回答问题"), "禁止回答问题");
    assert.ok(
      sys.includes("不要把解答、方案或示例写进整理结果"),
      "草稿是问题/指令时保持原样优化，不输出解答",
    );
  });
});

// ── extractRecentTurns ────────────────────────────────────────────────────

describe("extractRecentTurns", () => {
  it("会话隔离：只折叠传入的 Session 实例自身消息，不串其它会话", async () => {
    // 两个独立 Session 实例（模拟 sessions.get(id) 拿到的隔离对象）：
    // 每个 Session 自持 log/surface（dsh-session 源码），互不共享。
    const sessionA = { deriveMessages: () => msgs(4) };
    const sessionB = {
      deriveMessages: () => [
        {
          role: "user" as const,
          source: { kind: "user" },
          content: [{ type: "text", text: "B会话专属内容" }],
        },
      ],
    };
    const turnsA = extractRecentTurns(sessionA.deriveMessages());
    const turnsB = extractRecentTurns(sessionB.deriveMessages());
    // A 的上下文不含 B 的内容，反之亦然
    assert.ok(!turnsA.includes("B会话专属内容"), "A 会话不含 B 的消息");
    assert.ok(!turnsB.includes("消息0"), "B 会话不含 A 的消息");
    assert.ok(turnsA.includes("消息3") && turnsB.includes("B会话专属内容"), "各自消息齐全");
  });

  it("注入过滤：agent-instructions/plugin:*/skill-catalog/memory 注入的 user 消息不进上下文（隐藏 bug 复查）", () => {
    // 真实会话 log 实测形状：这些 kind 的 user 消息全带 <system-reminder>/记忆全文。
    // 插件注入位的 kind 是 producer-owned `plugin:<name>`（0.1.7 起持久位上不再有
    // 退役包装 `{ kind: 'plugin' }`；迁移表把历史行也改写成这个形态，
    // 见 session-format-v3-to-v4/src/sources.ts producerKind）——过滤是白名单式
    // （只认 user/model），两种写法都进不了上下文，这里钉的是迁移后的真形状。
    const result = extractRecentTurns([
      {
        role: "user",
        source: { kind: "agent-instructions" },
        content: [{ type: "text", text: "<system-reminder>workspace 规则</system-reminder>" }],
      },
      {
        role: "user",
        source: { kind: "plugin:wukil-dev-tools" },
        content: [{ type: "text", text: "Current runtime context..." }],
      },
      {
        role: "user",
        source: { kind: "skill-catalog" },
        content: [{ type: "text", text: "<system-reminder>技能清单</system-reminder>" }],
      },
      {
        role: "user",
        source: { kind: "memory-recall-step" },
        content: [{ type: "text", text: "以下为与当前消息相关的记忆详情：..." }],
      },
      {
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "真正的用户输入" }],
      },
      {
        role: "assistant",
        source: { kind: "model" },
        content: [{ type: "text", text: "真正的回复" }],
      },
      // tool/result 消息：user 角色但 source.kind==='tool'，跳过
      { role: "user", source: { kind: "tool" }, content: [{ type: "text", text: "工具输出" }] },
    ]);
    assert.ok(!result.includes("workspace 规则"), "agent-instructions 不进上下文");
    assert.ok(!result.includes("runtime context"), "plugin 注入不进上下文");
    assert.ok(!result.includes("技能清单"), "skill-catalog 不进上下文");
    assert.ok(!result.includes("记忆详情"), "memory 注入不进上下文");
    assert.ok(!result.includes("工具输出"), "tool/result 不进上下文");
    assert.equal(result, "user: 真正的用户输入\nassistant: 真正的回复");
  });

  it("user/assistant 文本拼接；纯 tool 消息与空文本被过滤", () => {
    const result = extractRecentTurns([
      { role: "user", source: { kind: "user" }, content: [{ type: "tool-call", name: "bash" }] },
      { role: "assistant", source: { kind: "model" }, content: [] },
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        source: { kind: "model" },
        content: [
          { type: "text", text: "你好" },
          { type: "reasoning", text: "x" },
        ],
      },
    ]);
    assert.equal(result, "user: hi\nassistant: 你好");
  });

  it("空数组（首次对话）→ 空串", () => {
    assert.equal(extractRecentTurns([]), "");
  });

  it("全量保留：不设条数/字符上限（用户拍板）：30 条与 10000 字符长消息均不丢", () => {
    const result = extractRecentTurns(msgs(30));
    assert.ok(result.includes("消息0"), "最旧条保留（不限 10 条）");
    assert.ok(result.includes("消息29"), "最新条保留");
    assert.equal(result.split("\n").length, 30, "30 条全部拼入");
    // 20 条长消息（每条 ~500 字符 ≈ 总 10000）→ 全量保留，无 6000 字符丢旧
    const long: DerivedMessageView[] = Array.from({ length: 20 }, (_idx, idx) => ({
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: `M${String(idx).padStart(2, "0")}:${"x".repeat(500)}` }],
    }));
    const result2 = extractRecentTurns(long);
    assert.ok(result2.includes("M00:"), "最旧长消息保留（不限字符上限）");
    assert.ok(result2.includes("M19:"), "最新长消息保留");
    assert.ok(result2.length > 6000, `总量不受旧上限，实际 ${String(result2.length)}`);
  });
});

// ── buildOrganizeSystem：角色上下文（整理角色化）────────────────────────────

describe("buildOrganizeSystem roleText", () => {
  it("有 roleText → 注入参考角色段（身份/规则内容出现）", () => {
    const sys = buildOrganizeSystem({
      cwd: "/w",
      entriesSummary: "",
      roleText: ROLE_TEXT,
    });
    // 注入行以 "- 参考角色:" 开头（区分于规则文案里的"参考角色"字样）
    assert.ok(sys.includes("- 参考角色:"), "注入角色标题行");
    assert.ok(sys.includes("你是安全工程师"));
    assert.ok(sys.includes("纵深防御"));
  });

  it("缺省/空 roleText → 不注入角色段", () => {
    const sysA = buildOrganizeSystem({ cwd: "/w", entriesSummary: "" });
    const sysB = buildOrganizeSystem({ cwd: "/w", entriesSummary: "", roleText: "" });
    assert.ok(!sysA.includes("- 参考角色:"), "缺省不注入");
    assert.ok(!sysB.includes("- 参考角色:"), "空串不注入");
  });

  it("超长 roleText 全量注入（不截断，用户拍板）", () => {
    const longText = "x".repeat(5000);
    const sys = buildOrganizeSystem({ cwd: "/w", entriesSummary: "", roleText: longText });
    const idx = sys.indexOf("参考角色:");
    const segment = idx === -1 ? "" : sys.slice(idx);
    assert.ok(segment.includes(longText), "参考角色正文全量注入（无 2200 硬上限截断）");
    assert.ok(segment.length > 5000, `实际注入 ${String(segment.length)}`);
  });
});

// ── importPathError（导入路径安全策略：cwd 内 + 内置角色目录 allowlist）──────

/** 本包内置角色库（与 host 的 AGENTS_DIR 同源：test/ 的上级目录下的 agents/）。 */
const AGENTS_OF_PACKAGE = path.join(path.dirname(import.meta.dirname), "agents");

describe("importPathError", () => {
  it("绝对路径默认拒绝：越界回执点名两类允许区并回显解析后的路径", () => {
    const message = importPathError("/etc/passwd.md", SESSION_CWD, []) ?? "";
    assert.match(message, /越界/u);
    assert.match(message, /会话 cwd \/Users\/me\/w/u, "点名会话 cwd");
    assert.match(message, /内置角色库/u, "点名内置角色库");
    assert.match(message, /\/etc\/passwd\.md/u, "回显解析后的绝对路径（不静默降级）");
  });

  it("空串 / 纯空白 / 非路径 → 拒绝（绝不降级成「全量导入」）", () => {
    assert.match(importPathError("", SESSION_CWD, []) ?? "", /不能为空/u);
    assert.match(importPathError("   ", SESSION_CWD, []) ?? "", /不能为空/u);
  });

  it("绝 `..` / `.` 段（归一前拦截）→ 拒绝", () => {
    assert.match(importPathError("/a/b/../c.md", undefined, []) ?? "", /非法段/u);
    assert.match(importPathError("/a/./b.md", undefined, []) ?? "", /非法段/u);
  });

  it("隐藏段（.ssh / .hidden）在允许根以内 → 仍拒绝", () => {
    assert.match(importPathError("/Users/me/w/.ssh/notes.md", SESSION_CWD, []) ?? "", /非法段/u);
    assert.match(importPathError("/Users/me/w/.hidden/x.md", SESSION_CWD, []) ?? "", /非法段/u);
  });

  it("相对路径无 cwd → 拒绝（设置卡场景需登记允许目录或用绝对路径）", () => {
    assert.match(importPathError("agents/eng.md", undefined, []) ?? "", /会话 cwd/u);
  });

  it("会话 cwd 之内（绝对与相对）→ 通过", () => {
    assert.equal(importPathError("/Users/me/w/roles/a.md", SESSION_CWD, []), undefined);
    assert.equal(importPathError("roles/a.md", SESSION_CWD, []), undefined);
    assert.equal(importPathError(SESSION_CWD, SESSION_CWD, []), undefined, "cwd 自身=目录导入");
  });

  it("内置角色库 agents/ → 通过（它在 ~/.dsh 下：隐藏段属安装位置，不是越界）", () => {
    assert.equal(importPathError(AGENTS_OF_PACKAGE, undefined, []), undefined);
    assert.equal(
      importPathError(
        path.join(AGENTS_OF_PACKAGE, "design", "design-ui-designer.md"),
        undefined,
        [],
      ),
      undefined,
    );
  });

  it("importAllowRoots 登记的目录 → 通过；兄弟目录仍拒", () => {
    assert.equal(
      importPathError("/Users/me/agency-agents-zh/engineering/eng.md", undefined, [
        "/Users/me/agency-agents-zh",
      ]),
      undefined,
    );
    assert.notEqual(
      importPathError("/Users/me/other/engineering/eng.md", undefined, [
        "/Users/me/agency-agents-zh",
      ]),
      undefined,
    );
  });
});

// ── importAllowRootsOf（volatile 引用读出的值 → 允许根列表）──────────────────

describe("importAllowRootsOf", () => {
  it("合法数组 → trim 后保留字符串项", () => {
    assert.deepEqual(importAllowRootsOf(["/a/b", " /c/d "]), ["/a/b", "/c/d"]);
  });

  it("引用里不是数组（未解析/存量脏值）→ 空表（fail-closed）", () => {
    assert.deepEqual(importAllowRootsOf(undefined), []);
    assert.deepEqual(importAllowRootsOf("/a"), []);
    assert.deepEqual(importAllowRootsOf({}), []);
    assert.deepEqual(importAllowRootsOf(null), []);
  });

  it("数组里的非字符串与空白项一律丢弃（空串不得变成 process.cwd()）", () => {
    assert.deepEqual(importAllowRootsOf([42, "", "  ", "/ok"]), ["/ok"]);
  });
});

// ── 0.1.7 隐式注册验收：volatileForm(Config) 的字段集 = 设置卡的可编辑字段集 ──
//
// 为什么单独要这一条：命名空间与可编辑字段现在都是**从 schema 反推**的，漏写一个
// `.volatile()` 不会报错，只会让那一项从设置卡上**静默消失**（宿主 describe() 只投影
// volatileForm 的结果，packages/settings/settings/src/schema.ts:37-47）；两个字段全漏
// 则整条被跳过（settings/index.ts:308-309）、写入抛 `has no volatile fields`（:386）。
// 这类退化单元测试全绿，只有拿宿主同一个判据回头看导出的 Config 才拦得住。
//
// ⚠ 它拦不住的：条目 id 与实际 ns 的接线（ns 取自已装配的 profile 文档），以及
// "cordis 真的把这份 Config 挂上了 fiber.runtime.Config" 这一步（仍靠真实宿主启动核对）。

/** 宿主读的是 schema 实例上的 meta/type/dict（settings/src/schema.ts 的 walk 面）。 */
interface SchemaNode {
  type?: string;
  meta?: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
}

/** 复刻宿主 volatileForm()：「自身标了 volatile」或「object 且子树里有可编辑字段」
 *  的字段才进表单。
 *  @returns 顶层 object 时给表单字段名清单；叶子可编辑时给 []；
 *  null = 该子树没有任何可编辑字段（宿主据此整条跳过本条目）。
 *  （用 null 而不是 undefined 表"没有"：本仓 lint 的 consistent-return 配了
 *  `treatUndefinedAsUnspecified`，`return undefined` 记作无值返回、与 `return []` 冲突。） */
function volatileFormOf(node: SchemaNode): string[] | null {
  if (node.meta?.["volatile"] === true) {
    return [];
  }
  if (node.type !== "object") {
    return null;
  }
  const kept = Object.entries(node.dict ?? {}).flatMap(([key, child]) =>
    volatileFormOf(child) === null ? [] : [key],
  );
  return kept.length === 0 ? null : kept;
}

describe("0.1.7 隐式注册验收", () => {
  /** 设置卡该能编辑的字段：模板列表 + 导入允许根，一个都不该漏。 */
  // organizeTimeoutMs volatile 上卡（客户端 fetch 超时同源位）；另两位部署值非 volatile。
  const EDITABLE = ["importAllowRoots", "organizeTimeoutMs", "templates"];
  const NON_VOLATILE = ["importBodyMaxBytes", "maxSnippetBytes", "readConcurrency"];

  it("volatileForm(Config) 的字段集恰为三项可编辑字段（含 organizeTimeoutMs）", () => {
    const schema = Config as unknown as SchemaNode;
    const form = volatileFormOf(schema);
    assert.ok(form !== null, "没有任何 volatile 字段 → 宿主 describe() 整条跳过本条目、设置卡全废");
    assert.deepEqual(form.toSorted(), EDITABLE, "投影字段集与设置卡预期可编辑项不一致");
    assert.deepEqual(
      Object.keys(schema.dict ?? {}).toSorted(),
      [...EDITABLE, ...NON_VOLATILE].toSorted(),
      "schema 字段全集 = 投影可编辑集 + 非 volatile 部署值（importBodyMaxBytes/maxSnippetBytes/readConcurrency）。" +
        "漏标 .volatile() 会让那一项从设置卡上静默消失，新增字段要同步这两张清单",
    );
  });

  it("templates 不给默认 ≠ 未设置读回 undefined：array 字段被 cast 成空表", () => {
    // 这条是「模板列表在页面上整个空掉」那次故障的根因锁定：host 半的注释一度写着
    // 「未设置 → 引用里是 undefined，内置列表由 client 兜」，但 schemastery 对 array 字段
    // 把缺失值 cast 成 `[]`，宿主 describe() 的 projectForm 又只丢 undefined 位
    // （settings/src/index.ts:141-147），于是「未设置」递到客户端就是一张空表。
    // 回落判据因此只能由 client 半出（client-entry.ts 的 fromSettings）——任何按
    // `=== undefined` 判"未设置"的写法都会让内置精选集永不出现。
    interface VolatileRef {
      get: () => unknown;
    }
    const schema = Config as unknown as {
      "~standard": { validate: (value: unknown) => { issues?: unknown; value: unknown } };
    };
    const result = schema["~standard"].validate({});
    assert.equal(result.issues, undefined, "空配置不该校验失败");
    const resolved = result.value as Record<string, VolatileRef>;
    assert.deepEqual(
      resolved["templates"]?.get(),
      [],
      "未设置的 templates 求值为空表（不是 undefined）",
    );
    assert.deepEqual(
      resolved["importAllowRoots"]?.get(),
      [],
      "标了 .default([]) 的字段同为空表：两者在客户端不可区分",
    );
  });

  // 复制式字段覆盖门禁（test/schema-coverage.ts，同 ctx-observe/quality-gate 口径）：解析
  // host.ts 的 Schema.object 字段名，断言卡片半逐个绑定；漏项必须显式列入 allowUnbound 并
  // 写理由，helper 同时反向校验被豁免项确实未绑定（豁免表当不了后门）。helper 只交回问题
  // 清单、不自己登记用例（vitest/require-hook 不收 hook 外的 setup），断言写在本用例体内。
  //
  // ⚠ 锚定面（读 helper 源码得出的事实，不是它的口径可调项）：它取 host.ts 里**第一个**
  // Schema.object 块，本包那是 TemplateEntrySchema = `templates` 的行形状（configSchema 的
  // 数组元素位），所以这一门禁管的是六个行内列；命名空间五项（templates/importAllowRoots/
  // organizeTimeoutMs/maxSnippetBytes/readConcurrency）由上面那条 volatileForm(Config) 用例
  // 与 client.test.ts 的快照读路断言守着，两把门禁覆盖面互补、不重叠。
  it("卡片覆盖 host schema 字段：六个行内列逐列记名豁免（整表写入，无独立设置位）", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
          {
            field: "id",
            reason:
              "行内列（templates 数组元素形状的一列，不是可独立写入的设置键）：由 newTemplateId() 生成、sanitize 的 uniqueEntryId 确定性补重，卡片从不把它做成输入框",
          },
          {
            field: "name",
            reason:
              "行内列：TemplateRow 的名称输入框逐行编辑，落盘经整表 props.set('templates', …)，故没有单独的绑定名可声明；空名称由 sanitize 剔除",
          },
          {
            field: "description",
            reason:
              "行内列：TemplateRow 的一句话说明输入框（列表项 title 取它，空则回落正文），随整表写入，无独立设置键",
          },
          {
            field: "text",
            reason:
              "行内列：TemplateRow 的正文 textarea（点选即填入草稿），随整表写入，空正文整条被 sanitize 剔掉",
          },
          {
            field: "group",
            reason:
              "行内列：TemplateRow 的分组输入框（空串归「通用」分组），随整表写入，无独立设置键",
          },
          {
            field: "emoji",
            reason:
              "行内列：TemplateRow 的视觉标记输入框（占位样例见 EMOJI_PLACEHOLDER），随整表写入，无独立设置键",
          },
        ],
      }),
      [],
    );
  });
});

// ── collectAgentTemplates（角色 .md 导入）───────────────────────────────────

/** 构造一个带 frontmatter 的角色文件内容。 */
function agentFile(name: string, extra = ""): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} 的一句话说明`,
    "emoji: 🧪",
    "---",
    "",
    `# ${name}`,
    "",
    `你是${name}，这是身份的叙述。`,
    "```md",
    "- 这是应被剔除的代码样例",
    "```",
    "关键规则：必须遵守的原则一。",
    extra,
  ].join("\n");
}

describe("collectAgentTemplates", () => {
  it("单 .md 文件导入：frontmatter → 条目（描述/标记/分组/提炼正文、无反引号）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-imp-"));
    const dfn = path.join(dir, "engineering");
    await mkdir(dfn);
    await writeFile(
      path.join(dfn, "engineering-security-engineer.md"),
      agentFile("安全工程师"),
      "utf8",
    );
    const result = await collectAgentTemplates(
      realFs(),
      path.join(dfn, "engineering-security-engineer.md"),
      undefined,
      { allowRoots: [dir] },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0]!;
    assert.equal(entry.name, "安全工程师");
    assert.equal(entry.description, "安全工程师 的一句话说明");
    assert.equal(entry.emoji, "🧪");
    // 父目录 engineering → 中文分组
    assert.equal(entry.group, "工程");
    assert.equal(entry.id, "engineering-security-engineer");
    assert.ok(entry.text.includes("你是安全工程师"));
    assert.ok(entry.text.includes("关键规则"));
    assert.ok(!entry.text.includes("代码样例"), "代码围栏内容被剔除");
    assert.ok(!entry.text.includes("`"), "提炼正文无反引号");
  });

  it("无 frontmatter / 无 name 的 .md → 跳过或报错（单文件场景报错）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-imp2-"));
    await writeFile(path.join(dir, "plain.md"), "# 普通文档\n\n无 frontmatter", "utf8");
    const result = await collectAgentTemplates(realFs(), path.join(dir, "plain.md"), undefined, {
      allowRoots: [dir],
    });
    assert.ok(result.error !== undefined, "单文件无角色定义应报错");
    assert.equal(result.entries.length, 0);
  });

  it("目录导入：顶层 *.md + 一层子目录 *.md，跳过隐藏/非 md/无 name 文件", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-imp3-"));
    await mkdir(path.join(dir, "engineering"));
    await mkdir(path.join(dir, "marketing"));
    await mkdir(path.join(dir, ".hidden"));
    await writeFile(
      path.join(dir, "engineering", "engineering-frontend.md"),
      agentFile("前端开发者"),
      "utf8",
    );
    await writeFile(
      path.join(dir, "marketing", "marketing-xhs.md"),
      agentFile("小红书运营专家"),
      "utf8",
    );
    await writeFile(path.join(dir, "marketing", "notes.txt"), "非 md", "utf8");
    await writeFile(path.join(dir, "marketing", "no-name.md"), "# 无前言的 md", "utf8");
    await writeFile(path.join(dir, ".hidden", "stealth.md"), agentFile("隐藏角色"), "utf8");
    const result = await collectAgentTemplates(realFs(), dir, undefined, { allowRoots: [dir] });
    assert.equal(result.error, undefined);
    assert.equal(result.truncated, false);
    const names = result.entries.map((entry) => entry.name);
    assert.deepEqual(names, ["前端开发者", "小红书运营专家"], "按名排序且仅含有效角色");
    const groups = result.entries.map((entry) => entry.group);
    assert.deepEqual(groups, ["工程", "营销"], "分组来自父目录");
  });

  it("扁平目录（顶层直接放 .md，无子目录）也能导入", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-imp4-"));
    await writeFile(path.join(dir, "eng.md"), agentFile("工程师"), "utf8");
    const result = await collectAgentTemplates(realFs(), dir, undefined, { allowRoots: [dir] });
    assert.equal(result.error, undefined);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]!.group, path.basename(dir), "无部门目录 → 分组回落目录名");
  });

  it("路径策略拒绝（越界 / 根内隐藏段）→ error，不触碰 fs", async () => {
    const outside = await collectAgentTemplates(realFs(), "/Users/x/roles/secret.md", undefined);
    assert.match(outside.error ?? "", /越界/u);
    assert.equal(outside.entries.length, 0);
    const hidden = await collectAgentTemplates(
      realFs(),
      "/Users/me/w/.hidden/secret.md",
      SESSION_CWD,
    );
    assert.match(hidden.error ?? "", /非法段/u);
    assert.equal(hidden.entries.length, 0);
  });

  it("相对路径 + cwd 解析；同名条目 id 去重（-N 后缀）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-imp5-"));
    await mkdir(path.join(dir, "engdir"));
    await writeFile(path.join(dir, "engdir", "dup.md"), agentFile("同名"), "utf8");
    // 单文件路径两次调用不冲突（每次独立 collided）
    const first = await collectAgentTemplates(
      realFs(),
      path.join(dir, "engdir", "dup.md"),
      undefined,
      { allowRoots: [dir] },
    );
    const second = await collectAgentTemplates(realFs(), "engdir/dup.md", dir);
    assert.equal(first.error, undefined);
    assert.equal(second.error, undefined);
    assert.equal(first.entries[0]!.name, second.entries[0]!.name);
  });

  it("导入插件内置角色库 agents/（全量条目充足、含工程分组，且省略项如实回报）", async () => {
    const agentsDir = path.join(path.dirname(import.meta.dirname), "agents");
    // 内置角色库本身就是策略的允许根 → 不跳策略也应通过（先单独锁这一条）
    assert.equal(importPathError(agentsDir, undefined, []), undefined);
    const result = await collectAgentTemplates(realFs(), agentsDir, undefined, {
      skipPolicy: true,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.entries.length > 200, `内置库条目充足，实际 ${String(result.entries.length)}`);
    assert.ok(
      result.entries.some((entry) => entry.group === "工程"),
      "含工程分组",
    );
    // 审计修复：只扫两层 → 第三层（game-development/<engine>/*.md、integrations/*
    // /README.md 共 40 个）以前静默丢失，现在必须计数回报且 truncated 反映事实。
    assert.equal(result.truncated, true, "内置库确有更深层未扫描");
    assert.ok(result.skipped.deeper > 0, `deeper 计数 > 0，实际 ${String(result.skipped.deeper)}`);
  });
});

// ── 审计修复：字节上限 + 有界并发 + 跳过计数（collectDirContext）─────────────

/** 只列 /v 下给定条目、readText 恒返小串的假 fs（size 由测试自己决定）。 */
function fsWithSize(entries: { name: string; size?: number }[]): FsService {
  return {
    resolve: async () => targetOf("root"),
    listDir: async () =>
      entries.map((entry): FsDirEntry => ({
        name: entry.name,
        type: "file",
        target: targetOf(entry.name),
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })),
    readText: async () => "内容",
  };
}

describe("collectDirContext 跳过记账", () => {
  it("超过摘要字节上限的文件整份跳过并计数（truncated=true）", async () => {
    const result = await collectDirContext(
      fsWithSize([{ name: "huge.ts", size: 300 * 1024 }]),
      "/v",
    );
    assert.equal(result.entries[0]?.snippet, undefined, "超限文件不给摘要");
    assert.equal(result.skipped.tooLarge, 1);
    assert.equal(result.truncated, true);
  });

  it("size 缺失（backend 未报）→ 宁缺不盲读，计入 tooLarge", async () => {
    const result = await collectDirContext(fsWithSize([{ name: "nosize.ts" }]), "/v");
    assert.equal(result.skipped.tooLarge, 1);
    assert.equal(result.entries[0]?.snippet, undefined);
  });

  it("读取抛错 → unreadable 计数", async () => {
    const result = await collectDirContext(
      {
        ...fsWithSize([{ name: "a.ts", size: 3 }]),
        readText: async () => {
          throw new Error("EMFILE");
        },
      },
      "/v",
    );
    assert.equal(result.skipped.unreadable, 1);
    assert.equal(result.truncated, true);
  });

  it("并发有界：一次读取的关键文件数远超上限时全部完成、结果按下标回填", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-conc-"));
    await Promise.all(
      Array.from({ length: 40 }, (_idx, idx) =>
        writeFile(
          path.join(dir, `k${String(idx).padStart(2, "0")}.ts`),
          `export const n = ${String(idx)}`,
          "utf8",
        ),
      ),
    );
    const result = await collectDirContext(realFs(), dir);
    assert.equal(result.entries.length, 40);
    assert.equal(result.skipped.tooLarge + result.skipped.unreadable, 0);
    assert.ok(
      result.entries.every((entry) => (entry.snippet ?? "").startsWith("export const")),
      "有界并发下每个关键文件都拿到摘要",
    );
  });
});

// ── 审计修复：允许根绕过面（importPathError 的 footgun 矩阵）────────────────

describe("importPathError 逃逸拦截", () => {
  it("相对路径带 .. → 拒绝（旧版被 path.resolve 归一后放行）", () => {
    assert.match(importPathError("../../etc/passwd.md", SESSION_CWD, []) ?? "", /非法段/u);
    assert.match(importPathError("a/../../etc/passwd.md", SESSION_CWD, []) ?? "", /非法段/u);
    assert.match(importPathError("./secrets/x.md", SESSION_CWD, []) ?? "", /非法段/u);
  });

  it("绝对路径里带 ..（归一后落回 cwd 也无视）→ 拒绝", () => {
    assert.match(
      importPathError("/Users/me/w/../../etc/passwd", SESSION_CWD, []) ?? "",
      /非法段/u,
      "原始串先拦，归一后「恰好回到 cwd」的把戏也不放行",
    );
  });

  it("兄弟目录的字符串前缀骗术 → 拒绝（逐段比较，非 startsWith）", () => {
    assert.match(
      importPathError("/home/dev/project-two/x.md", "/home/dev/project", []) ?? "",
      /越界/u,
      "/home/dev/project-two 有 /home/dev/project 的前缀，但不是它之内",
    );
    assert.match(
      importPathError("/home/dev/project-two/x.md", "/home/dev/project", [
        "/home/dev/projectExtra",
      ]) ?? "",
      /越界/u,
      "允许目录同样按段比较",
    );
  });

  it("cwd 装在隐藏段下（~/.dsh/w）→ cwd 以内的相对路径可用（旧版整片拦死）", () => {
    assert.equal(importPathError("proj/a.md", "/Users/me/.dsh/w", []), undefined);
    assert.match(importPathError("proj/.ssh/a.md", "/Users/me/.dsh/w", []) ?? "", /非法段/u);
  });

  it("cwd 缺失的相对路径 → 拒绝；无 cwd 时只有内置库与登记目录可导入", () => {
    assert.match(importPathError("a.md", undefined, []) ?? "", /会话 cwd/u);
    assert.equal(
      importPathError("/Users/me/roles/a.md", undefined, ["/Users/me/roles"]),
      undefined,
    );
    assert.notEqual(importPathError("/Users/me/roles/a.md", undefined, []), undefined);
  });
});

// ── 审计修复：roleText 端到端进 system（runOrganize）────────────────────────

describe("runOrganize 角色上下文透传", () => {
  it("传 roleText → system 含参考角色段；不传 → 不含（旧版恒不含 = 功能空转）", async () => {
    const llmWith = fakeLlm(stopStream);
    await runOrganize(llmWith, {
      prompt: "写点什么",
      cwd: "/w",
      roleText: ROLE_TEXT,
      model: { provider: "p", model: "m" },
    });
    const [withRole] = llmWith.calls;
    assert.ok(withRole, ONLY_ONE_STREAM_CALL);
    const system = withRole.system ?? "";
    assert.ok(system.includes("- 参考角色:"), "system 带角色标题行");
    assert.ok(system.includes("纵深防御"), "system 带角色正文（旧版此处为 false）");

    const llmWithout = fakeLlm(stopStream);
    await runOrganize(llmWithout, {
      prompt: "写点什么",
      cwd: "/w",
      model: { provider: "p", model: "m" },
    });
    const [withoutRole] = llmWithout.calls;
    assert.ok(withoutRole, ONLY_ONE_STREAM_CALL);
    assert.ok(!(withoutRole.system ?? "").includes("- 参考角色:"), "不传不带角色段");
  });

  it("effort 缺省时 stream 入参不出现 reasoningEffort 键（exactOptionalPropertyTypes）", async () => {
    const llm = fakeLlm(stopStream);
    await runOrganize(llm, {
      prompt: "x",
      cwd: "/w",
      model: { provider: "p", model: "m" },
    });
    const [call] = llm.calls;
    assert.ok(call, ONLY_ONE_STREAM_CALL);
    assert.equal("reasoningEffort" in call, false, "exactOptionalPropertyTypes：缺省不写键");
  });
});

// ── drainStreamToText 终态矩阵 ──────────────────────────────────────────────

const run = async (chunks: readonly StreamChunk[]): Promise<string> =>
  drainStreamToText(streamOf(chunks));

describe("drainStreamToText", () => {
  it("非 text-delta/finish 块忽略；text-delta 缺 text 不拼", async () => {
    assert.equal(
      await run([
        { type: "block-start", index: 0, blockType: "text" },
        badChunk({ type: TEXT_DELTA, index: 0 }),
        { type: TEXT_DELTA, index: 0, text: "甲" },
        { type: "block-end", index: 0, block: { type: "text", text: "甲" } },
        { type: "finish", reason: { kind: "stop" } },
      ]),
      "甲",
    );
  });

  it("finish 无 reason → 缺 finish 报错", async () => {
    await assert.rejects(() => run([badChunk({ type: "finish" })]), /缺少 finish/u);
  });

  it("终态缺 kind → 报未正常完成（fail-closed）", async () => {
    await assert.rejects(() => run([badChunk({ type: "finish", reason: {} })]), /unknown/u);
  });

  it("failure 为空串 message → 不带冒号后缀", async () => {
    await assert.rejects(
      () =>
        run([
          { type: "finish", reason: { kind: "error", failure: { code: "EMPTY", message: "" } } },
        ]),
      /error）$/u,
    );
  });

  it("max-tokens 终态 → 视为未完成", async () => {
    await assert.rejects(
      () => run([{ type: "finish", reason: { kind: "max-tokens" } }]),
      /max-tokens/u,
    );
  });
});

// ── 覆盖率补全：跳过分类 / 非 Error 抛出 / 空正文 / id 碰撞 ──────────────────

/** 以给定原因失败：Error 直抛；非 Error 借 AbortSignal.reason（见 throwNonError）。 */
function failWith(reason: unknown): void {
  if (reason instanceof Error) {
    throw reason;
  }
  throwNonError(reason);
}

interface MemFsOptions {
  /** readText 命中该**文件名**时失败，原样抛出 reason。 */
  failsOnRead?: { name: string; reason: unknown };
  /** listDir 一律失败。 */
  listDirFails?: unknown;
  /** resolve 一律失败。 */
  resolveFails?: unknown;
}

/** 纯内存假 fs（不碰磁盘，便于塞超限/抛错/深层目录形状）。 */
function memFs(files: Record<string, string>, opts: MemFsOptions = {}): FsService {
  const dirs = new Map<string, FsDirEntry[]>();
  const pushEntry = (dirKey: string, entry: FsDirEntry): void => {
    const bucket = dirs.get(dirKey) ?? [];
    if (!bucket.some((item) => item.name === entry.name)) {
      bucket.push(entry);
      dirs.set(dirKey, bucket);
    }
  };
  for (const [filePath, text] of Object.entries(files)) {
    const baseDir = path.dirname(filePath);
    pushEntry(baseDir, {
      name: path.basename(filePath),
      type: "file",
      target: targetOf(filePath),
      size: new TextEncoder().encode(text).length,
    });
    pushEntry(path.dirname(baseDir), {
      name: path.basename(baseDir),
      type: "directory",
      target: targetOf(baseDir),
    });
  }
  return {
    resolve: async (target: string) => {
      if (opts.resolveFails !== undefined) {
        failWith(opts.resolveFails);
      }
      return targetOf(target);
    },
    listDir: async (dir: FsTarget) => {
      if (opts.listDirFails !== undefined) {
        failWith(opts.listDirFails);
      }
      return dirs.get(dir.targetKey) ?? [];
    },
    readText: async (target: FsTarget) => {
      const failure = opts.failsOnRead;
      if (failure !== undefined && failure.name === path.basename(target.targetKey)) {
        failWith(failure.reason);
      }
      return files[target.targetKey] ?? "";
    },
  };
}

const roleDoc = (name: string): string => `---\nname: ${name}\n---\n你是${name}。`;

describe("collectAgentTemplates 分类计数", () => {
  it("超限文件计 tooLarge、读失败计 unreadable、非角色计 unnamed", async () => {
    const bigBody = `---\nname: 巨无霸\n---\n${"字".repeat(200_000)}`;
    const files: Record<string, string> = {
      "/roles/big.md": bigBody,
      "/roles/broken.md": roleDoc("读不到"),
      "/roles/plain.md": "# 只是文档\n无 frontmatter",
      "/roles/good.md": roleDoc("好角色"),
      "/roles/sub/dup.md": roleDoc("子层同名"),
    };
    const fs = memFs(files, { failsOnRead: { name: "broken.md", reason: new Error("EIO") } });
    const result = await collectAgentTemplates(fs, "/roles", undefined, {
      allowRoots: ["/roles"],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.skipped.tooLarge, 1, "big.md 超字节上限");
    assert.equal(result.skipped.unreadable, 1, "broken.md 读失败");
    assert.equal(result.skipped.unnamed, 1, "plain.md 无 name");
    assert.equal(result.truncated, true);
    // good.md 与 sub/dup.md 同名 slug 不冲突（不同目录），但同 slug 时走改写分支
    assert.ok(result.entries.length > 0, "有效角色仍全部装配");
  });

  it("同 slug 碰撞 → 确定性改写 id（覆盖 while 分支）", async () => {
    const fs = memFs({
      "/roles/a/x.md": roleDoc("甲"),
      "/roles/b/x.md": roleDoc("乙"),
    });
    const result = await collectAgentTemplates(fs, "/roles", undefined, {
      allowRoots: ["/roles"],
    });
    assert.deepEqual(
      result.entries.map((entry) => entry.id).toSorted(),
      ["x", "x-2"],
      "第二个同名条目按 collided.size+1 改写",
    );
  });

  it("正文提炼为空（全代码围栏）→ 该条剔除并计 unnamed", async () => {
    const fs = memFs({ "/roles/a/only-fence.md": "---\nname: 空正文\n---\n```\ncode\n```" });
    const result = await collectAgentTemplates(fs, "/roles", undefined, {
      allowRoots: ["/roles"],
    });
    assert.equal(result.entries.length, 0);
    assert.equal(result.skipped.unnamed, 1);
  });

  it("单文件正文提炼为空 → entries 空数组", async () => {
    const fs = memFs({ "/roles/a/only-fence.md": "---\nname: 空正文\n---\n```\ncode\n```" });
    const result = await collectAgentTemplates(fs, "/roles/a/only-fence.md", undefined, {
      allowRoots: ["/roles"],
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.entries, []);
  });

  it("skipPolicy + 相对路径且无 cwd → 按空前缀解析（不抛）", async () => {
    const fs = memFs({ "roles/a.md": roleDoc("甲") });
    const result = await collectAgentTemplates(fs, "roles", undefined, { skipPolicy: true });
    assert.equal(result.error, undefined);
  });

  it("相对目录路径 + cwd → 正常解析", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-rel-"));
    await mkdir(path.join(dir, "roles"));
    await writeFile(path.join(dir, "roles", "eng.md"), agentFile("工程师"), "utf8");
    const result = await collectAgentTemplates(realFs(), "roles", dir);
    assert.equal(result.error, undefined);
    assert.equal(result.entries.length, 1);
  });

  it("listDir 以非 Error 失败 → 导入失败回执走 String()", async () => {
    const broken = memFs({ "/roles/a.md": roleDoc("甲") }, { listDirFails: "raw-string-error" });
    const result = await collectAgentTemplates(broken, "/roles", undefined, {
      allowRoots: ["/roles"],
    });
    assert.match(result.error ?? "", /导入失败: raw-string-error/u);
  });

  it("readText 以非 Error 失败 → unreadable 计数照常记账", async () => {
    const fs = memFs(
      { "/roles/a.md": roleDoc("甲") },
      { failsOnRead: { name: "a.md", reason: "string-reason" } },
    );
    const result = await collectAgentTemplates(fs, "/roles", undefined, {
      allowRoots: ["/roles"],
    });
    assert.equal(result.entries.length, 0);
    assert.equal(result.skipped.unreadable, 1);
  });
});

describe("collectDirContext 边角", () => {
  it("无扩展名文件不取摘要；纯空白关键文件摘要为空串", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dsh-dp-edge-"));
    await writeFile(path.join(dir, "LICENSE"), "MIT", "utf8");
    await writeFile(path.join(dir, "blank.ts"), "   \n\t", "utf8");
    const result = await collectDirContext(realFs(), dir);
    const license = result.entries.find((entry) => entry.name === "LICENSE");
    const blank = result.entries.find((entry) => entry.name === "blank.ts");
    assert.equal(license?.snippet, undefined, "无扩展名 → 不取摘要");
    assert.equal(blank?.snippet, "", "纯空白 → 空串摘要");
  });

  it("resolve 以非 Error 失败 → 读取目录失败走 String()", async () => {
    const result = await collectDirContext(memFs({}, { resolveFails: "boom-string" }), "/whatever");
    assert.match(result.error ?? "", /读取目录失败: boom-string/u);
  });
});

describe("extractRecentTurns 坏形状", () => {
  it("非对象块 / 其它 role / content 非数组 都不进上下文", () => {
    const out = extractRecentTurns([
      { role: "system", source: { kind: "user" }, content: [{ type: "text", text: "x" }] },
      { role: "user", source: { kind: "user" }, content: "不是数组" },
      { role: "assistant", source: { kind: "model" }, content: ["裸字符串块", null] },
      { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "真回复" }] },
    ]);
    assert.equal(out, "assistant: 真回复");
  });
});

describe("runOrganize 超时", () => {
  it("120 秒未完成 → abort 触发，流结束后按缺 finish 报错", async () => {
    vi.useFakeTimers();
    let aborted = false;
    // 一条"永不自己结束"的流：只有 host 的超时 abort 才能让它收尾。
    const hangingLlm = {
      stream(options: LlmStreamOptions): AsyncIterable<StreamChunk> {
        const { signal } = options;
        assert.ok(signal, "runOrganize 必须带 AbortSignal");
        return {
          [Symbol.asyncIterator]: (): AsyncIterator<StreamChunk, undefined> => ({
            next: async (): Promise<IteratorResult<StreamChunk, undefined>> => {
              if (!signal.aborted) {
                const gate = Promise.withResolvers<undefined>();
                signal.addEventListener(
                  "abort",
                  () => {
                    gate.resolve(undefined);
                  },
                  { once: true },
                );
                await gate.promise;
              }
              const { aborted: isAborted } = signal;
              aborted = isAborted;
              return { done: true, value: undefined };
            },
          }),
        };
      },
    } satisfies LlmService;
    const pending = runOrganize(hangingLlm, {
      prompt: "x",
      cwd: "/w",
      model: { provider: "p", model: "m" },
    });
    // 先挂好 handler 再推进假时钟：否则 rejection 在 await 之前落地成 unhandled。
    const settled = Promise.allSettled([pending]);
    await vi.advanceTimersByTimeAsync(121_000);
    // `.at(0)` 而不是 `[0]` 解构：oxlint 的类型引擎不接 tsc 的 noUncheckedIndexedAccess，
    // 下标取到的元素在它眼里非空 ⇒ `outcome === undefined` 被判恒假；at() 的返回类型
    // 本身就带 `| undefined`，两套类型面一致，守卫保留。
    const outcomes = await settled;
    const outcome = outcomes.at(0);
    if (outcome === undefined || outcome.status === "fulfilled") {
      assert.fail("超时后整理必须以缺 finish 失败");
    }
    assert.match(String(outcome.reason), /缺少 finish/u);
    assert.equal(aborted, true, "超时后 signal 已 abort");
    vi.useRealTimers();
  });
});

// ── host 文案字典（中英双语）──────────────────────────────────────────────────

/** 中文残留判据（en 表与 en 输出都必须是零汉字）；无 /g 故可安全复用。 */
const hanPattern = /\p{Script=Han}/u;

describe("HOST_MESSAGES 字典", () => {
  it("zh / en 键集完全一致（类型已锁死，此处理事运行时留一条可读的失败）", () => {
    assert.deepEqual(
      Object.keys(HOST_MESSAGES.en).toSorted(),
      Object.keys(HOST_MESSAGES.zh).toSorted(),
    );
  });

  it("en 表逐条无中文残留（漏译的键在这条失败里被点名）", () => {
    // 整表 JSON 化而不是按键遍历：HostMessages 是 interface（无隐式索引签名），
    // 反射取值只能把 unknown 强投影成 Record——那正是 src 侧禁的形状谎报。
    assert.doesNotMatch(JSON.stringify(HOST_MESSAGES.en), hanPattern);
  });
});

describe("en 字典注入（纯函数只吃入参字典，不读设置）", () => {
  const { en } = HOST_MESSAGES;

  it("整理 system prompt 整段切英文：规则正文与各段标题行都来自 en 表", () => {
    const sys = buildOrganizeSystemWithDict(
      { cwd: "/w", entriesSummary: "a.ts", recentTurns: "user: hi", roleText: "Reviewer" },
      en,
    );
    assert.match(sys, /^- Current working directory: \/w$/mu);
    assert.match(sys, /Directory summary:/u);
    assert.match(sys, /Recent conversation/u);
    assert.match(sys, /Reference role:/u);
    assert.doesNotMatch(sys, hanPattern, "英文 prompt 不该混进中文规则");
  });

  it("cwd 为空：en 用 (not provided)，zh 仍是（未提供）", () => {
    assert.match(
      buildOrganizeSystemWithDict({ cwd: "" }, en),
      /- Current working directory: \(not provided\)$/mu,
    );
    assert.match(buildOrganizeSystem({ cwd: "" }), /- 当前工作目录: （未提供）$/mu);
  });

  it("导入路径回执切英文：空路径 / 非法段 / 越界点名各允许区", () => {
    assert.match(importPathErrorWithDict("", SESSION_CWD, [], en) ?? "", /cannot be empty/u);
    assert.match(
      importPathErrorWithDict("/a/../b.md", SESSION_CWD, [], en) ?? "",
      /illegal segment/u,
    );
    const outside = importPathErrorWithDict("/etc/passwd.md", SESSION_CWD, [], en) ?? "";
    assert.match(outside, /out of bounds/u);
    assert.match(outside, /session cwd \/Users\/me\/w/u, "en 表照样回显允许区与解析结果");
    assert.match(outside, /built-in role library/u);
    assert.doesNotMatch(outside, hanPattern);
  });

  it("整理链路失败文案切英文（空草稿 / 缺模型 / 缺 finish / 非 stop 终态）", async () => {
    const llm = fakeLlm([]);
    await assert.rejects(
      () => runOrganizeWithDict(llm, { prompt: "   ", cwd: "/w" }, en),
      /request is empty/u,
    );
    await assert.rejects(
      () => runOrganizeWithDict(llm, { prompt: "x", cwd: "/w" }, en),
      /No model selection/u,
    );
    await assert.rejects(
      () => drainStreamToTextWithDict(streamOf([{ type: TEXT_DELTA, index: 0, text: "x" }]), en),
      /missing its finish chunk/u,
    );
    await assert.rejects(
      () =>
        drainStreamToTextWithDict(
          streamOf([
            {
              type: "finish",
              reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "provider 429" } },
            },
          ]),
          en,
        ),
      /did not finish refining \(error: provider 429\)/u,
    );
  });

  it("目录收集与角色导入的失败回执切英文", async () => {
    const emptyCwd = await collectDirContextWithDict(memFs({}), "", en);
    assert.match(emptyCwd.error ?? "", /cwd is empty/u);
    const broken = await collectDirContextWithDict(
      memFs({}, { resolveFails: new Error("ENOENT") }),
      "/w",
      en,
    );
    assert.match(broken.error ?? "", /Failed to read the directory: ENOENT/u);
    const nameless = await collectAgentTemplatesWithDict(
      memFs({ "/r/a.md": "正文没有 frontmatter" }),
      "/r/a.md",
      "/r",
      en,
    );
    assert.match(nameless.error ?? "", /no valid role definition/u);
    const failedImport = await collectAgentTemplatesWithDict(
      memFs({ "/r/a.md": "---\nname: A\n---\n正文" }, { listDirFails: new Error("EIO") }),
      "/r",
      "/r",
      en,
    );
    assert.match(failedImport.error ?? "", /Import failed: EIO/u);
  });
});
