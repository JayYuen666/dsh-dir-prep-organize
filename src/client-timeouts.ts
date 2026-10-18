// src/client-timeouts.ts —— 卡片侧读面超时的取值与夹位（单源，client 半内部用）。
//
// 为什么单独成文件：这两条规则全在 `setTimeout` 的**静默失败**上——延时超过 2^31-1 ms
// 时 V8 只往 stderr 打一条 TimeoutOverflowWarning，然后把延时夹成 1 ms，于是「把超时
// 调大」被反转成「立刻失败」，配置界面上看不出任何异常。规则本身只有两行，但它的
// 理由必须与代码同处（否则下一个人只会看到 `Math.min` 而不知道为什么），而
// client-entry.ts 已经在 max-lines 的线上，把这块挪出来既保住约束又不给主文件加负担。
//
// host 侧对同一件事的夹位见 host.ts 的 clampInt / MAX_TIMER_MS：两边必须同口径，
// 而 client 半**不 import host.ts**（它打的是浏览器包，host.ts 跑在 node 上），
// 所以同源靠注释锁定。要统一就把这两个常量一起提进 `@jayyuen66/dsh-plugin-shared`。

/**
 * `setTimeout` 延时上界（Node/V8 的 2^31-1 ms）。
 *
 * 超了它 V8 只往 stderr 打一条 TimeoutOverflowWarning，然后把延时**静默夹成 1 ms**。
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** 配置表单里读不到 `organizeTimeoutMs` 时的回落值（与 host 侧 ORGANIZE_TIMEOUT_MS 同值）。 */
export const ORGANIZE_TIMEOUT_FALLBACK_MS = 120_000;

/** 客户端比 host 多等的余量：host 先超时，客户端留一点时间把它的回执读回来。 */
export const ORGANIZE_TIMEOUT_SLACK_MS = 5000;

/**
 * `organizeTimeoutMs` 的前端取表。
 *
 * 上界与 host 同为 `[1, MAX_TIMER_MS]`：host 自己夹了上界正是为了躲开上面那个静默夹断，
 * 而这一侧是**唯一**发起整理读面调用的地方，它要是没夹，host 夹得再对也没用。
 *
 * @param value - 配置表单投影值
 * @returns `[1, MAX_TIMER_MS]` 区间内的整数；不合法时 undefined（回落默认）
 */
export function rawOrganizeTimeoutMsOf(value: Record<string, unknown>): number | undefined {
  const key = "organizeTimeoutMs";
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.trunc(raw), MAX_TIMER_MS)
    : undefined;
}

/**
 * 整理请求的客户端超时：host 的整理时限 + 余量，整条结果同样夹进 `[1, MAX_TIMER_MS]`。
 *
 * **加法之后还要再夹一次**，因为 `MAX_TIMER_MS + ORGANIZE_TIMEOUT_SLACK_MS` 自己就越界了
 * （实测 V8 把 2147488647 的延时夹成 1ms，点击整理立刻回「请求超时」）。
 *
 * @param raw - 配置表单投影里的整理时限（未夹）
 * @returns 可安全交给 setTimeout 的毫秒数
 */
export function organizeFetchTimeoutMs(raw: number | undefined): number {
  const base = raw ?? ORGANIZE_TIMEOUT_FALLBACK_MS;
  return Math.min(base + ORGANIZE_TIMEOUT_SLACK_MS, MAX_TIMER_MS);
}
