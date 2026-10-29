// src/client-styles.ts —— 插件注入的样式表（apply 时以 <style> 挂进 document.head）。
//
// 为什么单独成文件：这是一份**纯数据**，与逻辑面零耦合，且它是本包里体量最大的单块
// 非逻辑内容。混在 client-entry.ts 里既让那份文件长期顶在 eslint/max-lines
// 的红线上（该规则 max=2000 且 skipComments/skipBlankLines 都为 false ⇒ 纯数据行照样计数），
// 也让「改样式要翻逻辑」变得容易。apply 侧只 import CARD_STYLES 一处。
//
// 约束：颜色一律走宿主的设计别名（--dsw-*），自动跟随明暗主题；字号没有对应的别名面，
// 按「正文 / 副标题 / 卡片标题」的层次写成固定像素值，改主题不会跟着变。
// 每个 var() 都带兜底值：自定义属性替换失败会让整条声明在计算值阶段失效（等价
// unset），宿主旧版本缺某个别名时表现为背景透明、边框消失；兜底值让缺失退成
// 「继承色 / 透明」而不是丢掉整条声明。
// 规则按「按钮 / 菜单 / 设置卡 / 行内输入」分组书写，顺序即层叠顺序。
export const CARD_STYLES = [
  ".dpi-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:1;border-radius:8px;padding:6px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:background .16s,border-color .16s,color .16s}",
  ".dpi-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,currentColor);background:var(--dsw-alias-bg-layer-2,transparent)}",
  ".dpi-btn:disabled{opacity:.55;cursor:not-allowed}",
  '.dpi-btn:disabled[data-state="loading"]{cursor:progress}',
  ".dpi-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}",
  ".dpi-btn svg{width:14px;height:14px;flex:none}",
  ".dpi-btn-err{border-color:var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-state-error-secondary,currentColor)}",
  // 与 .dpi-btn:hover:not(:disabled) 同优先级（:not 计入），靠后序把错误态边框压回来，
  // 否则鼠标一悬停错误色就被基础 hover 换掉。
  ".dpi-btn-err:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,currentColor)}",
  ".dpi-spin{animation:dpi-rotate .8s linear infinite}",
  "@keyframes dpi-rotate{to{transform:rotate(360deg)}}",
  "@media (prefers-reduced-motion:reduce){.dpi-spin{animation:none}.dpi-btn{transition:none}}",
  // isolation 收住 z-index 的作用域（菜单不与宿主浮层比大小）；菜单向上弹出，宿主容器
  // 若带 overflow 裁剪或 transform 会新建层叠上下文——菜单可能被裁切，挂载侧不得把本
  // 组件放进这类容器。
  ".dpi-wrap{position:relative;display:inline-flex;isolation:isolate}",
  ".dpi-menu{position:absolute;bottom:calc(100% + 6px);right:0;z-index:50;min-width:224px;max-height:340px;overflow-y:auto;background:var(--dsw-menu-surface-fill,transparent);backdrop-filter:var(--dsw-menu-backdrop-filter,none);border:0;border-radius:10px;padding:4px;display:flex;flex-direction:column;gap:2px;box-shadow:var(--dsw-elevation-panel,none)}",
  ".dpi-item{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:1.4;text-align:left;border-radius:6px;padding:8px 10px;cursor:pointer;white-space:nowrap}",
  ".dpi-item:hover,.dpi-item:focus-visible{background:var(--dsw-alias-bg-layer-2,transparent)}",
  ".dpi-item-empty{color:var(--dsw-alias-label-tertiary,inherit);cursor:default;font-size:12px;padding:8px 10px;white-space:nowrap}",
  ".dpi-split{display:inline-flex;align-items:stretch}",
  ".dpi-split .dpi-main{border-top-right-radius:0;border-bottom-right-radius:0;padding-right:8px}",
  ".dpi-split .dpi-caret{border-left:none;border-top-left-radius:0;border-bottom-left-radius:0;padding-left:4px;padding-right:6px}",
  ".dpi-split .dpi-caret svg{width:10px;height:10px}",
  ".dpi-group{padding:2px 0}",
  ".dpi-grouph{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,inherit);padding:6px 10px 2px;letter-spacing:.02em}",
  ".dpic-row{padding:10px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,currentColor)}",
  // 控件外观由共享 .dsu-input / .dsu-btn 承担；这里只保留本行编辑器的尺寸与排布。
  // 行头三项写成复合选择器：.dsu-input 的 width:100% 在注入顺序上晚于本表，单类选择器压不住它。
  ".dpic-name{flex:1;min-width:0}",
  ".dpic-rowhead .dpic-name{width:auto}",
  ".dpic-rowhead .dpic-emoji{width:44px;flex:none;text-align:center}",
  ".dpic-rowhead .dpic-group{width:84px;flex:none}",
  ".dpic-desc{width:100%;margin-top:6px}",
  ".dpic-text{width:100%;margin-top:6px}",
  ".dpic-importpath{flex:1;min-width:0}",
  ".dpic-rowhead .dpic-importpath{width:auto}",
  ".dpic-del{flex:none}",
  ".dpic-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:8px 0}",
  ".dpic-rowhead{display:flex;gap:8px;align-items:center}",
  ".dpic-idx{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);flex:none;min-width:26px}",
  ".dpic-importrow{padding:12px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,currentColor)}",
  ".dpic-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);line-height:1.5;padding-top:6px}",
  ".dpic-err{color:var(--dsw-alias-state-error-primary,currentColor)}",
].join("\n");
