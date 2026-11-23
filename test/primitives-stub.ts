// 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的测试桩（vitest alias 指到本文件）：
// 真组件依赖宿主浮层体系（clsx / useModalLayer），Node 测试环境装不下。这里复刻
// 测试需要交互的几面——确认弹窗、向上菜单的条目与关闭——驱动方式与真组件一致。
import { createElement, useEffect, useRef } from "react";
import type { ReactNode } from "react";

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

interface StubMenuItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

interface StubMenuLabel {
  readonly type: "label";
  readonly id: string;
  readonly text: string;
}

type StubMenuEntry = StubMenuItem | StubMenuLabel;

/** 从菜单项的 label（可能套一层 span）里取出 title，取不到就交给 React 省略。 */
function itemTitle(entry: StubMenuItem): string | undefined {
  const { label } = entry;
  let title: string | undefined;
  if (typeof label === "object" && label !== null && "props" in label) {
    const propsOfLabel = (label as { props?: { title?: unknown; children?: unknown } }).props;
    const labelTitle = propsOfLabel?.title;
    if (typeof labelTitle === "string") {
      title = labelTitle;
    } else {
      const child = propsOfLabel?.children;
      if (typeof child === "object" && child !== null && "props" in child) {
        const inner = (child as { props?: { title?: unknown } }).props;
        const innerTitle = inner?.title;
        if (typeof innerTitle === "string") {
          title = innerTitle;
        }
      }
    }
  }
  return title;
}

/** 宿主 Menu 的最小同形桩：渲染 anchor、打开时的条目与关闭回调；data-field 由 listClassName 带出。 */
export function Menu(props: {
  open: boolean;
  anchor: ReactNode;
  items?: readonly StubMenuEntry[];
  className?: string;
  listClassName?: string;
  onSelect?: (id: string) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}): ReturnType<typeof createElement> {
  const {
    open,
    onClose,
    listClassName = "",
    items = [],
    onSelect,
    returnFocus,
    className,
    anchor,
  } = props;
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) {
      return () => {
        /* 关闭态没有监听可撤 */
      };
    }
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) {
        return;
      }
      onClose();
      returnFocus?.();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
        returnFocus?.();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, returnFocus]);
  const listClass = listClassName;
  let menuKind: "template" | "organize" | "none" = "none";
  if (listClass.includes("dpi-template-menu")) {
    menuKind = "template";
  } else if (listClass.includes("dpi-organize-menu")) {
    menuKind = "organize";
  }
  let field: string | undefined;
  if (menuKind === "template") {
    field = "dpi-template-menu";
  } else if (menuKind === "organize") {
    field = "dpi-organize-menu";
  }
  const itemField = (entry: StubMenuItem): string | undefined => {
    let result: string | undefined;
    if (menuKind === "template") {
      result = entry.id.startsWith("tpl:") ? "dpi-template-item" : undefined;
    } else if (menuKind === "organize") {
      if (entry.id === "direct") {
        result = "dpi-organize-role-direct";
      } else {
        result = entry.id.startsWith("tpl:") ? "dpi-organize-role-item" : undefined;
      }
    }
    return result;
  };
  const list = open
    ? createElement(
        "div",
        {
          role: "menu",
          className: listClass,
          ...(field === undefined ? {} : { "data-field": field }),
        },
        ...items.map((entry) =>
          "type" in entry
            ? createElement(
                "div",
                { key: entry.id, role: "presentation", className: "dpi-grouph" },
                entry.text,
              )
            : createElement(
                "button",
                {
                  key: entry.id,
                  type: "button",
                  role: "menuitem",
                  "data-field": itemField(entry),
                  title: itemTitle(entry),
                  disabled: entry.disabled === true,
                  onClick: (): void => {
                    onSelect?.(entry.id);
                  },
                },
                entry.label,
              ),
        ),
      )
    : null;
  return createElement("span", { ref: rootRef, className }, anchor, list);
}
