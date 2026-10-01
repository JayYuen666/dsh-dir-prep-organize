import { createElement, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { mergeImportedTemplates, sanitizeAllowRoots, sanitizeTemplateList } from "./templates.ts";
import type { TemplateEntry } from "./templates.ts";
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

const NS: LocaleNs = "dir-prep-organize";
const BUNDLE_PKG = "@jayyuen66/dsh-dir-prep-organize";
const CONTEXT_URL = "/_dsh/dir-prep/context";
const MODEL_URL = "/_dsh/dir-prep/model";
const ORGANIZE_URL = "/_dsh/dir-prep/organize";
const IMPORT_URL = "/_dsh/dir-prep/import";

const FETCH_TIMEOUT_MS = 125_000;
const ERROR_FLASH_MS = 4000;
const RESET_CONFIRM_MS = 4000;
const EMOJI_PLACEHOLDER = "😀";
const ROOT_PATH_PLACEHOLDER = "/Users/me/roles";

const CSS = [
  ".dpi-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;border-radius:8px;padding:6px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .16s,border-color .16s,color .16s}",
  ".dpi-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}",
  ".dpi-btn:disabled{opacity:.55;cursor:not-allowed}",
  '.dpi-btn:disabled[data-state="loading"]{cursor:progress}',
  ".dpi-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".dpi-btn svg{width:14px;height:14px;flex:none}",
  ".dpi-btn-err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-secondary)}",
  ".dpi-spin{animation:dpi-rotate .8s linear infinite}",
  "@keyframes dpi-rotate{to{transform:rotate(360deg)}}",
  ".dpi-wrap{position:relative;display:inline-flex}",
  ".dpi-menu{position:absolute;bottom:calc(100% + 6px);right:0;z-index:50;min-width:224px;max-height:340px;overflow-y:auto;background:var(--dsw-menu-surface-fill);backdrop-filter:var(--dsw-menu-backdrop-filter);border:0;border-radius:10px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:var(--dsw-elevation-panel)}",
  ".dpi-item{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.4;text-align:left;border-radius:6px;padding:8px 10px;cursor:pointer;white-space:nowrap}",
  ".dpi-item:hover,.dpi-item:focus-visible{background:var(--dsw-alias-bg-layer-2)}",
  ".dpi-item-empty{color:var(--dsw-alias-label-tertiary);cursor:default;font-size:12px;padding:8px 10px;white-space:nowrap}",
  ".dpi-split{display:inline-flex;align-items:stretch}",
  ".dpi-split .dpi-main{border-top-right-radius:0;border-bottom-right-radius:0;padding-right:8px}",
  ".dpi-split .dpi-caret{border-left:none;border-top-left-radius:0;border-bottom-left-radius:0;padding-left:4px;padding-right:6px}",
  ".dpi-split .dpi-caret svg{width:10px;height:10px}",
  ".dpi-group{padding:2px 0}",
  ".dpi-grouph{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:6px 10px 2px;letter-spacing:.02em}",
  ".dpic-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".dpic-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".dpic-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".dpic-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".dpic-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".dpic-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".dpic-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".dpic-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".dpic-chevron-open{transform:rotate(180deg)}",
  ".dpic-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px;list-style:none}",
  ".dpic-row{padding:10px 0;border-bottom:1px dashed var(--dsw-alias-border-l2)}",
  ".dpic-rowhead{display:flex;gap:8px;align-items:center}",
  ".dpic-idx{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none;min-width:26px}",
  ".dpic-name{flex:1;min-width:0;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px}",
  ".dpic-del{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;border-radius:6px;padding:4px 8px;cursor:pointer;flex:none}",
  ".dpic-del:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
  ".dpic-del:disabled{opacity:.55;cursor:not-allowed}",
  ".dpic-text{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:8px;margin-top:6px;min-height:96px;resize:vertical}",
  ".dpic-name:focus,.dpic-text:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".dpic-emoji{width:44px;flex:none;box-sizing:border-box;font:inherit;font-size:13px;text-align:center;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 4px}",
  ".dpic-group{width:84px;flex:none;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px}",
  ".dpic-desc{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:6px}",
  ".dpic-emoji:focus,.dpic-group:focus,.dpic-desc:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".dpic-importrow{padding:12px 0;border-bottom:1px dashed var(--dsw-alias-border-l2)}",
  ".dpic-importpath{flex:1;min-width:0;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px}",
  ".dpic-importpath:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".dpic-foot{display:flex;gap:8px;align-items:center;padding-top:10px;flex-wrap:wrap}",
  ".dpic-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-radius:8px;padding:6px 10px;cursor:pointer}",
  ".dpic-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}",
  ".dpic-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".dpic-btn:disabled{opacity:.55;cursor:not-allowed}",
  ".dpic-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}",
  ".dpic-btn-primary:disabled{opacity:.55;cursor:not-allowed}",
  ".dpic-btn-danger{color:var(--dsw-alias-state-error-primary)}",
  ".dpic-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}",
  ".dpic-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.5;padding-top:6px}",
  ".dpic-err{color:var(--dsw-alias-state-error-primary)}",
].join("\n");

const CLASS_ITEM_EMPTY = "dpi-item-empty";
const CLASS_ROW_HEAD = "dpic-rowhead";
const CLASS_IMPORT_PATH = "dpic-importpath";
const SLOT_INPUT_RIGHT = "conversation.input.right";

// ── 端点类型（与 host.ts 契约一致）────────────────────────────────────────

export interface DirEntryView {
  name: string;
  isDir: boolean;
  sizeBytes: number;
  snippet?: string;
}
export interface ContextResponse {
  ok: boolean;
  error?: string;
  csrf?: string;
  cwd?: string;
  truncated?: boolean;
  entries?: DirEntryView[];
}
interface ModelResponse {
  ok: boolean;
  error?: string;
  csrf?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}
interface OrganizeResponse {
  ok: boolean;
  error?: string;
  content?: string;
}
interface ImportResponse {
  ok: boolean;
  error?: string;
  count?: number;
  truncated?: boolean;
  skipped?: ImportSkips;
  entries?: TemplateEntry[];
}
export interface ImportSkips {
  tooLarge: number;
  unreadable: number;
  deeper: number;
  unnamed: number;
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

function parseContextResponse(raw: unknown): ContextResponse {
  const rec = isRecord(raw) ? raw : {};
  const { ok, error, csrf, cwd, truncated, entries } = rec;
  const parsedEntries: DirEntryView[] | undefined = Array.isArray(entries)
    ? entries.map((entry) => parseDirEntry(entry))
    : undefined;
  return {
    ok: ok === true,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof csrf === "string" ? { csrf } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(truncated === true ? { truncated: true } : {}),
    ...(parsedEntries === undefined ? {} : { entries: parsedEntries }),
  };
}

function parseModelResponse(raw: unknown): ModelResponse {
  const rec = isRecord(raw) ? raw : {};
  const { ok, error, csrf, provider, model, reasoningEffort } = rec;
  return {
    ok: ok === true,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof csrf === "string" ? { csrf } : {}),
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
  };
}

function parseOrganizeResponse(raw: unknown): OrganizeResponse {
  const rec = isRecord(raw) ? raw : {};
  const { ok, error, content } = rec;
  return {
    ok: ok === true,
    ...(typeof error === "string" ? { error } : {}),
    ...(typeof content === "string" ? { content } : {}),
  };
}

function countField(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

function parseImportSkips(rec: Record<string, unknown>): ImportSkips {
  const { tooLarge, unreadable, deeper, unnamed } = rec;
  return {
    tooLarge: countField(tooLarge),
    unreadable: countField(unreadable),
    deeper: countField(deeper),
    unnamed: countField(unnamed),
  };
}

export function formatImportSkips(t: Translate, skips: ImportSkips | undefined): string {
  if (skips === undefined) {
    return "";
  }
  const parts: string[] = [];
  if (skips.deeper > 0) {
    parts.push(t("skipDeeper", { count: skips.deeper }));
  }
  if (skips.tooLarge > 0) {
    parts.push(t("skipTooLarge", { count: skips.tooLarge }));
  }
  if (skips.unreadable > 0) {
    parts.push(t("skipUnreadable", { count: skips.unreadable }));
  }
  if (skips.unnamed > 0) {
    parts.push(t("skipUnnamed", { count: skips.unnamed }));
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

async function httpErrorMessage(response: {
  status: number;
  json: () => Promise<unknown>;
}): Promise<string> {
  const fallback = `HTTP ${String(response.status)}`;
  const body: unknown = await response.json().catch(() => null);
  const rec = isRecord(body) ? body : {};
  const { error } = rec;
  return typeof error === "string" && error.length > 0 ? error : fallback;
}

async function fetchJson(
  url: string,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    const response = await fetch(url, { ...init, signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(await httpErrorMessage(response));
    }
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("请求超时", { cause: error });
    }
    throw new Error(errorText(error), { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

const BUILTIN_TEMPLATES_URL = "/_dsh/dir-prep/default-templates";

export type BuiltinPhase = "idle" | "loading" | "ready" | "error";

export interface BuiltinState {
  phase: BuiltinPhase;
  list: readonly TemplateEntry[];
  error: string;
}

const builtinInitial: BuiltinState = { phase: "idle", list: [], error: "" };

let builtinState: BuiltinState = builtinInitial;
let builtinInflight: Promise<BuiltinState> | null = null;
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

export async function loadBuiltinTemplates(): Promise<BuiltinState> {
  if (builtinState.phase === "ready") {
    return builtinState;
  }
  if (builtinInflight !== null) {
    const inflightState = await builtinInflight;
    return inflightState;
  }
  builtinInflight = (async (): Promise<BuiltinState> => {
    setBuiltinState({ phase: "loading", list: builtinState.list, error: "" });
    let settled: BuiltinState;
    try {
      const body = await fetchJson(BUILTIN_TEMPLATES_URL);
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
      builtinInflight = null;
    }
    return setBuiltinState(settled);
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
  builtinInflight = null;
  setBuiltinState(builtinInitial);
}

function builtinStatusRow(snap: TemplatesSnapshot, t: Translate): ReactNode | undefined {
  const attrs = { className: CLASS_ITEM_EMPTY, "data-field": "dpi-builtin-state" };
  const retryButton = createElement(
    "button",
    {
      type: "button",
      className: "dpi-builtin-retry",
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
): string {
  if (!ctxRes.ok) {
    throw new Error(`目录上下文失败: ${ctxRes.error ?? "未知错误"}`);
  }
  if (!modelRes.ok || modelRes.provider === undefined || modelRes.model === undefined) {
    throw new Error(`读取模型失败: ${modelRes.error ?? "未知错误"}`);
  }
  if (prompt.trim().length === 0) {
    throw new Error("输入框为空，无内容可整理");
  }
  const csrf = ctxRes.csrf ?? modelRes.csrf ?? "";
  if (csrf === "") {
    throw new Error(`整理令牌缺失：${ctxRes.error ?? modelRes.error ?? "请重试"}`);
  }
  return csrf;
}

async function requestOrganize(args: {
  csrf: string;
  ctxRes: ContextResponse;
  prompt: string;
  sessionId: string;
  roleText?: string | undefined;
  timeoutMs: number;
}): Promise<string> {
  const { csrf, ctxRes, prompt, sessionId, roleText, timeoutMs } = args;
  const body: Record<string, string> = {
    prompt,
    sessionId,
    entriesSummary: formatContextSummary(ctxRes),
  };
  const roleKey = "roleText";
  if (roleText !== undefined) {
    body[roleKey] = roleText;
  }
  const orgRes = parseOrganizeResponse(
    await fetchJson(
      ORGANIZE_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-dir-prep-csrf": csrf },
        body: JSON.stringify(body),
      },
      timeoutMs,
    ),
  );
  if (!orgRes.ok || orgRes.content === undefined) {
    throw new Error(orgRes.error ?? "整理失败（未知错误）");
  }
  return orgRes.content;
}

async function runOrganizeFlow(args: {
  prompt: string;
  sessionId: string;
  roleText?: string;
  timeoutMs: number;
}): Promise<string> {
  const [ctxRaw, modelRaw] = await Promise.all([
    fetchJson(`${CONTEXT_URL}?sessionId=${encodeURIComponent(args.sessionId)}`),
    fetchJson(`${MODEL_URL}?sessionId=${encodeURIComponent(args.sessionId)}`),
  ]);
  const ctxRes = parseContextResponse(ctxRaw);
  const modelRes = parseModelResponse(modelRaw);
  const csrf = assertOrganizeReady(ctxRes, modelRes, args.prompt);
  return requestOrganize({
    csrf,
    ctxRes,
    prompt: args.prompt,
    sessionId: args.sessionId,
    roleText: args.roleText,
    timeoutMs: args.timeoutMs,
  });
}

// ── 模板：0.1.7 配置表单契约与 store（读侧唯一入口）──────────────────────────

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

export function rawOrganizeTimeoutMsOf(value: Record<string, unknown>): number | undefined {
  const key = "organizeTimeoutMs";
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
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

export function applyTemplateToDraft(current: string, template: string): string {
  const base = typeof current === "string" ? current.trimEnd() : "";
  if (base.length === 0) {
    return template;
  }
  return `${base}\n\n${template}`;
}

// ── 组件 props（框架注入的 standard kit 子集，形状全部取自官方声明）───────────

export interface KitProps {
  t: Translate;
  useCard: <TResult>(selector: (snap: TemplatesSnapshot) => TResult) => TResult;
  useInput?: <TResult>(selector: (state: Pick<InputState, "draft">) => TResult) => TResult;
  inputActions?: Pick<InputActions, "setDraft">;
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
  readonly loading: boolean;
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
    loading,
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
  if (loading) {
    return;
  }
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
    });
    if (seq.current !== mySeq) {
      return;
    }
    writeDraft(content);
  } catch (error) {
    if (seq.current !== mySeq) {
      return;
    }
    setFailed(errorText(error));
    if (flashTimer.current !== null) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => {
      setFailed(undefined);
    }, ERROR_FLASH_MS);
  } finally {
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
  templates: readonly TemplateEntry[];
  onRun: OrganizeRun;
  onToggleMenu: () => void;
}

function createOrganizeMainButton(ui: OrganizeUIView): ReactNode {
  const { t, icon, label, state, errClass, errTitle, loading, onRun } = ui;
  return createElement(
    "button",
    {
      type: "button",
      className: `dpi-btn dpi-main${errClass}`,
      "aria-label": t("organizeMainAria"),
      title: errTitle,
      "data-field": "dpi-organize-btn",
      "data-state": state,
      disabled: loading,
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
  const { t, templates, onRun, directItemLabel, noTemplatesLabel, builtinRow } = ui;
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
              title: tpl.description === "" ? tpl.text : tpl.description,
              onClick: () => {
                void onRun(tpl.text);
              },
            },
            `${tpl.emoji === "" ? "" : `${tpl.emoji} `}${t("organizeRoleItem", { name: tpl.name })}`,
          ),
        ),
  );
}

function createOrganizeButton(): (props: KitProps) => ReactNode {
  return function OrganizeButton(props: KitProps): ReactNode {
    const [loading, setLoading] = useState(false);
    const [failed, setFailed] = useState<string | undefined>(undefined);
    const [menuOpen, setMenuOpen] = useState(false);
    const seq = useRef(0);
    const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wrapRef = useRef<HTMLSpanElement | null>(null);

    const draft: string =
      props.useInput === undefined
        ? ""
        : (props.useInput((state): string | undefined => state.draft) ?? "");
    const snap = props.useCard((state) => state);
    const { templates } = snap;

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
      await runOrganizeClick({
        loading,
        seq,
        prompt: draft,
        sessionId: props.sessionId ?? "",
        timeoutMs: (snap.organizeTimeoutMs ?? 120_000) + 5000,
        roleText,
        setLoading,
        setMenuOpen,
        setFailed,
        flashTimer,
        writeDraft: (content: string): void => {
          const actions = props.inputActions;
          if (actions === undefined || typeof actions.setDraft !== "function") {
            throw new Error(props.t("organizeWriteBackUnavailable"));
          }
          actions.setDraft(content);
        },
      });
    }

    function openMenu(): void {
      if (!snap.fromSettings) {
        void loadBuiltinTemplates();
      }
      setMenuOpen((prev) => !prev);
    }

    let icon: ReactNode;
    let label: string;
    let state: string;
    if (failed !== undefined) {
      icon = createElement(FailIcon);
      label = props.t("organizeFailedShort");
      state = "error";
    } else if (loading) {
      icon = createElement(SpinIcon);
      label = props.t("organizeLoading");
      state = "loading";
    } else {
      icon = createElement(TidyIcon);
      label = props.t("organizeIdle");
      state = "idle";
    }
    const ui: OrganizeUIView = {
      t: props.t,
      errTitle:
        failed === undefined
          ? props.t("organizeIdleTitle")
          : props.t("organizeFailedTitle", { message: failed }),
      icon,
      label,
      state,
      errClass: failed === undefined ? "" : " dpi-btn-err",
      directItemLabel: props.t("organizeDirectItem"),
      noTemplatesLabel: props.t("organizeNoTemplates"),
      builtinRow: builtinStatusRow(snap, props.t),
      loading,
      menuOpen,
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
    const draft: string =
      props.useInput === undefined
        ? ""
        : (props.useInput((state): string | undefined => state.draft) ?? "");
    const snap = props.useCard((state) => state);
    const { templates } = snap;

    useMenuDismiss(open, wrapRef, () => {
      setOpen(false);
    });

    function pick(text: string): void {
      setOpen(false);
      const actions = props.inputActions;
      if (actions === undefined || typeof actions.setDraft !== "function") {
        return;
      }
      actions.setDraft(applyTemplateToDraft(draft, text));
    }

    const canWrite =
      props.inputActions !== undefined && typeof props.inputActions.setDraft === "function";
    const title = canWrite ? props.t("templatesIdleTitle") : props.t("templatesBrokenTitle");

    const groupedMap = new Map<string, TemplateEntry[]>();
    for (const tpl of templates) {
      const key = tpl.group.trim() === "" ? props.t("templatesGroupCommon") : tpl.group;
      const bucket = groupedMap.get(key) ?? [];
      bucket.push(tpl);
      groupedMap.set(key, bucket);
    }
    const grouped = [...groupedMap.entries()].map(([group, items]) => ({ group, items }));
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
                        `${tpl.emoji === "" ? "" : `${tpl.emoji} `}${tpl.name}`,
                      ),
                    ),
                  ),
                ),
          )
        : null,
    );
  };
}

