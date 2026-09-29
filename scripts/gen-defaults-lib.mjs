// dir-prep-organize 默认模板生成的纯逻辑层（被 gen-defaults.mjs 与漂移测试共用）。
//
// 为什么单独成文件：CLI 版在 import 时会跑 main()（读写盘、可能 process.exit），
// 测试要拿它做全量漂移锁就必须能"只 import 不执行"。这里放镜像实现与常量表，
// scripts/gen-defaults.mjs 只做 IO + 退出码。
//
// 与 src/templates.ts 的单源约束：以下 parseFrontmatterFields / stripPairQuotes /
// parseAgentFrontmatter / condenseRoleBody / groupLabelOf / AGENT_DIR_GROUP_LABELS /
// CURATED_SLUGS 都是 templates.ts 的镜像实现/镜像常量表。test/gen-defaults.test.ts
// 会全量比对（85 条逐字段 + 两张表的键序 + 生成文件字节级一致），漂移即红。

/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 插件根目录与内置角色库（lib 自带，测试与 CLI 同一路径口径）。 */
export const PLUGIN_ROOT = path.dirname(import.meta.dirname);
export const AGENTS_DIR = path.join(PLUGIN_ROOT, "agents");
export const GENERATED_FILE = path.join(PLUGIN_ROOT, "src", "default-templates.generated.ts");
/** 分组标签的生成落点（单源=本文件 AGENT_DIR_GROUP_LABELS；templates.ts 从这里
 *  re-export，宿主/客户端共用同一份，"保持同步"从纪律变成结构）。 */
export const GROUP_LABELS_FILE = path.join(PLUGIN_ROOT, "src", "group-labels.generated.ts");

/** 精选默认集：独立开发者高频角色（slug 顺序即展示顺序；全量其余角色可导入）。 */
export const CURATED_SLUGS = [
  // 工程
  "engineering-frontend-developer",
  "engineering-backend-architect",
  "engineering-software-architect",
  "engineering-code-reviewer",
  "engineering-security-engineer",
  "engineering-database-optimizer",
  "engineering-technical-writer",
  "engineering-rapid-prototyper",
  "engineering-ai-engineer",
  "engineering-data-engineer",
  "engineering-devops-automator",
  "engineering-git-workflow-master",
  "engineering-incident-response-commander",
  "engineering-mobile-app-builder",
  "engineering-wechat-mini-program-developer",
  "engineering-feishu-integration-developer",
  "engineering-minimal-change-engineer",
  "engineering-senior-developer",
  "engineering-prompt-engineer",
  "engineering-multi-agent-systems-architect",
  "engineering-codebase-onboarding-engineer",
  // 设计
  "design-ui-designer",
  "design-ux-architect",
  "design-image-prompt-engineer",
  // 产品
  "product-manager",
  "product-sprint-prioritizer",
  "product-feedback-synthesizer",
  // 公司经营
  "chief-executive-officer",
  "chief-technology-officer",
  "chief-product-officer",
  "chief-operating-officer",
  // 项目管理
  "project-manager-senior",
  "project-management-jira-workflow-steward",
  "project-management-meeting-notes-specialist",
  // 测试
  "testing-api-tester",
  "testing-performance-benchmarker",
  "testing-accessibility-auditor",
  "testing-reality-checker",
  // 营销（中国平台）
  "marketing-xiaohongshu-operator",
  "marketing-douyin-strategist",
  "marketing-wechat-official-account",
  "marketing-zhihu-strategist",
  "marketing-private-domain-operator",
  "marketing-content-creator",
  // 金融
  "finance-financial-analyst",
  "finance-fpa-analyst",
  // ── 中国场景（营销/电商/私域/硬件）─────────────────────────────────────────
  "marketing-wechat-operator",
  "marketing-weixin-channels-strategist",
  "marketing-weibo-strategist",
  "marketing-bilibili-strategist",
  "marketing-kuaishou-strategist",
  "marketing-baidu-seo-specialist",
  "marketing-china-ecommerce-operator",
  "marketing-china-market-localization-strategist",
  "marketing-cross-border-ecommerce",
  "marketing-livestream-commerce-coach",
  "marketing-knowledge-commerce-strategist",
  "marketing-ecommerce-operator",
  "marketing-multi-platform-publisher",
  "engineering-dingtalk-integration-developer",
  "engineering-network-engineer-china",
  "engineering-pc-host-engineer",
  "engineering-embedded-firmware-engineer",
  // ── 开发者相关（工程补齐/安全专业/测试/专项）────────────────────────────────
  "engineering-embedded-linux-driver-engineer",
  "engineering-iot-solution-architect",
  "engineering-sre",
  "engineering-orgscript-engineer",
  "engineering-voice-ai-integration-engineer",
  "security-appsec-engineer",
  "security-penetration-tester",
  "security-architect",
  "security-incident-responder",
  "security-compliance-auditor",
  "testing-test-results-analyzer",
  "testing-tool-evaluator",
  "testing-embedded-qa-engineer",
  "specialized-mcp-builder",
  "agents-orchestrator",
  "specialized-workflow-architect",
  // ── 跨职能少量 ─────────────────────────────────────────────────────────────
  "chief-marketing-officer",
  "chief-financial-officer",
  "chief-of-staff",
  "finance-tax-strategist",
  "finance-bookkeeper-controller",
  "project-management-project-shepherd",
];

