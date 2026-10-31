import { createElement, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { mergeImportedTemplates, sanitizeAllowRoots, sanitizeTemplateList } from "./templates.ts";
import type { TemplateEntry } from "./templates.ts";
// 润色时限的取值与夹位（连同「为什么必须夹」的证据）单源在 client-timeouts.ts。
import { organizeFetchTimeoutMs, rawOrganizeTimeoutMsOf } from "./client-timeouts.ts";
// 注入样式表（纯数据，单源在 client-styles.ts；理由见那份文件头）。
import { CARD_STYLES } from "./client-styles.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate, UiMessages } from "./ui-messages.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { InputActions, InputState } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { errorText } from "@jayyuen66/dsh-plugin-shared/lib/errors";
import { CARD_UI_CSS, CardForm, SaveBar, Section } from "@jayyuen66/dsh-plugin-shared/lib/card-ui";
import { hasDraftFace, hasInsertFace, useWriteBack } from "./input-writeback.ts";
import { DIR_PREP_NAMESPACE, createDirPrepReader } from "./remote.ts";
import type { DirPrepReader } from "./remote.ts";

const NS: LocaleNs = "dir-prep-organize";
const BUNDLE_PKG = "@jayyuen66/dsh-dir-prep-organize";

const ERROR_FLASH_MS = 4000;
/** 非润色读面的等待上限。润色那一发有自己的超时（来自设置卡的 organizeTimeoutMs）。 */
const REMOTE_TIMEOUT_MS = 125_000;
const RESET_CONFIRM_MS = 4000;
const EMOJI_PLACEHOLDER = "😀";
const ROOT_PATH_PLACEHOLDER = "/Users/me/roles";

const CLASS_ITEM_EMPTY = "dpi-item-empty";
const CLASS_ROW_HEAD = "dpic-rowhead";
const CLASS_IMPORT_PATH = "dpic-importpath";
const SLOT_INPUT_RIGHT = "conversation.input.right";

// ── 读面载荷类型（与 host.ts 契约一致）────────────────────────────────────

export interface DirEntryView {
  name: string;
  isDir: boolean;
  sizeBytes: number;
  snippet?: string;
}

export interface ImportSkips {
  tooLarge: number;
  unreadable: number;
  deeper: number;
  unnamed: number;
  /** 真实目标落在允许根之外（符号链接）被排除的项数；旧 host 不回这一位时读作 0。 */
  escaped: number;
}

export interface ContextResponse {
  ok: boolean;
  error?: string;
  cwd?: string;
  truncated?: boolean;
  entries?: DirEntryView[];
}

export interface OrganizeResponse {
  ok: boolean;
  error?: string;
  content?: string;
}

interface ModelResponse {
  ok: boolean;
  error?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

interface ImportResponse {
  ok: boolean;
  error?: string;
  count?: number;
  truncated?: boolean;
  skipped?: ImportSkips;
  entries?: TemplateEntry[];
}

function parseDirEntry(raw: unknown): DirEntryView {
  const rec = isRecord(raw) ? raw : {};
  const { name, isDir, sizeBytes, snippet } = rec;
  return {
    name: typeof name === "string" ? name : "",
    isDir: isDir === true,
    sizeBytes: typeof sizeBytes === "number" ? sizeBytes : 0,
    ...(typeof snippet === "string" ? { snippet } : {}),
  };
}

/** 可选字符串位的窄化（`error`/`cwd`/`content` 等共用一条）。 */
function optionalString(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" ? value : undefined;
}

/** 有值才铺开成对象成员；无值时铺 `{}`，于是「缺席」与「显式 undefined」在形状上一致。
 *
 * 抽出来是因为四个解析器共 9 处同形展开，逐处写 `...(x === undefined ? {} : {k: x})`
 * 既占行又容易漏掉某一位（漏一位 = 那个字段被静默丢掉）。 */
function spreadIfDefined(value: string | undefined, key: string): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/** 跳过计数的展示顺序（文案与顺序都在这里定；formatImportSkips 只负责拼句子）。 */
function skipCountsOf(skips: ImportSkips): [keyof UiMessages, number][] {
  return [
    ["skipDeeper", skips.deeper],
    ["skipTooLarge", skips.tooLarge],
    ["skipUnreadable", skips.unreadable],
    ["skipUnnamed", skips.unnamed],
    ["skipEscaped", skips.escaped],
  ];
}

// 两个 wire 解析器导出给集成层（test/integration/roundtrip.test.ts）：它们判的是
// 「host 交来的 JSON 形状 → client 视图」这一整条边界，只有拿**真回执**喂进来才算验过，
// 在单元测试里用自造 body 喂它，等于让写解析器的人自己出考卷。
export function parseContextResponse(raw: unknown): ContextResponse {
  const rec = isRecord(raw) ? raw : {};
  const { ok, truncated, entries } = rec;
  const parsedEntries: DirEntryView[] | undefined = Array.isArray(entries)
    ? entries.map((entry) => parseDirEntry(entry))
    : undefined;
  return {
    ok: ok === true,
    ...spreadIfDefined(optionalString(rec, "error"), "error"),
    ...spreadIfDefined(optionalString(rec, "cwd"), "cwd"),
    ...(truncated === true ? { truncated: true } : {}),
    ...(parsedEntries === undefined ? {} : { entries: parsedEntries }),
  };
}

function parseModelResponse(raw: unknown): ModelResponse {
  const rec = isRecord(raw) ? raw : {};
  return {
    ok: rec["ok"] === true,
    ...spreadIfDefined(optionalString(rec, "error"), "error"),
    ...spreadIfDefined(optionalString(rec, "provider"), "provider"),
    ...spreadIfDefined(optionalString(rec, "model"), "model"),
    ...spreadIfDefined(optionalString(rec, "reasoningEffort"), "reasoningEffort"),
  };
}

export function parseOrganizeResponse(raw: unknown): OrganizeResponse {
  const rec = isRecord(raw) ? raw : {};
  return {
    ok: rec["ok"] === true,
    ...spreadIfDefined(optionalString(rec, "error"), "error"),
    ...spreadIfDefined(optionalString(rec, "content"), "content"),
  };
}

/** 计数位：非数字或非正一律 0（坏回执不该让界面显示 "NaN 个"）。 */
function countField(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

function parseImportSkips(rec: Record<string, unknown>): ImportSkips {
  return {
    tooLarge: countField(rec["tooLarge"]),
    unreadable: countField(rec["unreadable"]),
    deeper: countField(rec["deeper"]),
    unnamed: countField(rec["unnamed"]),
    escaped: countField(rec["escaped"]),
  };
}

/** 导入跳过计数 → 一句话（无计数时返回空串，调用方据此不追加任何文案）。 */
export function formatImportSkips(t: Translate, skips: ImportSkips | undefined): string {
  if (skips === undefined) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, count] of skipCountsOf(skips)) {
    if (count > 0) {
      parts.push(t(key, { count }));
    }
  }
  return parts.length === 0 ? "" : t("skipSummary", { list: parts.join(t("skipSeparator")) });
}

function parseImportResponse(raw: unknown): ImportResponse {
  const rec = isRecord(raw) ? raw : {};
  const { ok, error, count, truncated, skipped, entries } = rec;
  const parsedEntries: TemplateEntry[] | undefined = Array.isArray(entries)
    ? sanitizeTemplateList(entries)
    : undefined;
  return {
    ok: ok === true,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof count === "number" ? { count } : {}),
    ...(truncated === true ? { truncated: true } : {}),
    ...(isRecord(skipped) ? { skipped: parseImportSkips(skipped) } : {}),
    ...(parsedEntries === undefined ? {} : { entries: parsedEntries }),
  };
}