// ── 设置页「提示词模板」卡（quality-gate 卡同款骨架）────────────────────────

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
    className: "dpic-emoji",
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
    className: "dpic-name",
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
    className: "dpic-group",
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
      className: "dpic-del",
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
    className: "dpic-desc",
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
    className: "dpic-text",
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
    "li",
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
        await fetchJson(IMPORT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target, sessionId: "" }),
        }),
      );
      if (!resp.ok || resp.entries === undefined) {
        throw new Error(resp.error ?? t("importFailedUnknown"));
      }
      const usable = resp.entries.length;
      const count = Math.min(resp.count ?? usable, usable);
      if (count === 0) {
        setImportError(t("importEmpty"));
        return;
      }
      props.onImported(resp.entries);
      setImportPath("");
      const skipNote = formatImportSkips(t, resp.skipped);
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
    className: CLASS_IMPORT_PATH,
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
      className: "dpic-btn",
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
    "li",
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
      className: CLASS_IMPORT_PATH,
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
        className: "dpic-del",
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
    className: CLASS_IMPORT_PATH,
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
      className: "dpic-btn",
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
    "li",
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

function CardFootBar(props: {
  foot: CardFootLabels;
  editable: boolean;
  anythingDirty: boolean;
  busy: boolean;
  confirmReset: boolean;
  onAdd: () => void;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onReset: () => void;
}): ReactNode {
  const { foot, editable, anythingDirty, busy, confirmReset } = props;
  return createElement(
    "li",
    { className: "dpic-foot" },
    createElement(
      "button",
      { type: "button", className: "dpic-btn", disabled: !editable, onClick: props.onAdd },
      foot.add,
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dpic-btn dpic-btn-primary",
        "data-field": "save",
        disabled: !editable || !anythingDirty || busy,
        title: anythingDirty ? foot.saveTitleDirty : foot.saveTitleClean,
        onClick: props.onSave,
      },
      busy ? foot.saving : foot.save,
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dpic-btn",
        "data-field": "discard",
        disabled: !editable || !anythingDirty || busy,
        onClick: props.onDiscard,
      },
      foot.revert,
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dpic-btn dpic-btn-danger",
        disabled: !editable,
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
    resetConfirm: t("resetConfirm"),
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

function createCardHeader(view: {
  t: Translate;
  open: boolean;
  setOpen: Setter<boolean>;
}): ReactNode {
  const { t, open, setOpen } = view;
  const headTitle = createElement("div", { className: "dpic-title" }, t("cardTitle"));
  const headDesc = createElement("div", { className: "dpic-desc" }, t("cardDescription"));
  const headBlock = createElement("div", { className: "dpic-head" }, headTitle, headDesc);
  const chevronPath = createElement("path", svgPathProps("M3 5l4 4 4-4", true));
  const chevron = createElement(
    "svg",
    {
      width: 14,
      height: 14,
      viewBox: "0 0 14 14",
      "aria-hidden": true,
      className: `dpic-chevron${open ? " dpic-chevron-open" : ""}`,
    },
    chevronPath,
  );
  return createElement(
    "button",
    {
      type: "button",
      className: "dpic-header",
      "aria-expanded": open,
      onClick: () => {
        setOpen((prev) => !prev);
      },
    },
    headBlock,
    chevron,
  );
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
        text: t("newTemplateText"),
        group: "",
        emoji: "",
      },
    ]);
  }
  function onImported(incoming: readonly TemplateEntry[]): void {
    setDraft(mergeImportedTemplates(draft, incoming));
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
      setDraft(next);
      setRootsDraft(nextRoots);
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

/** 展开态正文（状态行 + 模板行表 + 卡底动作条 + 导入面 + 允许目录面 + 底部提示）。 */
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
  return createElement(
    "ul",
    { className: "dpic-body" },
    statusHint === "" ? null : createElement("li", { className: "dpic-hint" }, statusHint),
    draft.map((tpl, idx) =>
      createElement(TemplateRow, {
        key: tpl.id,
        t,
        index: idx,
        template: tpl,
        disabled: !editable,
        onCommit,
        onDelete,
      }),
    ),
    createElement(CardFootBar, {
      foot,
      editable,
      anythingDirty,
      busy,
      confirmReset,
      onAdd,
      onSave,
      onDiscard,
      onReset,
    }),
    createElement(ImportPanel, {
      t,
      editable,
      onImported,
    }),
    createElement(AllowRootsPanel, {
      t,
      roots: rootsDraft,
      disabled: !editable,
      onChangeRoot: onRootChange,
      onDeleteRoot: onRootDelete,
      onAddRoot: onRootAdd,
    }),
    createElement("li", { className: "dpic-hint" }, t("footHint")),
    saveError === ""
      ? null
      : createElement("li", { className: "dpic-hint dpic-err" }, `${t("saveFailed")}${saveError}`),
  );
}

