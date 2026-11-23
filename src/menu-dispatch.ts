// 菜单 id 的纯分派：组织菜单与模板菜单共用。组件只负责状态与副作用，
// 这里不 import client-entry 的任何运行时符号，重试动作由调用方注入。
import type { TemplatesSnapshot } from "./client-entry.ts";

/** 内置模板失败态的重试项 id。 */
export const BUILTIN_RETRY_ID = "builtin-retry";

/** 组织菜单动作：direct 立即整理、重试重新拉表、模板项带稿子整理。 */
export function runOrganizeMenuSelection(
  id: string,
  templates: TemplatesSnapshot["templates"],
  organize: (roleText?: string) => Promise<void>,
  retry: () => void,
): void {
  if (id === "direct") {
    void organize();
    return;
  }
  if (id === BUILTIN_RETRY_ID) {
    retry();
    return;
  }
  if (!id.startsWith("tpl:")) {
    return;
  }
  const picked = templates.find((template) => `tpl:${template.id}` === id);
  if (picked !== undefined) {
    void organize(picked.text);
  }
}

/** 模板菜单动作；返回是否关闭菜单（重试保持打开等 store 换代列出）。 */
export function runTemplateMenuSelection(
  id: string,
  templates: TemplatesSnapshot["templates"],
  pick: (text: string) => void,
  retry: () => void,
): boolean {
  if (id === BUILTIN_RETRY_ID) {
    retry();
    return false;
  }
  if (!id.startsWith("tpl:")) {
    return true;
  }
  const picked = templates.find((template) => `tpl:${template.id}` === id);
  if (picked !== undefined) {
    pick(picked.text);
  }
  return true;
}