export function formatContextSummary(resp: ContextResponse): string {
  const entries = resp.entries ?? [];
  const lines: string[] = [`当前目录: ${resp.cwd ?? "(未提供)"}`];
  const files = entries.filter((entry) => !entry.isDir);
  const dirs = entries.filter((entry) => entry.isDir);
  lines.push(`文件 ${files.length} 个, 目录 ${dirs.length} 个`);
  if (resp.truncated === true) {
    lines.push("（以上条目按上限截断，目录树并未完整列出，勿据此判断文件不存在）");
  }
  for (const dir of dirs) {
    lines.push(`📁 ${dir.name}/`);
  }
  for (const file of files) {
    const size =
      file.sizeBytes > 1024 ? `${(file.sizeBytes / 1024).toFixed(1)}KB` : `${file.sizeBytes}B`;
    let line = `📄 ${file.name} (${size})`;
    if (file.snippet !== undefined && file.snippet.length > 0) {
      line += `   ↳ ${file.snippet.replaceAll("\n", " ")}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export type BuiltinPhase = "idle" | "loading" | "ready" | "error";

export interface BuiltinState {
  phase: BuiltinPhase;
  list: readonly TemplateEntry[];
  error: string;
}

const builtinInitial: BuiltinState = { phase: "idle", list: [], error: "" };

let builtinState: BuiltinState = builtinInitial;
let builtinInflight: Promise<BuiltinState> | null = null;
/**
 * 在飞 Promise 的世代。reset 之后新一代重新起跑，上一代晚到的结果不许再写进 store，
 * 否则用户点了「恢复默认」却拿回恢复前那次请求的快照。
 */
let builtinGeneration = 0;
const builtinListeners = new Set<() => void>();

function setBuiltinState(next: BuiltinState): BuiltinState {
  if (next === builtinState) {
    return builtinState;
  }
  builtinState = next;
  for (const listener of builtinListeners) {
    listener();
  }
  return next;
}

export function builtinTemplatesSnapshot(): BuiltinState {
  return builtinState;
}

let dirPrepReader: DirPrepReader | undefined;

/** 导出仅供单测：不经过 apply 的纯读面用例直接注入替身。 */
export function setDirPrepReader(reader: DirPrepReader | undefined): void {
  dirPrepReader = reader;
}

function requireReader(): DirPrepReader {
  if (dirPrepReader === undefined) {
    throw new Error(`远程读面不可用：宿主网关没有挂上 ${DIR_PREP_NAMESPACE}`);
  }
  return dirPrepReader;
}

/**
 * 润色链路里由客户端自己产生的错误：messageKey 指向 ui-messages 的键，捕获侧用当前
 * 语言的 t 渲染成 tooltip——把文案直接写进 Error.message 会让英文界面看到硬编码中文。
 * 宿主回执携带的原文（ctxRes.error / modelRes.error）不翻译，作为 {message} 原样带出。
 */
class LocalizedOrganizeError extends Error {
  public readonly messageKey: keyof UiMessages;
  public readonly params: Record<string, unknown>;

  public constructor(messageKey: keyof UiMessages, params: Record<string, unknown> = {}) {
    super(messageKey);
    this.name = "LocalizedOrganizeError";
    this.messageKey = messageKey;
    this.params = params;
  }
}
/** 客户端超时只影响等待：宿主侧的润色超时仍由它自己的 AbortController 收口。 */
async function within<Value>(pending: Promise<Value>, timeoutMs: number): Promise<Value> {
  const gate = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    // 走 LocalizedOrganizeError：界面按当前语言渲染，不再把中文硬编码漏进英文界面。
    gate.reject(new LocalizedOrganizeError("organizeErrTimeout"));
  }, timeoutMs);
  try {
    return await Promise.race([pending, gate.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadBuiltinTemplates(): Promise<BuiltinState> {
  if (builtinState.phase === "ready") {
    return builtinState;
  }
  if (builtinInflight !== null) {
    const inflightState = await builtinInflight;
    return inflightState;
  }
  const generation = builtinGeneration;
  builtinInflight = (async (): Promise<BuiltinState> => {
    setBuiltinState({ phase: "loading", list: builtinState.list, error: "" });
    let settled: BuiltinState;
    try {
      const body = await within(requireReader().defaults(), REMOTE_TIMEOUT_MS);
      const payload = isRecord(body) ? body : undefined;
      const okKey = "ok";
      const templatesKey = "templates";
      const errorKey = "error";
      const rawReason = payload?.[errorKey];
      settled =
        payload?.[okKey] === true
          ? { phase: "ready", list: sanitizeTemplateList(payload[templatesKey]), error: "" }
          : {
              phase: "error",
              list: [],
              error:
                typeof rawReason === "string" && rawReason.trim() !== ""
                  ? rawReason
                  : "内置模板响应不是合法载荷",
            };
    } catch (error) {
      settled = { phase: "error", list: [], error: errorText(error) };
    } finally {
      if (builtinGeneration === generation) {
        builtinInflight = null;
      }
    }
    // 世代被 reset 越过时，这一发的结果属于上一代：调用方拿得到它，但不许写进 store。
    return builtinGeneration === generation ? setBuiltinState(settled) : settled;
  })();
  const firstState = await builtinInflight;
  return firstState;
}

export function subscribeBuiltinTemplates(listener: () => void): () => void {
  builtinListeners.add(listener);
  return () => {
    builtinListeners.delete(listener);
  };
}

export function resetBuiltinTemplates(): void {
  // 同时在飞的那一发不再能落盘：世代 +1 之后它的 finally 与 setState 都被挡在门外。
  builtinGeneration += 1;
  builtinInflight = null;
  setBuiltinState(builtinInitial);
}

function builtinStatusRow(snap: TemplatesSnapshot, t: Translate): ReactNode | undefined {
  const attrs = { className: CLASS_ITEM_EMPTY, "data-field": "dpi-builtin-state" };
  const retryButton = createElement(
    "button",
    {
      type: "button",
      className: "dsu-btn",
      "data-field": "dpi-builtin-retry",
      onClick: () => {
        void loadBuiltinTemplates();
      },
    },
    t("builtinRetry"),
  );
  let row: ReactNode | undefined;
  if (!snap.fromSettings && snap.builtinPhase !== "ready") {
    row =
      snap.builtinPhase === "error"
        ? createElement(
            "div",
            attrs,
            t("builtinFailed", { message: snap.builtinError }),
            retryButton,
          )
        : createElement("div", attrs, t("builtinLoading"));
  }
  return row;
}

function assertOrganizeReady(
  ctxRes: ContextResponse,
  modelRes: ModelResponse,
  prompt: string,
  unknownReason: string,
): void {
  if (!ctxRes.ok) {
    throw new LocalizedOrganizeError("organizeErrContextFailed", {
      message: ctxRes.error ?? unknownReason,
    });
  }
  if (!modelRes.ok || modelRes.provider === undefined || modelRes.model === undefined) {
    throw new LocalizedOrganizeError("organizeErrModelFailed", {
      message: modelRes.error ?? unknownReason,
    });
  }
  if (prompt.trim().length === 0) {
    throw new LocalizedOrganizeError("organizeErrEmpty");
  }
}

async function requestOrganize(args: {
  ctxRes: ContextResponse;
  prompt: string;
  sessionId: string;
  roleText?: string | undefined;
  timeoutMs: number;
}): Promise<string> {
  const { ctxRes, prompt, sessionId, roleText, timeoutMs } = args;
  const entriesSummary = formatContextSummary(ctxRes);
  const organized = await within(
    requireReader().organize({
      sessionId,
      prompt,
      entriesSummary,
      ...(roleText === undefined ? {} : { roleText }),
    }),
    timeoutMs,
  );
  const orgRes = parseOrganizeResponse(organized);
  if (!orgRes.ok || orgRes.content === undefined) {
    throw orgRes.error === undefined
      ? new LocalizedOrganizeError("organizeErrUnknown")
      : new Error(orgRes.error);
  }
  return orgRes.content;
}

async function runOrganizeFlow(args: {
  prompt: string;
  sessionId: string;
  roleText?: string;
  timeoutMs: number;
  unknownReason: string;
}): Promise<string> {
  const reader = requireReader();
  const [ctxRaw, modelRaw] = await Promise.all([
    within(reader.context(args.sessionId), REMOTE_TIMEOUT_MS),
    within(reader.model(args.sessionId), REMOTE_TIMEOUT_MS),
  ]);
  const ctxRes = parseContextResponse(ctxRaw);
  const modelRes = parseModelResponse(modelRaw);
  assertOrganizeReady(ctxRes, modelRes, args.prompt, args.unknownReason);
  return requestOrganize({
    ctxRes,
    prompt: args.prompt,
    sessionId: args.sessionId,
    roleText: args.roleText,
    timeoutMs: args.timeoutMs,
  });
}

// ── 模板：配置表单契约与 store（读侧唯一入口）─────────────────────────────────

export type EntryForm = ConfigForm<Record<string, unknown>>;

type FormSnapshot = ConfigPageForm["state"];

export interface TemplatesSnapshot {
  templates: readonly TemplateEntry[];
  fromSettings: boolean;
  builtinPhase: BuiltinPhase;
  builtinError: string;
  allowRoots: readonly string[];
  ready: boolean;
  writable: boolean;
  organizeTimeoutMs: number | undefined;
}

export interface PersistedView {
  ready: boolean;
  revision: number;
  templates: readonly TemplateEntry[];
  allowRoots: readonly string[];
}

interface TemplatesStore {
  getSnapshot: () => TemplatesSnapshot;
  subscribe: (listener: () => void) => () => void;
  readBack: () => PersistedView;
}

function projectFormSnapshot(snap: FormSnapshot): {
  value: Record<string, unknown>;
  ready: boolean;
  writable: boolean;
  revision: number;
} {
  const { value, status, writable, revision } = snap;
  return {
    value: value ?? {},
    ready: status === "ready",
    writable,
    revision: revision ?? 0,
  };
}

function rawTemplatesOf(value: Record<string, unknown>): unknown {
  const templatesKey = "templates";
  return value[templatesKey];
}

function rawAllowRootsOf(value: Record<string, unknown>): unknown {
  const allowRootsKey = "importAllowRoots";
  return value[allowRootsKey];
}

function templatesStore(scope: EntryForm): TemplatesStore {
  let cachedRaw: FormSnapshot | null = null;
  let cachedBuiltin: BuiltinState = builtinState;
  let cachedView: TemplatesSnapshot = {
    templates: builtinInitial.list,
    fromSettings: false,
    builtinPhase: "idle",
    builtinError: "",
    allowRoots: [],
    ready: false,
    writable: false,
    organizeTimeoutMs: undefined,
  };
  return {
    getSnapshot() {
      const snap = scope.getSnapshot();
      if (snap === cachedRaw && builtinState === cachedBuiltin) {
        return cachedView;
      }
      cachedRaw = snap;
      cachedBuiltin = builtinState;
      const projected = projectFormSnapshot(snap);
      const rawTemplates = rawTemplatesOf(projected.value);
      const fromSettings = Array.isArray(rawTemplates) && rawTemplates.length > 0;
      cachedView = {
        templates: fromSettings ? sanitizeTemplateList(rawTemplates) : cachedBuiltin.list,
        fromSettings,
        builtinPhase: cachedBuiltin.phase,
        builtinError: cachedBuiltin.error,
        allowRoots: sanitizeAllowRoots(rawAllowRootsOf(projected.value)),
        ready: projected.ready,
        writable: projected.writable,
        organizeTimeoutMs: rawOrganizeTimeoutMsOf(projected.value),
      };
      return cachedView;
    },
    subscribe(listener) {
      const offForm = scope.subscribe(listener);
      const offBuiltin = subscribeBuiltinTemplates(listener);
      return () => {
        offForm();
        offBuiltin();
      };
    },
    readBack() {
      const projected = projectFormSnapshot(scope.getSnapshot());
      return {
        ready: projected.ready,
        revision: projected.revision,
        templates: sanitizeTemplateList(rawTemplatesOf(projected.value)),
        allowRoots: sanitizeAllowRoots(rawAllowRootsOf(projected.value)),
      };
    },
  };
}

export function persistError(
  t: Translate,
  persisted: Pick<PersistedView, "ready" | "revision" | "templates">,
  expected: readonly TemplateEntry[],
  action: string,
  opts?: { treatEmptyAsReverted?: boolean },
): string | undefined {
  let message: string | undefined;
  const revertedToBase =
    opts?.treatEmptyAsReverted === true && persisted.templates.length === 0 && expected.length > 0;
  if (!persisted.ready) {
    message = t("persistUnconfirmed", { action });
  } else if (!revertedToBase && JSON.stringify(persisted.templates) !== JSON.stringify(expected)) {
    message = t("persistRejected", { action, revision: persisted.revision });
  }
  return message;
}

export function rootsPersistError(
  t: Translate,
  persisted: Pick<PersistedView, "ready" | "revision" | "allowRoots">,
  expected: readonly string[],
  action: string,
): string | undefined {
  let message: string | undefined;
  if (!persisted.ready) {
    message = t("persistUnconfirmed", { action });
  } else if (JSON.stringify(persisted.allowRoots) !== JSON.stringify(expected)) {
    message = t("persistRejected", { action, revision: persisted.revision });
  }
  return message;
}

/** 菜单项文字：有 emoji 就前缀一个（emoji 是用户自填的视觉标记，空串 = 不显示）。 */
function templateItemLabel(tpl: TemplateEntry): string {
  return `${tpl.emoji === "" ? "" : `${tpl.emoji} `}${tpl.name}`;
}

/** 模板 → 按 group 收拢的分组（空 group 归入「通用」）。
 *
 * 分组表用 `Map` 而不是对象字面量：分组标签是用户可填的 `template.group`，
 * `__proto__` / `constructor` 这类标签作为对象键会落进原型链而不是成为一个分组
 * （Map 没有这条缝）。顺序 = 首次出现顺序，渲染稳定可测。 */
function groupTemplatesBy(
  templates: readonly TemplateEntry[],
  t: Translate,
): { group: string; items: TemplateEntry[] }[] {
  const buckets = new Map<string, TemplateEntry[]>();
  for (const tpl of templates) {
    const key = tpl.group.trim() === "" ? t("templatesGroupCommon") : tpl.group;
    const bucket = buckets.get(key) ?? [];
    bucket.push(tpl);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries(), ([group, items]) => ({ group, items }));
}

// ── 组件 props（框架注入的 standard kit 子集，形状全部取自官方声明）───────────

export interface KitProps {
  t: Translate;
  useCard: <TResult>(selector: (snap: TemplatesSnapshot) => TResult) => TResult;
  useInput?: <TResult>(
    selector: (state: Pick<InputState, "draft" | "draftRev" | "phase">) => TResult,
  ) => TResult;
  inputActions?: Pick<InputActions, "setDraft" | "captureInsertion" | "insertText">;
  sessionId?: string;
}

// ── 图标 ───────────────────────────────────────────────────────────────────
function svgPathProps(dValue: string, strokeLinejoin = false): Record<string, string | number> {
  const entries: [string, string | number][] = [
    ["d", dValue],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["strokeWidth", 1.5],
    ["strokeLinecap", "round"],
  ];
  if (strokeLinejoin) {
    entries.push(["strokeLinejoin", "round"]);
  }
  return Object.fromEntries(entries);
}

function svgSpinProps(): Record<string, string | number> {
  const entries: [string, string | number][] = [
    ["cx", 7],
    ["cy", 7],
    ["r", 5.5],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["strokeWidth", 1.5],
    ["strokeDasharray", "26 10"],
    ["strokeLinecap", "round"],
  ];
  return Object.fromEntries(entries);
}

function TidyIcon(): ReactNode {
  return createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true },
    createElement("path", svgPathProps("M2 4l5 4 5-4", true)),
    createElement("path", svgPathProps("M2 8.5l5 4 5-4", true)),
  );
}

function SpinIcon(): ReactNode {
  return createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, className: "dpi-spin" },
    createElement("circle", svgSpinProps()),
  );
}

function FailIcon(): ReactNode {
  return createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true },
    createElement("path", svgPathProps("M3 3l8 8M11 3l-8 8")),
  );
}

function TemplateIcon(): ReactNode {
  return createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true },
    createElement("path", svgPathProps("M2.5 3.5h9M2.5 7h9M2.5 10.5h5.5")),
  );
}

function CaretIcon(): ReactNode {
  return createElement(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true },
    createElement("path", svgPathProps("M2.5 5.5L7 9.5l4.5-4", true)),
  );
}

// ── 容器（槽 occupant，收 standard kit props）─────────────────────────────

function useMenuDismiss(
  open: boolean,
  wrapRef: RefObject<HTMLSpanElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    function onDown(event: MouseEvent): void {
      if (
        wrapRef.current !== null &&
        event.target instanceof Node &&
        !wrapRef.current.contains(event.target)
      ) {
        close();
      }
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    if (open) {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [close, open, wrapRef]);
}

type Setter<Value> = Dispatch<SetStateAction<Value>>;

type OrganizeRun = (roleText?: string) => Promise<void>;

interface OrganizeRunArgs {
  readonly t: Translate;
  readonly loading: boolean;
  /** 同步的在途标记：`loading` 要等一次重渲染才生效，同一轮事件里两次点击读到的都还是 false。 */
  readonly inFlight: RefObject<boolean>;
  readonly seq: RefObject<number>;
  readonly prompt: string;
  readonly sessionId: string;
  readonly timeoutMs: number;
  readonly roleText?: string | undefined;
  readonly setLoading: Setter<boolean>;
  readonly setMenuOpen: Setter<boolean>;
  readonly setFailed: Setter<string | undefined>;
  readonly flashTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  readonly writeDraft: (content: string) => void;
}

async function runOrganizeClick(args: OrganizeRunArgs): Promise<void> {
  const {
    t,
    loading,
    inFlight,
    seq,
    prompt,
    sessionId,
    timeoutMs,
    roleText,
    setLoading,
    setMenuOpen,
    setFailed,
    flashTimer,
    writeDraft,
  } = args;
  if (loading || inFlight.current) {
    return;
  }
  // 先置位再 await：`loading` 只是排了一次重渲染，同一轮事件里的第二次点击读到的仍是旧值，
  // 两道门都拦不住，于是第二发请求真的打到宿主——模型侧已经计费，而用户只看到一份结果。
  inFlight.current = true;
  seq.current += 1;
  const mySeq = seq.current;
  setLoading(true);
  setFailed(undefined);
  setMenuOpen(false);
  try {
    const content = await runOrganizeFlow({
      prompt,
      sessionId,
      ...(roleText === undefined ? {} : { roleText }),
      timeoutMs,
      unknownReason: t("organizeErrUnknownReason"),
    });
    if (seq.current !== mySeq) {
      return;
    }
    writeDraft(content);
  } catch (error) {
    if (seq.current !== mySeq) {
      return;
    }
    setFailed(
      error instanceof LocalizedOrganizeError
        ? t(error.messageKey, error.params)
        : errorText(error),
    );
    if (flashTimer.current !== null) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => {
      setFailed(undefined);
    }, ERROR_FLASH_MS);
  } finally {
    inFlight.current = false;
    if (seq.current === mySeq) {
      setLoading(false);
    }
  }
}

interface OrganizeUIView {
  t: Translate;
  errTitle: string;
  icon: ReactNode;
  label: string;
  state: string;
  errClass: string;
  directItemLabel: string;
  noTemplatesLabel: string;
  builtinRow: ReactNode | undefined;
  loading: boolean;
  menuOpen: boolean;
  /** 宿主是否给了「把润色结果写回输入框」的手段（inputActions.setDraft）。 */
  canWrite: boolean;
  templates: readonly TemplateEntry[];
  onRun: OrganizeRun;
  onToggleMenu: () => void;
}

/** 润色结果无处可写时的主按钮 title（与模板项那一档同一句话，同一套判据）。 */
const NO_WRITE_BACK_TITLE_KEY = "organizeWriteBackUnavailable";

function createOrganizeMainButton(ui: OrganizeUIView): ReactNode {
  const { t, icon, label, state, errClass, errTitle, loading, canWrite, onRun } = ui;
  return createElement(
    "button",
    {
      type: "button",
      className: `dpi-btn dpi-main${errClass}`,
      "aria-label": t("organizeMainAria"),
      title: errTitle,
      "data-field": "dpi-organize-btn",
      "data-state": state,
      // canWrite 与「模板」下拉项同口径（client-entry.ts 的 TemplateButton）：润色结果
      // 最终要写回输入框，写不回时整次调用就是纯浪费——一次真实的 LLM 请求 + 一份真实
      // 账单，换来一句错误文案。失败在写回那一步才抛（writeDraft），所以这道门只能
      // 在发请求**之前**判断，否则钱已经花完了。
      disabled: loading || !canWrite,
      onClick: () => {
        void onRun();
      },
    },
    icon,
    label,
  );
}

function createOrganizeCaret(ui: OrganizeUIView): ReactNode {
  const { t, errClass, menuOpen, loading, onToggleMenu } = ui;
  return createElement(
    "button",
    {
      type: "button",
      className: `dpi-btn dpi-caret${errClass}`,
      "aria-label": t("organizeCaretAria"),
      "aria-haspopup": "menu",
      "aria-expanded": menuOpen,
      title: t("organizeCaretTitle"),
      "data-field": "dpi-organize-caret",
      "data-state": menuOpen ? "open" : "idle",
      disabled: loading,
      onClick: onToggleMenu,
    },
    createElement(CaretIcon),
  );
}

function createOrganizeRoleMenu(ui: OrganizeUIView): ReactNode {
  const {
    t,
    templates,
    onRun,
    directItemLabel,
    noTemplatesLabel,
    builtinRow,
    loading,
    canWrite,
    errTitle,
  } = ui;
  // 菜单项与主按钮同一道门：写不回时一次真实 LLM 往返换来的结果无处落地，只能等到 writeDraft 才抛错。
  // 主按钮与 caret 早就按 loading 挡住了，菜单项漏了同一条判据——从 caret 展开后照样能点。
  const blocked = loading || !canWrite;
  const blockedTitle = canWrite ? undefined : errTitle;
  return createElement(
    "div",
    { className: "dpi-menu", role: "menu", "data-field": "dpi-organize-menu" },
    createElement(
      "button",
      {
        type: "button",
        className: "dpi-item",
        role: "menuitem",
        "data-field": "dpi-organize-role-direct",
        disabled: blocked,
        ...(blockedTitle === undefined ? {} : { title: blockedTitle }),
        onClick: () => {
          void onRun();
        },
      },
      directItemLabel,
    ),
    templates.length === 0
      ? (builtinRow ?? createElement("div", { className: CLASS_ITEM_EMPTY }, noTemplatesLabel))
      : templates.map((tpl) =>
          createElement(
            "button",
            {
              key: tpl.id,
              type: "button",
              className: "dpi-item",
              role: "menuitem",
              "data-field": "dpi-organize-role-item",
              disabled: blocked,
              title: blockedTitle ?? (tpl.description === "" ? tpl.text : tpl.description),
              onClick: () => {
                void onRun(tpl.text);
              },
            },
            `${tpl.emoji === "" ? "" : `${tpl.emoji} `}${t("organizeRoleItem", { name: tpl.name })}`,
          ),
        ),
  );
}

interface OrganizeBadge {
  readonly icon: ReactNode;
  readonly label: string;
  readonly state: string;
}

/** 主键的三态外观：失败 > 在途 > 空闲（三者互斥，按同一优先级判）。 */
function organizeBadge(failed: string | undefined, loading: boolean, t: Translate): OrganizeBadge {
  if (failed !== undefined) {
    return { icon: createElement(FailIcon), label: t("organizeFailedShort"), state: "error" };
  }
  if (loading) {
    return { icon: createElement(SpinIcon), label: t("organizeLoading"), state: "loading" };
  }
  return { icon: createElement(TidyIcon), label: t("organizeIdle"), state: "idle" };
}

function createOrganizeButton(): (props: KitProps) => ReactNode {
  return function OrganizeButton(props: KitProps): ReactNode {
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState<string | undefined>(undefined);
    const [menuOpen, setMenuOpen] = useState(false);
    const seq = useRef(0);
    const inFlight = useRef(false);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wrapRef = useRef<HTMLSpanElement | null>(null);

    const draft: string =
      props.useInput === undefined
        ? ""
        : (props.useInput((state): string | undefined => state.draft) ?? "");
    const draftRev: number =
      props.useInput === undefined ? 0 : props.useInput((state) => state.draftRev);
    const phase: InputState["phase"] =
      props.useInput === undefined ? "plain" : props.useInput((state) => state.phase);
    const snap = props.useCard((state) => state);
    const { templates } = snap;
    const writeBack = useWriteBack(
      { sessionId: props.sessionId ?? "", actions: props.inputActions, draftRev, phase },
      { unavailable: props.t(NO_WRITE_BACK_TITLE_KEY), stale: props.t("organizeWriteBackStale") },
    );

    useMenuDismiss(menuOpen, wrapRef, () => {
      setMenuOpen(false);
    });

    useEffect(
      () => () => {
        seq.current += 1;
        if (flashTimer.current !== null) {
          clearTimeout(flashTimer.current);
        }
      },
      [],
    );

    async function handleOrganize(roleText?: string): Promise<void> {
      const ticket = writeBack.begin();
      try {
        await runOrganizeClick({
          t: props.t,
          loading,
          inFlight,
          seq,
          prompt: draft,
          sessionId: props.sessionId ?? "",
          timeoutMs: organizeFetchTimeoutMs(snap.organizeTimeoutMs),
          roleText,
          setLoading,
          setMenuOpen,
          setFailed,
          flashTimer,
          writeDraft: (content: string): void => {
            writeBack.commit(content, ticket);
          },
        });
      } finally {
        writeBack.finish(ticket);
      }
    }

    function openMenu(): void {
      if (!snap.fromSettings) {
        void loadBuiltinTemplates();
      }
      setMenuOpen((prev) => !prev);
    }

    const badge = organizeBadge(failed, loading, props.t);
    const replaceable = hasDraftFace(props.inputActions);
    // 提交期（adjudicating/claimed/submitting/sending）编辑面是只读的，此刻发起的润色即使
    // 返回也无处可写；把不可写推回发起之前，省下一次真实的 LLM 往返。
    // sessionId 缺席不是禁用理由：宿主侧 context/model 的 sessionId 都是可空位
    // （host.ts 的 cwdOf/liveModelOf 对 null 走缺省分支），无会话时照样能润色。
    const canWrite = replaceable && phase === "plain";
    let errTitle = props.t("organizeIdleTitle");
    if (failed !== undefined) {
      errTitle = props.t("organizeFailedTitle", { message: failed });
    } else if (!replaceable) {
      // 写不回时 title 直接说明原因（idle 档那句太泛，用户看不出该做什么）。
      errTitle = props.t(NO_WRITE_BACK_TITLE_KEY);
    } else if (phase !== "plain") {
      errTitle = props.t("organizeBusyTitle");
    }
    const ui: OrganizeUIView = {
      t: props.t,
      errTitle,
      icon: badge.icon,
      label: badge.label,
      state: badge.state,
      errClass: failed === undefined ? "" : " dpi-btn-err",
      directItemLabel: props.t("organizeDirectItem"),
      noTemplatesLabel: props.t("organizeNoTemplates"),
      builtinRow: builtinStatusRow(snap, props.t),
      loading,
      menuOpen,
      canWrite,
      templates,
      onRun: handleOrganize,
      onToggleMenu: openMenu,
    };
    return createElement(
      "span",
      { className: "dpi-wrap dpi-split", ref: wrapRef },
      createOrganizeMainButton(ui),
      createOrganizeCaret(ui),
      menuOpen ? createOrganizeRoleMenu(ui) : null,
    );
  };
}

function createTemplateButton(): (props: KitProps) => ReactNode {
  return function TemplateButton(props: KitProps): ReactNode {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLSpanElement | null>(null);
    const phase: InputState["phase"] =
      props.useInput === undefined ? "plain" : props.useInput((state) => state.phase);
    const snap = props.useCard((state) => state);
    const { templates } = snap;

    useMenuDismiss(open, wrapRef, () => {
      setOpen(false);
    });

    function pick(text: string): void {
      setOpen(false);
      const actions = props.inputActions;
      if (!hasInsertFace(actions)) {
        return;
      }
      // 插入语义，不是整稿替换：宿主按发起的选区做版本校验，稿里的引用块与附件都留着；
      // 它在提交期或草稿已变时交回 false，这里不回落 setDraft（那会丢掉引用块）。
      actions.insertText(text, actions.captureInsertion());
    }

    const insertable = hasInsertFace(props.inputActions);
    const canWrite = insertable && phase === "plain";
    let title = props.t("templatesBrokenTitle");
    if (canWrite) {
      title = props.t("templatesIdleTitle");
    } else if (insertable) {
      title = props.t("templatesBusyTitle");
    }

    // 分组用 Map 而不是对象字面量：分组标签来自用户可填的 template.group，`__proto__`
    // 之类作为对象键会落进原型而不是成为一个分组（Map 无此问题）。
    const grouped = groupTemplatesBy(templates, props.t);
    const emptyHintLabel = props.t("templatesEmptyHint");
    const builtinRow = builtinStatusRow(snap, props.t);

    return createElement(
      "span",
      { className: "dpi-wrap", ref: wrapRef },
      createElement(
        "button",
        {
          type: "button",
          className: "dpi-btn",
          "aria-label": props.t("templatesAria"),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          title,
          "data-field": "dpi-template-btn",
          "data-state": open ? "open" : "idle",
          disabled: !canWrite,
          onClick: () => {
            if (!snap.fromSettings) {
              void loadBuiltinTemplates();
            }
            setOpen((prev) => !prev);
          },
        },
        createElement(TemplateIcon),
        props.t("dockTemplatesEntry"),
      ),
      open
        ? createElement(
            "div",
            { className: "dpi-menu", role: "menu", "data-field": "dpi-template-menu" },
            templates.length === 0
              ? (builtinRow ??
                  createElement("div", { className: CLASS_ITEM_EMPTY }, emptyHintLabel))
              : grouped.map((slot) =>
                  createElement(
                    "div",
                    { key: slot.group, className: "dpi-group" },
                    createElement(
                      "div",
                      { className: "dpi-grouph", role: "presentation" },
                      slot.group,
                    ),
                    slot.items.map((tpl) =>
                      createElement(
                        "button",
                        {
                          key: tpl.id,
                          type: "button",
                          className: "dpi-item",
                          role: "menuitem",
                          "data-field": "dpi-template-item",
                          title: tpl.description === "" ? tpl.text : tpl.description,
                          onClick: () => {
                            pick(tpl.text);
                          },
                        },
                        templateItemLabel(tpl),
                      ),
                    ),
                  ),
                ),
          )
        : null,
    );
  };
}

// ── 设置页「角色库」卡（shared 卡片骨架）────────────────────────

interface TemplatesCardProps {
  t: Translate;
  useCard: <TResult>(selector: (snap: TemplatesSnapshot) => TResult) => TResult;
  set: (field: string, value: unknown) => Promise<boolean>;
  unset: (field: string) => Promise<boolean>;
  readBack: () => PersistedView;
}

function newTemplateId(): string {
  let id: string;
  try {
    id = `tpl-${crypto.randomUUID()}`;
  } catch {
    id = `tpl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
  return id;
}

type TemplateRowFields = Pick<TemplateEntry, "name" | "emoji" | "group" | "description" | "text">;

interface TemplateRowView {
  readonly t: Translate;
  readonly rowNum: string;
  readonly disabled: boolean;
  readonly templateId: string;
  readonly values: TemplateRowFields;
  readonly setters: { readonly [RowKey in keyof TemplateRowFields]: (value: string) => void };
  readonly onBlur: () => void;
  readonly onDelete: (id: string) => void;
}

function createTemplateRowElement(view: TemplateRowView): ReactNode {
  const { t, rowNum, disabled, values, setters } = view;
  const indexMark = createElement("span", { className: "dpic-idx" }, `#${rowNum}`);
  const emojiInput = createElement("input", {
    type: "text",
    className: "dpic-emoji dsu-input",
    value: values.emoji,
    placeholder: EMOJI_PLACEHOLDER,
    disabled,
    "aria-label": t("rowAriaEmoji", { index: rowNum }),
    title: t("rowEmojiTitle"),
    onChange: (event: { target: { value: string } }) => {
      setters.emoji(event.target.value);
    },
    onBlur: view.onBlur,
  });
  const nameInput = createElement("input", {
    type: "text",
    className: "dpic-name dsu-input",
    value: values.name,
    placeholder: t("rowPlaceholderName"),
    disabled,
    "aria-label": t("rowAriaName", { index: rowNum }),
    onChange: (event: { target: { value: string } }) => {
      setters.name(event.target.value);
    },
    onBlur: view.onBlur,
  });
  const groupInput = createElement("input", {
    type: "text",
    className: "dpic-group dsu-input",
    value: values.group,
    placeholder: t("rowPlaceholderGroup"),
    disabled,
    "aria-label": t("rowAriaGroup", { index: rowNum }),
    title: t("rowGroupTitle"),
    onChange: (event: { target: { value: string } }) => {
      setters.group(event.target.value);
    },
    onBlur: view.onBlur,
  });
  const deleteButton = createElement(
    "button",
    {
      type: "button",
      className: "dpic-del dsu-btn dsu-btnDanger",
      disabled,
      title: t("rowDeleteTitle"),
      onClick: () => {
        view.onDelete(view.templateId);
      },
    },
    t("rowDelete"),
  );
  const descriptionInput = createElement("input", {
    type: "text",
    className: "dpic-desc dsu-input",
    value: values.description,
    placeholder: t("rowPlaceholderDescription"),
    disabled,
    "aria-label": t("rowAriaDescription", { index: rowNum }),
    onChange: (event: { target: { value: string } }) => {
      setters.description(event.target.value);
    },
    onBlur: view.onBlur,
  });
  const textArea = createElement("textarea", {
    className: "dpic-text dsu-input dsu-textarea dsu-mono",
    value: values.text,
    rows: 6,
    placeholder: t("rowPlaceholderText"),
    disabled,
    "aria-label": t("rowAriaText", { index: rowNum }),
    onChange: (event: { target: { value: string } }) => {
      setters.text(event.target.value);
    },
    onBlur: view.onBlur,
  });
  return createElement(
    "div",
    { className: "dpic-row" },
    createElement(
      "div",
      { className: CLASS_ROW_HEAD },
      indexMark,
      emojiInput,
      nameInput,
      groupInput,
      deleteButton,
    ),
    descriptionInput,
    textArea,
  );
}

function TemplateRow(props: {
  t: Translate;
  index: number;
  template: TemplateEntry;
  disabled: boolean;
  onCommit: (id: string, fields: TemplateRowFields) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  const { t } = props;
  const [name, setName] = useState(props.template.name);
  const [emoji, setEmoji] = useState(props.template.emoji);
  const [group, setGroup] = useState(props.template.group);
  const [description, setDescription] = useState(props.template.description);
  const [text, setText] = useState(props.template.text);
  const rowNum = String(props.index + 1);
  useEffect(() => {
    setName(props.template.name);
    setEmoji(props.template.emoji);
    setGroup(props.template.group);
    setDescription(props.template.description);
    setText(props.template.text);
  }, [
    props.template.id,
    props.template.name,
    props.template.emoji,
    props.template.group,
    props.template.description,
    props.template.text,
  ]);

  function commit(): void {
    const nextName = name.trim();
    const nextText = text.trim();
    if (nextName === "" || nextText === "") {
      // 名称/正文是模板的必填项：保存时 sanitizeTemplateList 会把它整条丢掉，所以这一档
      // 不产生草稿变更（也不回滚本地输入——回滚会让该行重新变成「可保存」，把用户刚清空的
      // 必填项又悄悄塞回草稿里；这条由 client.test.ts 的「清空名称/正文的失焦…」钉住）。
      return;
    }
    const nextEmoji = emoji.trim();
    const nextGroup = group.trim();
    const nextDescription = description.trim();
    if (
      nextName === props.template.name &&
      nextEmoji === props.template.emoji &&
      nextGroup === props.template.group &&
      nextDescription === props.template.description &&
      nextText === props.template.text
    ) {
      return;
    }
    props.onCommit(props.template.id, {
      name: nextName,
      emoji: nextEmoji,
      group: nextGroup,
      description: nextDescription,
      text: nextText,
    });
  }

  return createTemplateRowElement({
    t,
    rowNum,
    disabled: props.disabled,
    templateId: props.template.id,
    values: { name, emoji, group, description, text },
    setters: {
      name: setName,
      emoji: setEmoji,
      group: setGroup,
      text: setText,
      description: setDescription,
    },
    onBlur: commit,
    onDelete: props.onDelete,
  });
}

function ImportPanel(props: {
  t: Translate;
  editable: boolean;
  onImported: (incoming: readonly TemplateEntry[]) => void;
}): ReactNode {
  const { t } = props;
  const [importPath, setImportPath] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [importError, setImportError] = useState("");

  async function onImport(): Promise<void> {
    if (importBusy) {
      return;
    }
    const target = importPath.trim();
    setImportBusy(true);
    setImportError("");
    setImportMsg("");
    try {
      const resp = parseImportResponse(
        await within(
          requireReader().importTemplates({ path: target, sessionId: "" }),
          REMOTE_TIMEOUT_MS,
        ),
      );
      if (!resp.ok || resp.entries === undefined) {
        throw new Error(resp.error ?? t("importFailedUnknown"));
      }
      const usable = resp.entries.length;
      // 回执里的 count 只当上限参考：坏值（NaN/负数/0）一律回落到真实条目数，
      // 否则界面会显示 "NaN 条" 或负条数，而条目其实已经导入了。
      const declared = countField(resp.count);
      const count = declared === 0 ? usable : Math.min(declared, usable);
      if (count === 0) {
        setImportError(t("importEmpty"));
        return;
      }
      props.onImported(resp.entries);
      setImportPath("");
      const truncatedNote = resp.truncated === true ? t("importTruncated") : "";
      const skipNote = `${formatImportSkips(t, resp.skipped)}${truncatedNote}`;
      setImportMsg(
        target.length === 0
          ? t("importAllDone", { count, skips: skipNote })
          : t("importFromDone", { path: target, count, skips: skipNote }),
      );
    } catch (error) {
      setImportError(errorText(error));
    } finally {
      setImportBusy(false);
    }
  }

  const canImport = props.editable && !importBusy;
  const importPathInput = createElement("input", {
    type: "text",
    className: `${CLASS_IMPORT_PATH} dsu-input`,
    value: importPath,
    placeholder: t("importPlaceholder"),
    disabled: !canImport,
    "aria-label": t("importAriaPath"),
    onChange: (event: { target: { value: string } }) => {
      setImportPath(event.target.value);
    },
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Enter") {
        void onImport();
      }
    },
  });
  const importBtn = createElement(
    "button",
    {
      type: "button",
      className: "dsu-btn",
      disabled: !canImport,
      title: t("importBtnTitle"),
      onClick: onImport,
    },
    importBusy ? t("importing") : t("importRoles"),
  );
  const importMsgEl =
    importMsg === "" ? null : createElement("div", { className: "dpic-hint" }, importMsg);
  const importErrorEl =
    importError === ""
      ? null
      : createElement(
          "div",
          { className: "dpic-hint dpic-err" },
          `${t("importErrorPrefix")}${importError}`,
        );
  const importHintEl = createElement("div", { className: "dpic-hint" }, t("importHint"));
  return createElement(
    "div",
    { className: "dpic-importrow" },
    createElement("div", { className: CLASS_ROW_HEAD }, importPathInput, importBtn),
    importMsgEl,
    importErrorEl,
    importHintEl,
  );
}

function AllowRootsPanel(props: {
  t: Translate;
  roots: readonly string[];
  disabled: boolean;
  onChangeRoot: (index: number, value: string) => void;
  onDeleteRoot: (index: number) => void;
  onAddRoot: (value: string) => void;
}): ReactNode {
  const { t } = props;
  const [pending, setPending] = useState("");
  const canAdd = !props.disabled && pending.trim().length > 0;
  const rowTitle = t("rootsRowTitle");
  const removeTitle = t("rootsRemoveTitle");
  const removeLabel = t("rootsRemove");
  const rows = props.roots.map((root, index) => {
    // 行内元素先建成变量：t() 嵌进 map + 三层 createElement 会超 max-nested-calls。
    const rowAria = t("rootsAriaRow", { index: index + 1 });
    const rowInput = createElement("input", {
      type: "text",
      className: `${CLASS_IMPORT_PATH} dsu-input`,
      value: root,
      placeholder: ROOT_PATH_PLACEHOLDER,
      disabled: props.disabled,
      "aria-label": rowAria,
      title: rowTitle,
      onChange: (event: { target: { value: string } }) => {
        props.onChangeRoot(index, event.target.value);
      },
    });
    const rowButton = createElement(
      "button",
      {
        type: "button",
        className: "dpic-del dsu-btn dsu-btnDanger",
        disabled: props.disabled,
        title: removeTitle,
        onClick: () => {
          props.onDeleteRoot(index);
        },
      },
      removeLabel,
    );
    return createElement(
      "div",
      { className: CLASS_ROW_HEAD, key: `allow-root-${String(index)}` },
      rowInput,
      rowButton,
    );
  });
  const addPlaceholder = t("rootsAddPlaceholder");
  const addAria = t("rootsAddAria");
  const addTitle = t("rootsAddTitle");
  const addLabel = t("rootsAdd");
  const addInput = createElement("input", {
    type: "text",
    className: `${CLASS_IMPORT_PATH} dsu-input`,
    value: pending,
    placeholder: addPlaceholder,
    disabled: props.disabled,
    "aria-label": addAria,
    onChange: (event: { target: { value: string } }) => {
      setPending(event.target.value);
    },
    onKeyDown: (event: { key: string }) => {
      if (event.key === "Enter" && canAdd) {
        props.onAddRoot(pending.trim());
        setPending("");
      }
    },
  });
  const addButton = createElement(
    "button",
    {
      type: "button",
      className: "dsu-btn",
      disabled: !canAdd,
      title: addTitle,
      onClick: () => {
        props.onAddRoot(pending.trim());
        setPending("");
      },
    },
    addLabel,
  );
  const addRow = createElement("div", { className: CLASS_ROW_HEAD }, addInput, addButton);
  return createElement(
    "div",
    { className: "dpic-importrow", "data-field": "allow-roots" },
    createElement("div", { className: "dpic-hint" }, t("rootsHeading")),
    rows,
    addRow,
    createElement("div", { className: "dpic-hint" }, t("rootsHint")),
  );
}

interface CardFootLabels {
  add: string;
  save: string;
  saving: string;
  revert: string;
  reset: string;
  resetConfirm: string;
  saveTitleDirty: string;
  saveTitleClean: string;
  resetTitle: string;
}

/** 工具条：新增角色与恢复默认（保存/撤销交给卡片底部统一的 SaveBar）。 */
function CardToolbar(props: {
  foot: CardFootLabels;
  editable: boolean;
  busy: boolean;
  confirmReset: boolean;
  onAdd: () => void;
  onReset: () => void;
}): ReactNode {
  const { foot, editable, busy, confirmReset } = props;
  return createElement(
    "div",
    { className: "dpic-toolbar" },
    createElement(
      "button",
      { type: "button", className: "dsu-btn", disabled: !editable, onClick: props.onAdd },
      foot.add,
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dsu-btn dsu-btnDanger",
        // busy 门禁与保存/撤销同口径：两者写的是同一份表单（reset 走 unset、保存走
        // set），不挡住就能并发，于是 unset 与 set 落到同一字段上，最后写入者赢——
        // 而「恢复默认」是两步确认里的一步，用户极易在保存途中才想起来要点它。
        disabled: !editable || busy,
        title: foot.resetTitle,
        onClick: props.onReset,
      },
      confirmReset ? foot.resetConfirm : foot.reset,
    ),
  );
}

