// 由 scripts/gen-defaults.mjs 生成。请勿手改——运行 `npm run gen:defaults` 重新生成。
// 表源：scripts/gen-defaults-lib.mjs 的 AGENT_DIR_GROUP_LABELS（键序 = 下拉分组展示序）。
/** 仓库目录名 → 下拉分组标签；未收录的目录回落目录名本身（见 templates.ts groupLabelOf）。 */
export const AGENT_DIR_GROUP_LABELS: Readonly<Record<string, string>> = {
  academic: "学术",
  company: "公司经营",
  design: "设计",
  engineering: "工程",
  evals: "评测",
  examples: "示例",
  finance: "金融",
  "game-development": "游戏",
  gis: "GIS",
  hr: "人力资源",
  integrations: "集成",
  legal: "法务",
  marketing: "营销",
  "paid-media": "付费投放",
  product: "产品",
  "project-management": "项目管理",
  sales: "销售",
  security: "安全",
  "spatial-computing": "空间计算",
  specialized: "垂直行业",
  strategy: "战略",
  "supply-chain": "供应链",
  support: "客户支持",
  testing: "测试",
};