/** 仓库目录名 → 中文分组标签（镜像 src/templates.ts 的 AGENT_DIR_GROUP_LABELS）。
 *  @type {Record<string, string>}
 */
export const AGENT_DIR_GROUP_LABELS = {
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

/**
 * 目录名 → 分组标签（镜像 templates.ts groupLabelOf）。
 * @param {string} dirName
 * @returns {string}
 */
export function groupLabelOf(dirName) {
  const mapped = Object.hasOwn(AGENT_DIR_GROUP_LABELS, dirName)
    ? AGENT_DIR_GROUP_LABELS[dirName]
    : undefined;
  return mapped ?? dirName;
}

/** 首尾同字符引号包裹（镜像 templates.ts isWrappedIn）。
 *  @param {string} value
 *  @param {string} quote
 *  @returns {boolean}
 */
function isWrappedIn(value, quote) {
  return value.length >= 2 && value.startsWith(quote) && value.endsWith(quote);
}

/** 去掉首尾成对引号（镜像 templates.ts stripPairQuotes）。
 *  @param {string} value
 *  @returns {string}
 */
export function stripPairQuotes(value) {
  if (isWrappedIn(value, "'") || isWrappedIn(value, '"')) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** frontmatter 键名形状（镜像 templates.ts FRONTMATTER_KEY）。 */
const FRONTMATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** 头部只解析前 20 行键值对（镜像 templates.ts FRONTMATTER_MAX_LINES）。 */
const FRONTMATTER_MAX_LINES = 20;

/** 视觉标记最大字符数（镜像 templates.ts EMOJI_MAX_LENGTH）。 */
const EMOJI_MAX_LENGTH = 12;

/**
 * 一行 frontmatter → `键 + 原样值`（镜像 templates.ts readFrontmatterPair）。
 * @param {string} line
 * @returns {{ key: string; value: string } | undefined}
 */
function readFrontmatterPair(line) {
  // 单 return 满足 consistent-return（镜像 templates.ts），守卫不通过只不赋值。
  let result;
  const colon = line.indexOf(":");
  if (colon > 0) {
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (FRONTMATTER_KEY.test(key) && value.length > 0) {
      result = { key, value };
    }
  }
  return result;
}

/** 键 → 目标位：防重复（已有值不覆盖，取首个同名键）；emoji 截断（镜像 templates.ts）。
 * @param {{ name: string; description: string; emoji: string }} fields
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function takeFrontmatterField(fields, key, value) {
  if (key === "name" && fields.name === "" && value.length > 0) {
    fields.name = value;
  } else if (key === "description" && fields.description === "" && value.length > 0) {
    fields.description = value;
  } else if (key === "emoji" && fields.emoji === "") {
    fields.emoji = value.slice(0, EMOJI_MAX_LENGTH);
  }
}

/**
 * 解析 frontmatter 键值（镜像 templates.ts parseFrontmatterFields）。
 * @param {string} head
 * @returns {{ name: string; description: string; emoji: string }}
 */
export function parseFrontmatterFields(head) {
  const fields = { name: "", description: "", emoji: "" };
  for (const [lineNum, rawLine] of head.split("\n").entries()) {
    if (lineNum >= FRONTMATTER_MAX_LINES) {
      break;
    }
    const pair = readFrontmatterPair(rawLine.trim());
    if (pair !== undefined) {
      takeFrontmatterField(fields, pair.key, stripPairQuotes(pair.value));
    }
  }
  return fields;
}

/**
 * 解析角色文件（镜像 templates.ts parseAgentFrontmatter）。
 * @param {string} text
 * @returns {{ name: string; description: string; emoji: string; body: string } | undefined}
 */
export function parseAgentFrontmatter(text) {
  const norm = text.replaceAll("\r\n", "\n");
  const firstNl = norm.indexOf("\n");
  // 单 return 满足 consistent-return（镜像 templates.ts）：各守卫失败只不赋值。
  let result;
  if (firstNl !== -1 && norm.slice(0, firstNl).trim() === "---") {
    const rest = norm.slice(firstNl + 1);
    const closeIdx = rest.search(/^---[ \t]*$/mu);
    if (closeIdx !== -1) {
      const head = rest.slice(0, closeIdx);
      const bodyStart = rest.indexOf("\n", closeIdx) + 1;
      const body = bodyStart > 0 ? rest.slice(bodyStart).trim() : "";
      const fields = parseFrontmatterFields(head);
      if (fields.name !== "") {
        result = { name: fields.name, description: fields.description, emoji: fields.emoji, body };
      }
    }
  }
  return result;
}

/**
 * 正文提炼（镜像 templates.ts condenseRoleBody：去围栏/行内反引号，不截断）。
 * @param {string} body
 * @returns {string}
 */
export function condenseRoleBody(body) {
  const lines = body.split(/\r?\n/u);
  /** @type {string[]} */
  const out = [];
  let inFence = false;
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
    } else if (inFence) {
      // 围栏内容整体跳过
    } else {
      out.push(raw.replaceAll("`", ""));
    }
  }
  return out.join("\n").trim();
}

