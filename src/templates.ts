// dir-prep-organize 模板单源。
//
// 能力（直接用 agency-agents-zh 内容、文件移入插件目录、精选默认 + 全量可导入）：
//   - TemplateEntry 字段：id/name/description（悬停简介）/text/group（分组）/emoji，
//     与角色文件 frontmatter（name/description/emoji）对齐，导入零损失映射。
//   - DEFAULT_TEMPLATES 由 scripts/gen-defaults.mjs 从 agents/<dept>/*.md（自
//     agency-agents-zh 移入插件目录）生成的精选集（独立开发者高频角色）；
//     全量角色可经设置页「导入角色」一键导入（路径留空 = 导入内置 agents/ 全部；
//     填路径按「cwd 内 + 内置角色目录 allowlist」策略放行，绝对路径默认拒绝，见 host）。
//   - 角色文件解析（parseAgentFrontmatter）/ 正文提炼（condenseRoleBody）纯函数共享
//     host（导入端点）与 client（「以该角色整理」的角色上下文），单源防两份副本漂移；
//     生成脚本为镜像实现，测试锁「生成结果与真实文件一致」（漂移即红）。
//   - 不设字符上限（用户拍板）：正文提炼只做叙述主干/代码围栏清洗，
//     不做长度截断——上下文完整性优先，模型 context 超限由模型报错提示用户自行处理。
//
// 单源约束：host.ts（settings base 默认值）与 src/client-entry.ts（下拉兜底 + 设置卡）
// 都 import 本文件/生成文件，杜绝"两份默认副本漂移"。
//
// 正文形状约束：所有模板正文不含反引号（插入输入框不破坏 markdown 围栏，测试锁死）；
// 导入/提炼时围栏行与行内反引号一律剔除（condenseRoleBody），保证该不变式对导入物同样成立。

/** 一条提示引导词/角色模板（settings 持久化形状：全 string 字段的普通对象，
 *  满足 dsh-settings cloneJsonShaped 的 JSON 白名单）。description/group/emoji
 *  为必填（空串表示未设置），保证下拉与设置卡无缺字段分支。 */
import { isRecord } from "@jayyuen666/dsh-plugin-shared/lib/record";
import { AGENT_DIR_GROUP_LABELS as GENERATED_GROUP_LABELS } from "./group-labels.generated.ts";

export interface TemplateEntry {
  id: string;
  name: string;
  /** 一句话专长/适用场景（下拉 item title 展示；对齐角色 frontmatter description）。 */
  description: string;
  text: string;
  /** 分组标签（下拉按此分组渲染；空=通用）。导入角色时取所属部门的固定中文标签。 */
  group: string;
  /** 角色视觉标记（下拉 item 前缀）；空=不显示。 */
  emoji: string;
}

/** 角色正文提炼/「按角色整理」上下文：不设字符上限（用户拍板，
 *  上下文完整性优先；模型 context 超限由模型报错提示用户自行处理）。 */

// ── agency-agents-zh 角色目录 → 中文分组标签（导入角色时按父目录取组）────────────

/** 仓库目录名 → 下拉分组标签的**唯一**导出点在 `./group-labels.generated.ts`（表源 =
 *  scripts/gen-defaults-lib.mjs，键序 = 下拉分组展示序），本文件不再同名 re-export：
 *  实测同名两处导出正是 fallow `duplicate_export`（severity=error）报出来的那一条，
 *  而"两份名字保持同步"的纪律并不由 re-export 保证。表体仍是生成物；host 半引本文件的
 *  groupLabelOf/parseAgentFrontmatter，精选集（现 640KB）也由 host 半引走、经
 *  default-templates 端点按需下发，client 半不打包它。 */

/** 仓库目录名 → 分组标签（groupLabelOf(engineering) === "工程"；未收录回落目录名）。
 *  必须只认**自有属性**：`AGENT_DIR_GROUP_LABELS["constructor"]` 会命中原型上的
 *  function（`?? dirName` 不触发）→ TemplateEntry.group 拿到函数、JSON.stringify
 *  静默丢掉整个 group 键（探针：{"id":"a"}）；"__proto__" 同理返回 {}。 */
export function groupLabelOf(dirName: string): string {
  const mapped = Object.hasOwn(GENERATED_GROUP_LABELS, dirName)
    ? GENERATED_GROUP_LABELS[dirName]
    : undefined;
  return mapped ?? dirName;
}

// ── 角色文件解析（host 导入端点 / 测试共用）──────────────────────────────────

/** 角色 .md 解析结果（frontmatter 的 name/description/emoji + 去除头部围栏的正文）。 */
export interface AgentFileInfo {
  name: string;
  description: string;
  emoji: string;
  body: string;
}

