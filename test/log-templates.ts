// test/log-templates.ts —— 本包算子可见日志的模板片段（由源码扫出，勿手改）。
// 账本用它判「这条日志是不是源码里现存的模板」；新增 console.* 若没有对应片段，
// 跑测时那条日志就会被判未认领（见 test/setup-logs.ts）。这里不读盘：规则面
// （node/no-sync 等）不该为了测试脚手架开口子，且模板漂移应当是一次显式的改动。
export const LOG_TEMPLATES: readonly string[] = [
  "[dir-prep-organize] settings 服务不可用：设置卡页面策略未登记（宿主会按 Config 自动生成表单页）",
  "[dir-prep-organize] settings.describe() 失败，本轮文案回落中文默认：",
  "[dir-prep-organize] templates settings write failed:",
];