/** 扫描 agents/<dept> 顶层 *.md（一级嵌套暂不需要，目录结构均在顶层）。
 *  部门目录之间无先后依赖（各读各的目录，结果只按 deptNames 顺序拼接），故一次并行
 *  发起 readdir：Promise.all 保序 ⇒ 展平后的条目顺序与串行版逐条一致，生成文件字节不变。
 *  非目录条目用守卫块跳过（等价于原 continue）。
 *  @returns {Promise<Array<{ slug: string; dirName: string; filePath: string }>>}
 */
export async function scanAgentFiles() {
  const deptNames = await readdir(AGENTS_DIR, { withFileTypes: true });
  const perDept = await Promise.all(
    deptNames
      .filter((dirent) => dirent.isDirectory())
      .map(async (dirent) => {
        const deptDir = path.join(AGENTS_DIR, dirent.name);
        const children = await readdir(deptDir, { withFileTypes: true });
        return children
          .filter(
            (child) => child.isFile() && child.name.endsWith(".md") && !child.name.startsWith("."),
          )
          .map((child) => ({
            slug: child.name.slice(0, -3),
            dirName: dirent.name,
            filePath: path.join(deptDir, child.name),
          }));
      }),
  );
  return perDept.flat();
}

/** 精选 slug 列表 → 模板条目（顺序即展示顺序）。
 *  读源文件并行发起（85 个本地文件之间无依赖，串行只是把 IO 延迟累加）：Promise.all
 *  保序 ⇒ texts 与 CURATED_SLUGS 同位，下面的解析/提炼/校验循环因此与串行版逐条一致，
 *  包括「第一个坏 slug 先报错」的 CLI 语义。唯一差别：若某文件**读**失败（缺权限等），
 *  并行下报出的可能是任一坏文件——缺失 slug 早已由调用方挡掉，不影响产物。
 *  @param {Map<string, {slug: string; dirName: string; filePath: string}>} bySlug
 *  @param {(filePath: string) => Promise<string>} read
 *  @returns {Promise<Array<{id:string;name:string;description:string;text:string;group:string;emoji:string}>>}
 */
