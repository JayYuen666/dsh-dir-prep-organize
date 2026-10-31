/**
 * 输入框异步写回的凭据与判定。
 *
 * 润色结果是整稿替换：发起时记下会话、草稿版本与输入动作面，返回时用**最新一帧**
 * 核对。任一项在途中变了（用户继续编辑、宿主进入提交期、会话被切换、组件重挂成
 * 另一份 facade），结果都不许落地——宁可报「未写回」，也不能覆盖用户后来的输入。
 * 模板走插入语义（captureInsertion + insertText），由宿主按发起的选区做版本校验。
 */
import { useEffect, useRef } from "react";
import type { InputActions, InputState } from "@deepseek-ai/dsh-client-ui-conversation/client";

export type InputActionsFace = Pick<InputActions, "setDraft" | "captureInsertion" | "insertText">;

/** 输入面的最新一帧（异步返回时读它，不读发起那次 render 的闭包）。 */
export interface InputSnapshot {
  readonly sessionId: string;
  readonly actions: InputActionsFace | undefined;
  readonly draftRev: number;
  readonly phase: InputState["phase"];
}

/** 一次整稿写回的凭据。 */
export interface WriteBackTicket {
  readonly sessionId: string;
  readonly draftRev: number;
  readonly actions: InputActionsFace | undefined;
  invalidated: boolean;
}

/** 宿主是否给了整稿替换面（润色结果最后落到 setDraft）。 */
export function hasDraftFace(actions: InputActionsFace | undefined): actions is InputActionsFace {
  return actions !== undefined && typeof actions.setDraft === "function";
}

/** 宿主是否给了版本校验插入面（模板走这一对，不整稿覆盖）。 */
export function hasInsertFace(actions: InputActionsFace | undefined): actions is InputActionsFace {
  return (
    actions !== undefined &&
    typeof actions.captureInsertion === "function" &&
    typeof actions.insertText === "function"
  );
}

export interface WriteBackMessages {
  readonly unavailable: string;
  readonly stale: string;
}

export interface WriteBackBinding {
  readonly begin: () => WriteBackTicket;
  readonly finish: (ticket: WriteBackTicket) => void;
  readonly commit: (content: string, ticket: WriteBackTicket) => void;
}

/** 提交期（`phase !== "plain"`）也算失效：发送成功后编辑器会被清空，失败时原稿要留着，
 *  两种情况下在途的润色结果都不该再写进草稿。 */
export function useWriteBack(input: InputSnapshot, messages: WriteBackMessages): WriteBackBinding {
  const latest = useRef<InputSnapshot>(input);
  const active = useRef<WriteBackTicket | undefined>(undefined);
  useEffect(() => {
    latest.current = input;
    const ticket = active.current;
    if (ticket === undefined) {
      return;
    }
    if (
      ticket.sessionId !== input.sessionId ||
      ticket.actions !== input.actions ||
      input.phase !== "plain"
    ) {
      ticket.invalidated = true;
    }
  }, [input]);
  // 卸载时也要把在途票据作废：组件消失后仍可能有读者拿着 ticket 调 commit，
  // 而失效判定本来只活在 effect 里，卸载之后没有人再替它置 invalidated。
  useEffect(
    () => (): void => {
      const ticket = active.current;
      if (ticket !== undefined) {
        ticket.invalidated = true;
        active.current = undefined;
      }
    },
    [],
  );
  return {
    begin: (): WriteBackTicket => {
      const ticket: WriteBackTicket = {
        sessionId: latest.current.sessionId,
        draftRev: latest.current.draftRev,
        actions: latest.current.actions,
        invalidated: false,
      };
      // 旧票据**不**在这里作废：两发同源请求可以同时在途（同步连点会绕过渲染态
      // 门禁，见 client.test.ts 的重入用例），两份结果来自同一 draftRev，谁先到都
      // 该照常写回。真正要作废的是「输入已经变了」那一档，由上面的 effect 负责。
      active.current = ticket;
      return ticket;
    },
    finish: (ticket: WriteBackTicket): void => {
      if (active.current === ticket) {
        active.current = undefined;
      }
    },
    commit: (content: string, ticket: WriteBackTicket): void => {
      const live = latest.current;
      const { actions } = live;
      if (!hasDraftFace(actions)) {
        throw new Error(messages.unavailable);
      }
      // 会话/阶段这两条也在这里现判，不只依赖 effect 已经跑过：effect 是**上一次渲染后**
      // 的异步时机，同一 tick 内「切会话 → 旧结果到达」时它还没执行，票据会看着仍然有效。
      if (ticket.sessionId !== live.sessionId || live.phase !== "plain") {
        throw new Error(messages.stale);
      }
      let liveRev = live.draftRev;
      if (hasInsertFace(actions)) {
        const span = actions.captureInsertion();
        liveRev = span.draftRev;
      }
      if (ticket.invalidated || liveRev !== ticket.draftRev) {
        throw new Error(messages.stale);
      }
      actions.setDraft(content);
    },
  };
}