function TemplatesCard(props: TemplatesCardProps): ReactNode {
  const { t } = props;
  const [open, setOpen] = useState(false);
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

  // 抽出头部/chevron/正文子树，避免 createElement 递归嵌套过深
  const headerBtn = createCardHeader({ t, open, setOpen });
  const bodyList = open
    ? createCardBody({
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
      })
    : null;

  return createElement(
    "li",
    { className: `dpic-card${open ? " dpic-card-open" : ""}` },
    headerBtn,
    bodyList,
  );
}

// ── 插件 apply ─────────────────────────────────────────────────────────────

export interface ClientCtx {
  effect: Context["effect"];
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

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "dir-prep-organize-css";
    tag.textContent = CSS;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "dir-prep-organize: styles");

  const scope = ctx.configForms.get(NS);
  const store = templatesStore(scope);

  const OrganizeButton = createOrganizeButton();
  const TemplateButton = createTemplateButton();
  ctx.effect(
    () => ctx.locale.register(NS, UI_MESSAGES),
    "dir-prep-organize-card: locale dictionaries",
  );
  const t = ctx.locale.bind(NS);
  const dockInject = (): { hooks: { card: TemplatesStore } } => ({ hooks: { card: store } });

  ctx.slots.inject(SLOT_INPUT_RIGHT, () => {
    const unregisterOrganize = ctx.slots.register(
      {
        name: SLOT_INPUT_RIGHT,
        id: NS,
        order: 99,
        label: (): string => t("dockOrganizeEntry"),
        locale: NS,
        inject: dockInject,
      },
      OrganizeButton,
    );
    const unregisterTemplates = ctx.slots.register(
      {
        name: SLOT_INPUT_RIGHT,
        id: `${NS}-templates`,
        order: 100,
        label: (): string => t("dockTemplatesEntry"),
        locale: NS,
        inject: dockInject,
      },
      TemplateButton,
    );
    return () => {
      unregisterOrganize();
      unregisterTemplates();
    };
  });

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

export { inject, apply };