export async function buildEntries(bySlug, read) {
  const texts = await Promise.all(CURATED_SLUGS.map((slug) => read(bySlug.get(slug).filePath)));
  /** @type {Array<{id:string;name:string;description:string;text:string;group:string;emoji:string}>} */
  const entries = [];
  for (const [index, slug] of CURATED_SLUGS.entries()) {
    const info = parseAgentFrontmatter(texts[index]);
    if (info === undefined) {
      throw new Error(`${slug} 解析失败（无有效 frontmatter name）`);
    }
    const condensed = condenseRoleBody(info.body);
    if (condensed.length === 0) {
      throw new Error(`${slug} 提炼正文为空`);
    }
    entries.push({
      id: slug,
      name: info.name,
      description: info.description,
      text: condensed,
      group: groupLabelOf(bySlug.get(slug).dirName),
      emoji: info.emoji,
    });
  }
  return entries;
}

/** 条目 → default-templates.generated.ts 的完整文件内容（字节级锁定用）。
 *  @param {Array<{id:string;name:string;description:string;text:string;group:string;emoji:string}>} entries
 *  @returns {string}
 */
export function renderGenerated(entries) {
  const lines = [
    "// 由 scripts/gen-defaults.mjs 生成。请勿手改——运行 `npm run gen:defaults` 重新生成。",
    "// 角色源：agents/<dept>/<file>.md（自 agency-agents-zh 移入插件目录）。",
    "// 解析/提炼与 src/templates.ts 的 parseAgentFrontmatter / condenseRoleBody / groupLabelOf",
    "// 保持一致（生成脚本为镜像实现；改动需同步脚本 + 重生成 + 跑测试锁一致性）。",
    'import type { TemplateEntry } from "./templates.ts";',
    "",
    "/** 内置精选角色默认模板（独立开发者高频角色；全量角色见 agents/ 目录，设置页可一键导入）。*/",
    `export const DEFAULT_TEMPLATES: readonly TemplateEntry[] = [`,
    ...entries.map(
      (entry) =>
        `  { id: ${JSON.stringify(entry.id)}, name: ${JSON.stringify(entry.name)}, description: ${JSON.stringify(entry.description)}, text: ${JSON.stringify(entry.text)}, group: ${JSON.stringify(entry.group)}, emoji: ${JSON.stringify(entry.emoji)} },`,
    ),
    "];",
    "",
  ];
  return lines.join("\n");
}

/**
 * oxfmt 的 bin 路径：oxfmt 是本包 devDependency（版本由 `pnpm-workspace.yaml` 的 catalog 钉），
 * 所以 pnpm 必然在 `<pkg>/node_modules/.bin` 放一份；不在就是没装，抛错而不是退回"未排版"。
 */
const OXFMT_BIN = path.join(PLUGIN_ROOT, "node_modules", ".bin", "oxfmt");

/**
 * 起 oxfmt 子进程（裸路径参数 = 就地排版；`--check` 才是不写盘）。
 *
 * 为什么是同步实现：这一段有三条判据互斥的实测形状 ——
 *  - `promisify(execFile)` 被 `typescript/strict-void-return` 判死（execFile 返回 ChildProcess，
 *    promisify 的签名要的是返回 void 的回调式函数）；
 *  - 手搓 `new Promise(execFile(…))` 一次撞上四条：`promise/avoid-new`、
 *    `promise/prefer-await-to-callbacks`、`typescript/promise-function-async`、
 *    `typescript/prefer-promise-reject-errors`；
 *  - `execFileSync` 在这里不掉任何覆盖面也不新增豁免：`scripts/**` 与 `*.mjs` 在基线的
 *    SCRIPTS_OVERRIDES 里本来就关着 `node/no-sync`（门禁/构建脚本的既有形态，实测理由在那）。
 * @param {string[]} args - 传给 oxfmt 的参数
 * @returns {void}
 */
