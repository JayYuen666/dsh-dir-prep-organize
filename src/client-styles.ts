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
  "@media (prefers-reduced-motion:reduce){.dpi-spin{animation:none}.dpi-btn,.dpic-card,.dpic-chevron{transition:none}}",
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
  ".dpic-card{border:1px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-layer-3,transparent);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".dpic-card:hover{border-color:var(--dsw-alias-label-dimmed,currentColor)}",
  ".dpic-card-open{background:var(--dsw-alias-bg-layer-2,transparent);border-color:var(--dsw-alias-label-dimmed,currentColor)}",
  ".dpic-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".dpic-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".dpic-title{color:var(--dsw-alias-label-primary,inherit);font-size:15px;font-weight:600;line-height:1.4}",
  ".dpic-cardsub{color:var(--dsw-alias-label-tertiary,inherit);font-size:13px;line-height:1.5}",
  ".dpic-chevron{color:var(--dsw-alias-label-tertiary,inherit);flex:none;transition:transform .16s}",
  ".dpic-chevron-open{transform:rotate(180deg)}",
  ".dpic-body{border-top:1px solid var(--dsw-alias-border-l2,currentColor);margin:0 16px;padding:8px 0 12px;list-style:none}",
  ".dpic-row{padding:10px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,currentColor)}",
  ".dpic-rowhead{display:flex;gap:8px;align-items:center}",
  ".dpic-idx{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);flex:none;min-width:26px}",
  // 六个行内输入控件共享同一段基础声明（见上方约束），各自只写尺寸与个别行高。
  ".dpic-name,.dpic-text,.dpic-emoji,.dpic-group,.dpic-desc,.dpic-importpath{box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px}",
  ".dpic-name{flex:1;min-width:0;font-size:12px;padding:6px 8px}",
  ".dpic-del{appearance:none;border:1px solid var(--dsw-alias-border-l2,currentColor);background:transparent;color:var(--dsw-alias-label-tertiary,inherit);font:inherit;font-size:12px;border-radius:6px;padding:4px 8px;cursor:pointer;flex:none}",
  ".dpic-del:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,currentColor);color:var(--dsw-alias-state-error-primary,currentColor)}",
  ".dpic-del:disabled{opacity:.55;cursor:not-allowed}",
  ".dpic-header:focus-visible,.dpic-del:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}",
  ".dpic-text{width:100%;font-size:12px;line-height:1.6;padding:8px;margin-top:6px;min-height:96px;resize:vertical}",
  ".dpic-name:focus,.dpic-text:focus,.dpic-emoji:focus,.dpic-group:focus,.dpic-desc:focus,.dpic-importpath:focus{outline:none;border-color:var(--dsw-alias-brand-primary,currentColor)}",
  // :focus-visible 排在 :focus 之后（同优先级靠后序胜出）：指针聚焦只留边框高亮，
  // 键盘聚焦补外轮廓，与 .dpic-header/.dpic-del/.dpi-btn 的处理一致。
  ".dpic-name:focus-visible,.dpic-text:focus-visible,.dpic-emoji:focus-visible,.dpic-group:focus-visible,.dpic-desc:focus-visible,.dpic-importpath:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}",
  ".dpic-emoji{width:44px;flex:none;font-size:13px;text-align:center;padding:6px 4px}",
  ".dpic-group{width:84px;flex:none;font-size:12px;padding:6px 8px}",
  ".dpic-desc{width:100%;font-size:12px;padding:6px 8px;margin-top:6px}",
  ".dpic-importrow{padding:12px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,currentColor)}",
  ".dpic-importpath{flex:1;min-width:0;font-size:12px;padding:6px 8px}",
  ".dpic-foot{display:flex;gap:8px;align-items:center;padding-top:10px;flex-wrap:wrap}",
  ".dpic-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;border-radius:8px;padding:6px 10px;cursor:pointer}",
  ".dpic-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,currentColor);background:var(--dsw-alias-bg-layer-2,transparent)}",
  ".dpic-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:1px}",
  ".dpic-btn:disabled{opacity:.55;cursor:not-allowed}",
  ".dpic-btn-primary{background:var(--dsw-alias-brand-primary,currentColor);border-color:var(--dsw-alias-brand-primary,currentColor);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  // 这条不是重复：它要压住上面 .dpic-btn:hover:not(:disabled) 的换底（同优先级靠后序
  // 胜出），同时给出真实的悬停反馈；删掉 brightness 主按钮悬停就没有任何变化。
  ".dpic-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,currentColor);border-color:var(--dsw-alias-brand-primary,currentColor);filter:brightness(.92)}",
  ".dpic-btn-danger{color:var(--dsw-alias-state-error-primary,currentColor)}",
  ".dpic-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary,currentColor)}",
  ".dpic-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit);line-height:1.5;padding-top:6px}",
  ".dpic-err{color:var(--dsw-alias-state-error-primary,currentColor)}",
].join("\n");
