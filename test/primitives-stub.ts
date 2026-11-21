// 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的测试桩（vitest alias 指到本文件）：
// 真组件依赖宿主浮层体系（clsx / useModalLayer），Node 测试环境装不下。这里只复刻
// 测试需要交互的三位——勾选、取消、确认——按钮文案直接吃 props，驱动方式与真弹窗一致。
import { createElement } from "react";

/** data-field 锚点常量：驱动测试与桩内部共用（sonarjs 重复字面量门禁）。 */
const ACK_FIELD = "risk-acknowledge";
const CANCEL_FIELD = "risk-cancel";
const CONFIRM_FIELD = "risk-confirm";

/** 与真组件同形的确认弹窗：勾选未打时确认键禁用（钉住真组件的这道门禁）。 */
export function RiskConfirmation(props: {
  title: string;
  description: string;
  acknowledgeLabel: string;
  cancelLabel: string;
  closeLabel: string;
  confirmLabel: string;
  acknowledged: boolean;
  disabled?: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReturnType<typeof createElement> {
  const acknowledge = (): void => {
    props.onAcknowledgedChange(!props.acknowledged);
  };
  return createElement(
    "div",
    { "data-testid": "risk-confirmation", role: "dialog" },
    createElement("p", null, props.title),
    createElement("p", null, props.description),
    createElement(
      "button",
      { type: "button", "data-field": ACK_FIELD, onClick: acknowledge },
      props.acknowledgeLabel,
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-field": CANCEL_FIELD,
        onClick: (): void => {
          props.onCancel();
        },
      },
      props.cancelLabel,
    ),
    createElement(
      "button",
      {
        type: "button",
        "data-field": CONFIRM_FIELD,
        disabled: !props.acknowledged || props.disabled === true,
        onClick: (): void => {
          props.onConfirm();
        },
      },
      props.confirmLabel,
    ),
  );
}