function runOxfmt(args) {
  if (!existsSync(OXFMT_BIN)) {
    throw new Error(
      `找不到 oxfmt 可执行文件（${OXFMT_BIN}）：先跑 pnpm install（oxfmt 由 pnpm-workspace.yaml 的 catalog 钉版）`,
    );
  }
  execFileSync(OXFMT_BIN, args, { stdio: "ignore" });
}

/**
 * 生成物的排版步骤：渲染出的源码文本 → oxfmt 的规范形态。
 *
 * 为什么这一步属于生成器而不是"人记得跑一次格式化"：`fmt:check: oxfmt --check src test scripts`
 * 把 `src` 下两份 `.generated.ts` 也算在排版面上（根 `~/.dsh/oxfmt.config.ts` 只排 markdown 一类），
 * 而 test/gen-defaults.test.ts 第 4 条锁的是"磁盘生成物 = 生成器输出"的字节级相等。
 * 两边不共享同一套规范形态时，只能二选一红：实测在仓根跑 `oxfmt .` 就把
 * `default-templates.generated.ts` 改 out 了 758 行，字节锁当场红。
 * 排版因此并入生成链路（排除面一条都没加）。
 *
 * 临时文件落在 `tmpdir()`：本仓的 oxfmt 配置只提供 `ignorePatterns`、不提供任何排版选项，
 * 所以默认形态与在 `src/` 里就地排版一致；这一条由 `checkFormatted` 在写盘后实证，不靠推断。
 * @param {string} code - renderGenerated / renderLabels 的输出
 * @returns {string} 排版后的同一份内容
 */
export function formatGenerated(code) {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-gen-defaults-"));
  const file = path.join(dir, "generated.ts");
  try {
    writeFileSync(file, code, "utf8");
    runOxfmt([file]);
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 实证"落盘的生成物已是 oxfmt 规范形态"：把磁盘内容再过一遍同一套排版链路，字节必须不变。
 *
 * 为什么不用 `oxfmt --check <文件>`：实测（0.71.0，cwd 在包根）给它**单个文件路径**——相对与绝对都
 * 一样——只报 `Expected at least one target file. All matched files may have been excluded by
 * ignore rules.` 且**退出码 0**；给它目录才真的查到文件。也就是说按文件点名的 `--check` 是一道
 * 静默保绿的假门，而包里的 `fmt:check` 恰好全是目录形态（`oxfmt --check src test scripts`）。
 * 幂等比较吃的是 formatGenerated 同一条路径，不依赖 oxfmt 的路径匹配口径。
 * @param {string} file - 生成物的绝对路径
 * @returns {void}
 */
export function checkFormatted(file) {
  const onDisk = readFileSync(file, "utf8");
  const refixed = formatGenerated(onDisk);
  if (refixed !== onDisk) {
    throw new Error(
      `生成物 ${file} 不是 oxfmt 规范形态，包内 fmt:check 会红（再过一遍排版链路产生了 ${String(
        refixed.length - onDisk.length,
      )} 字节差）。生成器必须在 renderGenerated/renderLabels 之后接 formatGenerated。`,
    );
  }
}

/** 渲染 src/group-labels.generated.ts（分组标签的单源出口）。
 *  @param {Record<string, string>} labels
 *  @returns {string}
 */
export function renderLabels(labels) {
  const lines = [
    "// 由 scripts/gen-defaults.mjs 生成。请勿手改——运行 `npm run gen:defaults` 重新生成。",
    "// 表源：scripts/gen-defaults-lib.mjs 的 AGENT_DIR_GROUP_LABELS（键序 = 下拉分组展示序）。",
    "/** 仓库目录名 → 下拉分组标签；未收录的目录回落目录名本身（见 templates.ts groupLabelOf）。 */",
    "export const AGENT_DIR_GROUP_LABELS: Readonly<Record<string, string>> = {",
    ...Object.entries(labels).map(
      ([dir, label]) => `  ${JSON.stringify(dir)}: ${JSON.stringify(label)},`,
    ),
    "};",
    "",
  ];
  return lines.join("\n");
}