function cardFootLabels(t: Translate): CardFootLabels {
  return {
    add: t("addTemplate"),
    save: t("save"),
    saving: t("saving"),
    revert: t("revert"),
    reset: t("resetDefault"),
    resetConfirm: t("resetConfirm", { seconds: RESET_CONFIRM_MS / 1000 }),
    saveTitleDirty: t("saveTitleDirty"),
    saveTitleClean: t("saveTitleClean"),
    resetTitle: t("resetTitle"),
  };
}

function cardStatusHint(snap: TemplatesSnapshot, t: Translate): string {
  let hint: string;
  if (snap.ready) {
    hint = snap.writable ? "" : t("statusReadOnly");
  } else {
    hint = t("statusNotReady");
  }
  return hint;
}

interface DraftActions {
  onCommit: (id: string, fields: TemplateRowFields) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onImported: (incoming: readonly TemplateEntry[]) => void;
  onRootChange: (index: number, value: string) => void;
  onRootDelete: (index: number) => void;
  onRootAdd: (value: string) => void;
}

function createDraftActions(
  t: Translate,
  draft: readonly TemplateEntry[],
  rootsDraft: readonly string[],
  setDraft: Setter<readonly TemplateEntry[]>,
  setRootsDraft: Setter<readonly string[]>,
): DraftActions {
  function onCommit(id: string, fields: TemplateRowFields): void {
    setDraft(draft.map((tpl) => (tpl.id === id ? { ...tpl, ...fields } : tpl)));
  }
  function onDelete(id: string): void {
    setDraft(draft.filter((tpl) => tpl.id !== id));
  }
  function onAdd(): void {
    setDraft([
      ...draft,
      {
        id: newTemplateId(),
        name: t("newTemplateName", { index: draft.length + 1 }),
        description: "",
        // 正文留空：占位提示由 textarea 的 placeholder（rowPlaceholderText）承担。
        // 默认提示语当正文会随保存落盘——sanitize 只剔除空正文，拦不住"正文是提示语"。
        text: "",
        group: "",
        emoji: "",
      },
    ]);
  }
  function onImported(incoming: readonly TemplateEntry[]): void {
    // 必须走**函数式**更新：`onImport` 要先 await 一整个网络往返（内置角色库整棵树的
    // 文件是秒级），回来时上面这个 `draft` 早已是点击那一刻的旧值。闭包直接用它，
    // 用户在这段时间里改的行 / 加的行 / 删的行会被整份旧草稿静默覆盖（实测：在途期间
    // 新增的一行被吃掉，界面还回显成导入结果的样子）。函数式更新把合并的基准换成
    // React 那一刻的最新值，id 去重也随之按真实已占用的 id 进行。
    setDraft((prev) => mergeImportedTemplates(prev, incoming));
  }
  function onRootChange(index: number, value: string): void {
    setRootsDraft(rootsDraft.map((root, idx) => (idx === index ? value : root)));
  }
  function onRootDelete(index: number): void {
    setRootsDraft(rootsDraft.filter((_root, idx) => idx !== index));
  }
  function onRootAdd(value: string): void {
    setRootsDraft([...rootsDraft, value]);
  }
  return { onCommit, onDelete, onAdd, onImported, onRootChange, onRootDelete, onRootAdd };
}