/** 首尾同字符引号包裹？（`value.length >= 2` 先挡住 `'` 这类单字符假阳性）。
 *  startsWith/endsWith 而非 charAt/.at()/索引：单字符索引在
 *  noUncheckedIndexedAccess 下是 string|undefined，会逼出一个永远走不到的
 *  兜底分支（length>=2 时首末字符必然存在），把覆盖率红线留给真逻辑。 */
function isWrappedIn(value: string, quote: string): boolean {
  return value.length >= 2 && value.startsWith(quote) && value.endsWith(quote);
}

/** 去掉首尾成对引号（单/双引号同字符；无引号原样返回）。 */
function stripPairQuotes(value: string): string {
  if (isWrappedIn(value, "'") || isWrappedIn(value, '"')) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** frontmatter 键名形状（与旧版 `^key:.*$` 正则同语义）。 */
const FRONTMATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** 头部只解析前 20 行键值对（防御恶意超长头部拖慢）。 */
const FRONTMATTER_MAX_LINES = 20;

/** 视觉标记进入下拉前缀的最大字符数。 */
const EMOJI_MAX_LENGTH = 12;

/** frontmatter 里本包认识的三个键。 */
interface FrontmatterFields {
  name: string;
  description: string;
  emoji: string;
}

/** 一行 frontmatter → `键 + 原样值`；无冒号 / 键名不合法 / 值为空 → 不算键值对。
 *  indexOf 切片代替命名捕获组：命名组的 groups 在 noUncheckedIndexedAccess
 *  下是 string|undefined，`(raw ?? "")` 的兜底支永远走不到（`.*` 必然参与匹配）。 */
function readFrontmatterPair(line: string): { key: string; value: string } | undefined {
  // 单 return 满足 consistent-return（见 parseAgentFrontmatter），守卫不通过只不赋值。
  let result: { key: string; value: string } | undefined;
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

/** 键 → 目标位：防重复（已有值不覆盖，取首个同名键）；emoji 截断至 EMOJI_MAX_LENGTH。 */
function takeFrontmatterField(fields: FrontmatterFields, key: string, value: string): void {
  if (key === "name" && fields.name === "" && value.length > 0) {
    fields.name = value;
  } else if (key === "description" && fields.description === "" && value.length > 0) {
    fields.description = value;
  } else if (key === "emoji" && fields.emoji === "") {
    fields.emoji = value.slice(0, EMOJI_MAX_LENGTH);
  }
}

/** 从 frontmatter 头部解析 name/description/emoji（只解析前 20 行键值对，
 *  防御恶意超长头部拖慢；防重复，取首个同名键）。 */
function parseFrontmatterFields(head: string): FrontmatterFields {
  const fields: FrontmatterFields = { name: "", description: "", emoji: "" };
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
 * 解析 agency-agents-zh 风格角色文件：首行 `---` + 键值对 frontmatter + 正文。
 *
 * - 无 frontmatter / 缺 `name` 键 / name 为空 → undefined（非角色文件，导入时跳过）；
 * - 键值对格式宽松：`key: value`，value 可带引号或裸值，取首个同名键；
 * - 正文 = 第二个 `---` 围栏之后的内容（trim），与 condenseRoleBody 组合产出模板正文；
 * - 纯字符串处理，无 YAML 依赖，确定性可测。
 */
export function parseAgentFrontmatter(text: string): AgentFileInfo | undefined {
  const norm = text.replaceAll("\r\n", "\n");
  const firstNl = norm.indexOf("\n");
  // 单 return 满足 consistent-return（treatUndefinedAsUnspecified：混合
  // `return undefined` 与 `return value` 会误报）——各守卫失败只不赋值，
  // result 保持 undefined，底部统一返回。
  let result: AgentFileInfo | undefined;
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
 * 角色正文提炼（导入 / 「按角色整理」共用）：取叙述主干、去代码围栏。
 *
 * 规则（确定性，测试锁死）：
 * - ``` 围栏行整体剔除（围栏内容多为长代码样例，对角色语境价值低）；
 * - 行内反引号一并剔除——沿用"正文不含反引号、插入不破坏 markdown 围栏"不变式；
 * - 不设字符上限（用户拍板）：全量保留叙述内容，避免截断影响
 *   「以角色整理」的上下文完整性；模型 context 超限由模型报错提示用户自行处理；
 * - 结果 trim；空正文（全围栏/全空白）→ 空串。
 */
export function condenseRoleBody(body: string): string {
  const lines = body.split(/\r?\n/u);
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
    } else if (inFence) {
      // 围栏内容整体跳过（长代码样例对角色语境价值低）
    } else {
      out.push(raw.replaceAll("`", ""));
    }
  }
  return out.join("\n").trim();
}

/**
 * 导入条目并入现有草稿：与既有 id 碰撞时确定性改写（追加 `-i` 直到唯一）。
 * 返回新数组（不改输入），保证 pre-save 阶段 React key 唯一（保存前的 id 去重，
 * sanitizeTemplateList 的确定性补 id 只兜底缺失/空，不负责碰撞改写）。
 */
export function mergeImportedTemplates(
  existing: readonly TemplateEntry[],
  incoming: readonly TemplateEntry[],
): TemplateEntry[] {
  const ids = new Set(existing.map(({ id }) => id));
  const out: TemplateEntry[] = [...existing];
  for (const { id: baseId, ...rest } of incoming) {
    let id = baseId;
    if (ids.has(id)) {
      id = `${baseId}-i`;
      while (ids.has(id)) {
        id = `${id}i`;
      }
    }
    ids.add(id);
    out.push({ ...rest, id });
  }
  return out;
}

// ── 内置默认模板（精选角色，由 scripts/gen-defaults.mjs 从 agents/ 生成）──────────

/** 内置默认模板（独立开发者精选角色集，生成自插件内置 agents/ 目录）。
 *  host 作为 settings base 下发；client 在快照缺 templates 字段时兜底使用
 * （不猜测快照是否合并 base，两种语义下行为都正确）。
 * 全量角色可经设置页「导入角色」导入（路径留空 = 导入内置 agents/ 全部；显式路径
 * 受 host 的「cwd 内 + 内置角色目录 allowlist」策略约束）。 */
export { DEFAULT_TEMPLATES } from "./default-templates.generated.ts";

/** 任意来源（settings 快照 / 设置卡草稿）→ 合法模板列表（纯函数，测试锁死）。
 *
 *  - 非数组输入 → []（调用方自行决定是否回落 DEFAULT_TEMPLATES）；
 *  - 剔除非对象条目与 name/text trim 后为空的条目；
 *  - name/text/description/group 一律 trim；emoji trim 后截断至 12 字符；
 *  - id 缺失或与已收集 id 撞名 → 确定性补 `tpl-<index>`（仍撞则追加
 *    `-<index>` 直到唯一）——同输入同输出，可测试；
 *  - 绝不修改输入（深比较测试锁死）。 */

/** 字段 → trim 后的 string；非字符串一律 ""（与旧版逐字段三元的判据同语义）。 */
function trimField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** id 缺失或与已收集 id 撞名 → 确定性补 `tpl-<index>`（仍撞则追加 `-<index>` 直到唯一）。
 *  只负责取名，不登记 `seen`——登记由调用方在装配条目时做（同旧版顺序）。 */
function uniqueEntryId(candidate: string, index: number, seen: Set<string>): string {
  if (candidate !== "" && !seen.has(candidate)) {
    return candidate;
  }
  let id = `tpl-${index}`;
  while (seen.has(id)) {
    id = `${id}-${index}`;
  }
  return id;
}

/** 单条归一化：剔除坏条目/空 name|text；id 缺失或撞名 → 确定性补 tpl-<index>，
 *  返回 undefined 表示该条应被剔除。 */
function normalizeEntry(
  item: unknown,
  index: number,
  seen: Set<string>,
): TemplateEntry | undefined {
  // 单 return 满足 consistent-return（见 parseAgentFrontmatter），守卫失败只不赋值。
  let result: TemplateEntry | undefined;
  if (isRecord(item)) {
    const { id, name, description, text, group, emoji } = item;
    const nextName = trimField(name);
    const nextText = trimField(text);
    if (nextName !== "" && nextText !== "") {
      const nextId = uniqueEntryId(trimField(id), index, seen);
      seen.add(nextId);
      result = {
        id: nextId,
        name: nextName,
        description: trimField(description),
        text: nextText,
        group: trimField(group),
        emoji: trimField(emoji).slice(0, EMOJI_MAX_LENGTH),
      };
    }
  }
  return result;
}

export function sanitizeTemplateList(raw: unknown): TemplateEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: TemplateEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const entry = normalizeEntry(item, index, seen);
    if (entry !== undefined) {
      out.push(entry);
    }
  }
  return out;
}

/** 任意来源（settings 快照 / 设置卡草稿）→ 合法的「导入允许目录」列表（纯函数）。
 *  host 的导入策略是「会话 cwd + 内置角色库 + importAllowRoots」，绝对路径默认拒绝，
 *  这里登记的每一项都是**放一个读盘口子**，故：
 *  - 非数组 → []（未设置 = 一条都不登记，不是"全放行"）；
 *  - 非字符串 / trim 后为空 → 丢弃（空串在 host 侧 path.resolve 会落到进程 cwd，
 *    绝不能让它变成一个隐式允许根）；
 *  - 去重（同一目录登记两次没有额外语义，界面上也不该出现两行）。 */
export function sanitizeAllowRoots(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const root = typeof item === "string" ? item.trim() : "";
      if (root !== "" && !out.includes(root)) {
        out.push(root);
      }
    }
  }
  return out;
}