function verifyTemplatesPersisted(
  t: Translate,
  persisted: PersistedView,
  expected: readonly TemplateEntry[],
  action: keyof UiMessages,
  opts?: { treatEmptyAsReverted?: boolean },
): void {
  const problem = persistError(t, persisted, expected, t(action), opts);
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

function verifyRootsPersisted(
  t: Translate,
  persisted: PersistedView,
  expected: readonly string[],
): void {
  const problem = rootsPersistError(t, persisted, expected, t("save"));
  if (problem !== undefined) {
    throw new Error(problem);
  }
}

interface PersistActionsArgs {
  readonly t: Translate;
  readonly editable: boolean;
  readonly dirty: boolean;
  readonly rootsDirty: boolean;
  readonly anythingDirty: boolean;
  readonly confirmReset: boolean;
  readonly templates: readonly TemplateEntry[];
  readonly allowRoots: readonly string[];
  readonly draft: readonly TemplateEntry[];
  readonly rootsDraft: readonly string[];
  readonly set: (field: string, value: unknown) => Promise<boolean>;
  readonly unset: (field: string) => Promise<boolean>;
  readonly readBack: () => PersistedView;
  readonly setDraft: Setter<readonly TemplateEntry[]>;
  readonly setDraftFor: Setter<unknown>;
  readonly setRootsDraft: Setter<readonly string[]>;
  readonly setBusy: Setter<boolean>;
  readonly setSaveError: Setter<string>;
  readonly setConfirmReset: Setter<boolean>;
}

interface PersistActions {
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onReset: () => void;
}

function createPersistActions(args: PersistActionsArgs): PersistActions {
  const {
    t,
    editable,
    dirty,
    rootsDirty,
    anythingDirty,
    confirmReset,
    templates,
    allowRoots,
    draft,
    rootsDraft,
    set,
    unset,
    readBack,
    setDraft,
    setDraftFor,
    setRootsDraft,
    setBusy,
    setSaveError,
    setConfirmReset,
  } = args;
  function reportError(err: unknown): void {
    console.error("[dir-prep-organize] templates settings write failed:", err);
    setSaveError(errorText(err));
  }
  async function onSave(): Promise<void> {
    if (!editable || !anythingDirty) {
      return;
    }
    setBusy(true);
    setSaveError("");
    const next = sanitizeTemplateList(draft);
    const nextRoots = sanitizeAllowRoots(rootsDraft);
    try {
      if (dirty) {
        await set("templates", next);
        verifyTemplatesPersisted(t, readBack(), next, "save");
      }
      if (rootsDirty) {
        await set("importAllowRoots", nextRoots);
        verifyRootsPersisted(t, readBack(), nextRoots);
      }
      setBusy(false);
      // 保存往返期间用户可能又导入/编辑了表单：只有草稿仍是发起保存时那一份才写回
      // 清洗结果，否则保留用户这期间的新输入（服务端存的仍是刚写的那一份，下次保存再对齐）。
      setDraft((prev) => (prev === draft ? next : prev));
      setRootsDraft((prev) => (prev === rootsDraft ? nextRoots : prev));
    } catch (error) {
      setBusy(false);
      reportError(error);
    }
  }
  function onDiscard(): void {
    setDraft(templates);
    setRootsDraft(allowRoots);
    setSaveError("");
  }
  function onReset(): void {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    // 撤销与保存写的是同一份表单（reset 走 unset、保存走 set），而 CardFootBar 的 busy 门禁
    // 就是为了不让这两条路并发：不置 busy 时，用户在 reset 的一次往返途中仍能点保存，
    // 于是 unset 与 set 落到同一字段上，最后写入者赢。这里与 onSave 用同一对 setBusy。
    setBusy(true);
    void (async () => {
      try {
        const builtin = await loadBuiltinTemplates();
        if (builtin.phase !== "ready") {
          throw new Error(builtin.error);
        }
        await unset("templates");
        verifyTemplatesPersisted(t, readBack(), builtin.list, "resetDefault", {
          treatEmptyAsReverted: true,
        });
        setSaveError("");
        setDraft(builtin.list);
        setDraftFor(builtin.list);
        setRootsDraft(allowRoots);
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    })();
  }
  return { onSave, onDiscard, onReset };
}

/** 展开态正文的输入：两份草稿、卡底状态与两张动作表（动作在此一次展开成 props）。 */
interface CardBodyView {
  readonly t: Translate;
  readonly statusHint: string;
  readonly draft: readonly TemplateEntry[];
  readonly rootsDraft: readonly string[];
  readonly foot: CardFootLabels;
  readonly editable: boolean;
  readonly anythingDirty: boolean;
  readonly busy: boolean;
  readonly confirmReset: boolean;
  readonly saveError: string;
  readonly draftActions: DraftActions;
  readonly persistActions: PersistActions;
}

/** 卡片正文：状态提示 + 工具条 + 角色行表 + 导入面 + 允许目录面 + 保存条。 */
function createCardBody(view: CardBodyView): ReactNode {
  const {
    t,
    statusHint,
    draft,
    rootsDraft,
    foot,
    editable,
    anythingDirty,
    busy,
    confirmReset,
    saveError,
  } = view;
  const { onCommit, onDelete, onAdd, onImported, onRootChange, onRootDelete, onRootAdd } =
    view.draftActions;
  const { onSave, onDiscard, onReset } = view.persistActions;
  const footHint = createElement("p", { className: "dpic-hint" }, t("footHint"));
  const saveBar = createElement(SaveBar, {
    dirty: anythingDirty,
    busy,
    writable: editable,
    error: saveError === "" ? null : `${t("saveFailed")}${saveError}`,
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("revert"),
    dirtyLabel: t("saveTitleDirty"),
    cleanLabel: t("saveTitleClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: () => {
      void onSave();
    },
    onDiscard,
  });
  return createElement(
    CardForm,
    null,
    statusHint === "" ? null : createElement("p", { className: "dpic-hint" }, statusHint),
    createElement(
      Section,
      { title: t("rolesSection"), hint: t("rolesHint") },
      createElement(CardToolbar, {
        foot,
        editable,
        busy,
        confirmReset,
        onAdd,
        onReset,
      }),
      draft.map((tpl, idx) =>
        createElement(TemplateRow, {
          key: tpl.id,
          t,
          index: idx,
          template: tpl,
          disabled: !editable || busy,
          onCommit,
          onDelete,
        }),
      ),
      createElement(ImportPanel, {
        t,
        editable: editable && !busy,
        onImported,
      }),
      createElement(AllowRootsPanel, {
        t,
        roots: rootsDraft,
        disabled: !editable || busy,
        onChangeRoot: onRootChange,
        onDeleteRoot: onRootDelete,
        onAddRoot: onRootAdd,
      }),
      footHint,
    ),
    saveBar,
  );
}

function TemplatesCard(props: TemplatesCardProps): ReactNode {
  const { t } = props;
  const [confirmReset, setConfirmReset] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const foot = cardFootLabels(t);
  const snap = props.useCard((state) => state);
  const { templates } = snap;
  const editable = snap.ready && snap.writable;
  const statusHint = cardStatusHint(snap, t);

  useEffect(() => {
    if (!snap.fromSettings) {
      void loadBuiltinTemplates();
    }
  }, [snap.fromSettings]);

  const [draft, setDraft] = useState<readonly TemplateEntry[]>(templates);
  const [draftFor, setDraftFor] = useState<unknown>(templates);
  useEffect(() => {
    if (draftFor !== templates) {
      setDraftFor(templates);
      setDraft((prev) => (JSON.stringify(prev) === JSON.stringify(draftFor) ? templates : prev));
    }
  }, [templates, draftFor]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (confirmReset) {
      timer = setTimeout(() => {
        setConfirmReset(false);
      }, RESET_CONFIRM_MS);
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [confirmReset]);

  const [rootsDraft, setRootsDraft] = useState<readonly string[]>(snap.allowRoots);
  const [rootsFor, setRootsFor] = useState<readonly string[]>(snap.allowRoots);
  useEffect(() => {
    if (rootsFor !== snap.allowRoots) {
      setRootsFor(snap.allowRoots);
      setRootsDraft((prev) =>
        JSON.stringify(prev) === JSON.stringify(rootsFor) ? snap.allowRoots : prev,
      );
    }
  }, [rootsFor, snap.allowRoots]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(templates);
  const rootsDirty =
    JSON.stringify(sanitizeAllowRoots(rootsDraft)) !== JSON.stringify(snap.allowRoots);
  const anythingDirty = dirty || rootsDirty;
  const draftActions = createDraftActions(t, draft, rootsDraft, setDraft, setRootsDraft);
  const persistActions = createPersistActions({
    t,
    editable,
    dirty,
    rootsDirty,
    anythingDirty,
    confirmReset,
    templates,
    allowRoots: snap.allowRoots,
    draft,
    rootsDraft,
    set: props.set,
    unset: props.unset,
    readBack: props.readBack,
    setDraft,
    setDraftFor,
    setRootsDraft,
    setBusy,
    setSaveError,
    setConfirmReset,
  });

  return createCardBody({
    t,
    statusHint,
    draft,
    rootsDraft,
    foot,
    editable,
    anythingDirty,
    busy,
    confirmReset,
    saveError,
    draftActions,
    persistActions,
  });
}

// ── 插件 apply ─────────────────────────────────────────────────────────────

export interface ClientCtx {
  effect: Context["effect"];
  /** 官方反射面：读面经 `get("remote")` 查出，不建立 inject 依赖（缺席只少一栏数据面）。 */
  get: Context["get"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
}

/** 官方 register 类型化重载的字典参数在本包命名空间上的实例化（两语必须齐）。 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

const inject = ["slots", "configForms", "locale"];

/** 注入输入框右侧的「润色」「模板」两个按钮（两枚共用同一份 store 与 t）。
 *
 * 一次 inject 挂两枚：它们的 inject 面完全相同（都只要 store 这一份 card hook），
 * 分成两次 inject 会让宿主多跑一轮 occupant 装配，而拆开的唯一好处只是少几行。 */
function injectDock(ctx: ClientCtx, store: TemplatesStore, t: Translate): void {
  const hooks = (): { hooks: { card: TemplatesStore } } => ({ hooks: { card: store } });
  ctx.slots.inject(SLOT_INPUT_RIGHT, () => {
    const unregisterOrganize = ctx.slots.register(
      {
        name: SLOT_INPUT_RIGHT,
        id: NS,
        order: 99,
        label: (): string => t("dockOrganizeEntry"),
        locale: NS,
        inject: hooks,
      },
      createOrganizeButton(),
    );
    const unregisterTemplates = ctx.slots.register(
      {
        name: SLOT_INPUT_RIGHT,
        id: `${NS}-templates`,
        order: 100,
        label: (): string => t("dockTemplatesEntry"),
        locale: NS,
        inject: hooks,
      },
      createTemplateButton(),
    );
    return () => {
      unregisterOrganize();
      unregisterTemplates();
    };
  });
}

/** 注入设置页的「角色库」卡（插件自带卡片，宿主不再生成自动表单页）。
 *  这张卡管的就是「模板」下拉与「润色」▾ 共用的那一份列表。
 *
 * scope 作为参数传进来而不是就地取：卡片 inject 闭包里的 set/unset 必须落到
 * apply 期取的那**同一份**配置表单上（中途再 get 一次未必是同一个 provider 对象），
 * 而 apply 需要它同时喂给 store 与本函数，故显式传参而不是藏进模块级状态。 */
function injectCard(ctx: ClientCtx, store: TemplatesStore, t: Translate, scope: EntryForm): void {
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          set: (field: string, value: unknown) => scope.set(field, value),
          unset: (field: string) => scope.unset(field),
          readBack: () => store.readBack(),
        }),
      },
      TemplatesCard,
    );
    return unregister;
  });
}

function apply(ctx: ClientCtx): void {
  // 读面挂在模块级：卸载时必须随 effect 一起撤下，否则旧 ctx 与它的 remote 闭包
  // 一直留在内存里（重挂载后没人用得到，却仍被这个全局引用钉住）。
  // 身份比较防止「先卸旧、后装新」时旧 disposer 把新 reader 清掉。
  const reader = createDirPrepReader(ctx);
  dirPrepReader = reader;
  ctx.effect(
    () => () => {
      if (dirPrepReader === reader) {
        dirPrepReader = undefined;
      }
    },
    "dir-prep-organize: remote reader",
  );
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "dir-prep-organize-css";
    tag.textContent = `${CARD_STYLES}\n${CARD_UI_CSS}`;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "dir-prep-organize: styles");

  const scope = ctx.configForms.get(NS);
  const store = templatesStore(scope);

  ctx.effect(
    () => ctx.locale.register(NS, UI_MESSAGES),
    "dir-prep-organize-card: locale dictionaries",
  );
  const t = ctx.locale.bind(NS);
  injectDock(ctx, store, t);
  injectCard(ctx, store, t, scope);
}

export { inject, apply };
