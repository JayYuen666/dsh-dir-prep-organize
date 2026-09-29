// dir-prep-organize 模板功能单测（vitest，node 环境）。
// 契约：
//   DEFAULT_TEMPLATES     20 条内置模板（8 通用 + 12 精选角色），id 唯一、
//                         name/text 非空、description/group/emoji 可空字符串、
//                         正文不含反引号（插入输入框不破坏 markdown 围栏）
//   sanitizeTemplateList  设置快照/设置卡来的任意值 → 合法 TemplateEntry[]
//                        （剔坏条目 / trim / 缺失或重复 id 确定性补齐，不改输入）
//   sanitizeAllowRoots    任意值 → 合法「导入允许目录」列表（非数组=空表；剔空白与
//                        非字符串项；去重）——host 导入策略的第三类允许根
//   parseAgentFrontmatter agency-agents-zh 风格角色文件 → {name,description,emoji,body}
//   condenseRoleBody      角色正文提炼：去代码围栏与行内反引号、不设字符上限（全量）
//   groupLabelOf          仓库目录名 → 中文分组标签
//   mergeImportedTemplates 导入并入草稿的 id 碰撞改写（不改输入）
//   applyTemplateToDraft  空草稿整段填入；非空 trimEnd 后空两行追加，不覆盖已写内容

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  condenseRoleBody,
  DEFAULT_TEMPLATES,
  groupLabelOf,
  mergeImportedTemplates,
  parseAgentFrontmatter,
  sanitizeAllowRoots,
  sanitizeTemplateList,
} from "../src/templates.ts";
import { AGENT_DIR_GROUP_LABELS } from "../src/group-labels.generated.ts";
import type { TemplateEntry } from "../src/templates.ts";
import { applyTemplateToDraft } from "../src/client-entry.ts";

/** 插件根目录（agents/ 与 src/ 的父目录，供「默认与真实文件一致」锁使用）。 */
const PLUGIN_DIR = path.dirname(import.meta.dirname);

function fullEntry(
  over: Partial<TemplateEntry> & { id: string; name: string; text: string },
): TemplateEntry {
  return { description: "", group: "", emoji: "", ...over };
}

// ── DEFAULT_TEMPLATES ──────────────────────────────────────────────────────

describe("内置 DEFAULT_TEMPLATES", () => {
  it("精选集：≥40 条、id 唯一、字段齐全且正文非空（无通用分组）", () => {
    assert.ok(
      DEFAULT_TEMPLATES.length >= 40,
      `精选数量 ≥40，实际 ${String(DEFAULT_TEMPLATES.length)}`,
    );
    const ids = new Set(DEFAULT_TEMPLATES.map((entry) => entry.id));
    assert.equal(ids.size, DEFAULT_TEMPLATES.length, "id 必须唯一");
    for (const entry of DEFAULT_TEMPLATES) {
      assert.ok(entry.name.trim().length > 0, `${entry.id} name 非空`);
      assert.ok(entry.text.trim().length > 0, `${entry.id} text 非空`);
      assert.ok(typeof entry.description === "string", `${entry.id} description 为 string`);
      assert.ok(entry.group.trim().length > 0, `${entry.id} group 非空（部门标签）`);
      assert.ok(typeof entry.emoji === "string", `${entry.id} emoji 为 string`);
    }
  });

  it("精选角色存在性抽查（独立开发者高频角色均在默认集）", () => {
    const ids = new Set(DEFAULT_TEMPLATES.map((entry) => entry.id));
    for (const id of [
      "engineering-frontend-developer",
      "engineering-backend-architect",
      "engineering-software-architect",
      "engineering-code-reviewer",
      "engineering-security-engineer",
      "engineering-dingtalk-integration-developer",
      "engineering-network-engineer-china",
      "design-ui-designer",
      "product-manager",
      "chief-technology-officer",
      "project-manager-senior",
      "testing-api-tester",
      "marketing-xiaohongshu-operator",
      "marketing-douyin-strategist",
      "marketing-weixin-channels-strategist",
      "marketing-bilibili-strategist",
      "finance-financial-analyst",
      "security-penetration-tester",
      "specialized-mcp-builder",
      "agents-orchestrator",
    ]) {
      assert.ok(ids.has(id), `精选默认应含 ${id}`);
    }
  });

  it("与内置真实角色文件一致（漂移锁：采样解析+提炼后逐字段比对）", async () => {
    const samples = [
      "engineering/engineering-frontend-developer.md",
      "engineering/engineering-security-engineer.md",
      "design/design-ui-designer.md",
      "marketing/marketing-xiaohongshu-operator.md",
      "testing/testing-api-tester.md",
      "finance/finance-financial-analyst.md",
    ];
    const parsed = await Promise.all(
      samples.map(async (rel) => {
        const raw = await readFile(path.join(PLUGIN_DIR, "agents", rel), "utf8");
        return { rel, info: parseAgentFrontmatter(raw) };
      }),
    );
    for (const { rel, info } of parsed) {
      const slug = path.basename(rel, ".md");
      assert.notEqual(info, undefined, `${rel} 应可解析`);
      const entry = DEFAULT_TEMPLATES.find((item) => item.id === slug);
      assert.notEqual(entry, undefined, `${slug} 应在默认集中`);
      const condensed = condenseRoleBody(info!.body);
      const sourceGroup = groupLabelOf(path.basename(path.dirname(rel)));
      assert.equal(entry!.name, info!.name, `${slug} name 与源一致`);
      assert.equal(entry!.description, info!.description, `${slug} description 与源一致`);
      assert.equal(entry!.emoji, info!.emoji, `${slug} emoji 与源一致`);
      assert.equal(entry!.group, sourceGroup, `${slug} group 与源目录一致`);
      assert.equal(entry!.text, condensed, `${slug} 提炼正文与源一致（生成脚本漂移会在此红）`);
    }
  });

  it("默认集覆盖多部门分组（分组下拉可用）", () => {
    const groups = new Set(DEFAULT_TEMPLATES.map((entry) => entry.group));
    for (const group of ["工程", "设计", "产品", "公司经营", "项目管理", "测试", "营销", "金融"]) {
      assert.ok(groups.has(group), `应包含分组 ${group}`);
    }
  });

  it("正文不含反引号（插入输入框后不破坏 markdown 围栏）", () => {
    for (const entry of DEFAULT_TEMPLATES) {
      assert.ok(!entry.text.includes("`"), `${entry.id} 正文不应含反引号`);
    }
  });
});

// ── sanitizeTemplateList ───────────────────────────────────────────────────

describe("sanitizeTemplateList", () => {
  it("完整字段列表原样通过（保序、字段不变）", () => {
    const input: TemplateEntry[] = [
      fullEntry({
        id: "a",
        name: "甲",
        description: "说明一",
        text: "正文一",
        group: "工程",
        emoji: "💻",
      }),
      fullEntry({ id: "b", name: "乙", text: "正文二" }),
    ];
    const out = sanitizeTemplateList(input);
    assert.deepEqual(out, input);
  });

  it("非数组输入 → 空列表", () => {
    assert.deepEqual(sanitizeTemplateList(undefined), []);
    assert.deepEqual(sanitizeTemplateList(null), []);
    assert.deepEqual(sanitizeTemplateList("nope"), []);
    assert.deepEqual(sanitizeTemplateList({ id: "x" }), []);
  });

  it("剔除坏条目：非对象 / 数组 / 缺 name / 缺 text", () => {
    const out = sanitizeTemplateList([
      null,
      "str",
      42,
      [],
      { name: "无正文" },
      { text: "无名称" },
      { id: "ok", name: "好条目", text: "正文" },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], fullEntry({ id: "ok", name: "好条目", text: "正文" }));
  });

  it("name/text/description/group 先 trim；trim 后为空的条目剔除；emoji 截断 12 字符", () => {
    const out = sanitizeTemplateList([
      {
        id: "a",
        name: "  甲  ",
        description: " 说明一 ",
        text: " 正文 \n",
        group: " 工程 ",
        // 14 个码点 → trim 后截断为 12
        emoji: "😀😀😀😀😀😀😀",
      },
      { id: "b", name: "   ", text: "正文" },
      { id: "c", name: "名称", text: "   " },
      {
        id: "d",
        name: "乙",
        description: undefined,
        group: undefined,
        emoji: undefined,
        text: "正文二",
      },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      id: "a",
      name: "甲",
      description: "说明一",
      text: "正文",
      group: "工程",
      emoji: "😀😀😀😀😀😀",
    });
    assert.deepEqual(out[1], {
      id: "d",
      name: "乙",
      description: "",
      text: "正文二",
      group: "",
      emoji: "",
    });
  });

  it("缺失 id → 确定性补 tpl-<index>", () => {
    const out = sanitizeTemplateList([
      { name: "甲", text: "一" },
      { name: "乙", text: "二" },
    ]);
    assert.equal(out[0]!.id, "tpl-0");
    assert.equal(out[1]!.id, "tpl-1");
  });

  it("重复 id → 后者确定性改写，不碰撞", () => {
    const out = sanitizeTemplateList([
      fullEntry({ id: "dup", name: "甲", text: "一" }),
      fullEntry({ id: "dup", name: "乙", text: "二" }),
    ]);
    assert.equal(out[0]!.id, "dup");
    assert.notEqual(out[1]!.id, "dup");
    assert.equal(new Set(out.map((entry) => entry.id)).size, out.length, "输出 id 必须唯一");
  });

  it("补 id 与既有 id 撞名时继续改写直到唯一", () => {
    const out = sanitizeTemplateList([
      fullEntry({ id: "tpl-1", name: "甲", text: "一" }),
      { name: "乙", text: "二" },
    ]);
    assert.equal(out[0]!.id, "tpl-1");
    assert.notEqual(out[1]!.id, "tpl-1");
    assert.equal(new Set(out.map((entry) => entry.id)).size, 2);
  });

  it("空数组输入 → 空列表（用户显式删光 = 合法状态）", () => {
    assert.deepEqual(sanitizeTemplateList([]), []);
  });

  it("不修改输入（深比较输入快照）", () => {
    const input: unknown[] = [
      fullEntry({ id: "a", name: " 甲 ", text: "x" }),
      { name: "乙", text: "y" },
    ];
    const snapshot = structuredClone(input);
    sanitizeTemplateList(input);
    assert.deepEqual(input, snapshot);
  });
});

// ── parseAgentFrontmatter ──────────────────────────────────────────────────

describe("parseAgentFrontmatter", () => {
  const sample = [
    "---",
    "name: 安全工程师",
    'description: "威胁建模与代码审计"',
    "emoji: 🔒",
    "color: red",
    "---",
    "",
    "# 安全工程师",
    "",
    "你是安全工程师，专业应用安全工程师。",
  ].join("\n");

  it("标准 frontmatter → name/description/emoji/body", () => {
    const info = parseAgentFrontmatter(sample);
    assert.notEqual(info, undefined);
    assert.equal(info!.name, "安全工程师");
    assert.equal(info!.description, "威胁建模与代码审计");
    assert.equal(info!.emoji, "🔒");
    assert.ok(info!.body.includes("你是安全工程师"));
    assert.ok(!info!.body.includes("---"), "body 不含 frontmatter 围栏");
  });

  it("无 frontmatter（非角色文件）→ undefined", () => {
    assert.equal(parseAgentFrontmatter("# 普通文档\n\n正文"), undefined);
    assert.equal(parseAgentFrontmatter(""), undefined);
  });

  it("缺 name 或 name 为空 → undefined（导入时跳过）", () => {
    const noName = ["---", "description: x", "---", "正文"].join("\n");
    const emptyName = ["---", "name: ", "---", "正文"].join("\n");
    assert.equal(parseAgentFrontmatter(noName), undefined);
    assert.equal(parseAgentFrontmatter(emptyName), undefined);
  });

  it("CRLF 换行与多行 description 容错（description 仅取首键值行）", () => {
    const crlf = [
      "---",
      "name: 前端开发者",
      "description: 现代 Web 专家",
      "emoji: 💻",
      "---",
      "正文行",
    ].join("\r\n");
    const info = parseAgentFrontmatter(crlf);
    assert.equal(info!.name, "前端开发者");
    assert.equal(info!.description, "现代 Web 专家");
    assert.ok(info!.body.includes("正文行"));
  });
});

describe("parseAgentFrontmatter 边角", () => {
  it("closing 围栏后没有正文（文件以 --- 结尾）→ body 为空串", () => {
    const info = parseAgentFrontmatter("---\nname: 只有前言\n---");
    assert.notEqual(info, undefined);
    assert.equal(info!.body, "");
    assert.equal(info!.name, "只有前言");
  });

  it("frontmatter 起始围栏没有闭合 → undefined（不当成正文吞掉）", () => {
    assert.equal(parseAgentFrontmatter("---\nname: 没有闭合围栏\n正文"), undefined);
  });

  it("只解析前 20 行：第 21 行的 name 不生效", () => {
    const head = [
      "---",
      ...Array.from({ length: 25 }, (_idx, idx) => `k${String(idx)}: v`),
      "name: 迟到者",
      "---",
      "正文",
    ];
    assert.equal(parseAgentFrontmatter(head.join("\n")), undefined);
  });

  it("非法键名 / 无冒号 / 冒号在行首 的行都忽略，合法键照常取", () => {
    const text = [
      "---",
      "这行没有冒号",
      ": 冒号在行首",
      "1bad: 数字开头",
      "name: 合规角色",
      "description: 带冒号: 的说明",
      "---",
      "正文",
    ].join("\n");
    const info = parseAgentFrontmatter(text);
    assert.equal(info!.name, "合规角色");
    assert.equal(info!.description, "带冒号: 的说明");
  });

  it("引号剥离：成对单/双引号去掉，不成对/单字符原样", () => {
    const info = parseAgentFrontmatter(
      ["---", "name: '单引号角色'", 'description: "双引号说明"', "emoji: 短", "---", "正文"].join(
        "\n",
      ),
    );
    assert.equal(info!.name, "单引号角色");
    assert.equal(info!.description, "双引号说明");
    assert.equal(info!.emoji, "短");
    const odd = parseAgentFrontmatter(["---", 'name: "半引号', "---", "正文"].join("\n"));
    assert.equal(odd!.name, '"半引号');
  });
});

// ── condenseRoleBody ───────────────────────────────────────────────────────

describe("condenseRoleBody", () => {
  it("短正文原样保留（trim）", () => {
    assert.equal(condenseRoleBody("  你是角色。\n  "), "你是角色。");
  });

  it("代码围栏整体剔除，正文无反引号", () => {
    const body = [
      "## 身份",
      "你是测试员。",
      "```python",
      "def f():",
      "    return 1",
      "```",
      "## 规则",
      "测试边界。",
    ].join("\n");
    const out = condenseRoleBody(body);
    assert.ok(out.includes("你是测试员。"));
    assert.ok(out.includes("测试边界。"));
    assert.ok(!out.includes("def"), "围栏内容被剔除");
    assert.ok(!out.includes("`"), "产出无反引号");
  });

  it("行内反引号剔除", () => {
    const out = condenseRoleBody("调用 `query` 需参数化");
    assert.ok(!out.includes("`"));
    assert.ok(out.includes("query"));
  });

  it("不设字符上限（用户拍板）：超长正文全量保留不截断", () => {
    const longBody = `头部引言\n${"核心规则行甲".repeat(400)}\n尾部收束`;
    const out = condenseRoleBody(longBody);
    assert.ok(out.startsWith("头部引言"), "首行保留");
    assert.ok(out.endsWith("尾部收束"), "末行保留（无截断）");
    assert.ok(out.length > 1500, `不受旧 1500 上限，实际 ${String(out.length)}`);
  });

  it("全围栏/全空白 → 空串", () => {
    assert.equal(condenseRoleBody("```\ncode\n```"), "");
    assert.equal(condenseRoleBody("   \n \t "), "");
  });
});

// ── groupLabelOf / 目录映射 ────────────────────────────────────────────────

describe("groupLabelOf", () => {
  it("已收录目录 → 中文标签", () => {
    assert.equal(groupLabelOf("engineering"), "工程");
    assert.equal(groupLabelOf("marketing"), "营销");
    assert.equal(groupLabelOf("testing"), "测试");
  });

  it("未收录目录 → 回落目录名本身", () => {
    assert.equal(groupLabelOf("my-dir"), "my-dir");
  });

  it("原型链键不再命中标签表（审计修复：constructor/__proto__ 曾返回函数与对象）", () => {
    assert.equal(groupLabelOf("constructor"), "constructor");
    assert.equal(groupLabelOf("__proto__"), "__proto__");
    assert.equal(groupLabelOf("toString"), "toString");
    // 说谎的 group 会让 JSON.stringify 静默丢键（TemplateEntry 形状被破坏）
    const entry: TemplateEntry = {
      id: "a",
      name: "甲",
      description: "",
      text: "正文",
      group: groupLabelOf("constructor"),
      emoji: "",
    };
    assert.ok(JSON.stringify(entry).includes('"group":"constructor"'), "group 序列化为字符串");
  });

  it("映射表覆盖仓库 20 部门（快照抽查）", () => {
    assert.ok(AGENT_DIR_GROUP_LABELS["company"] !== undefined);
    assert.ok(AGENT_DIR_GROUP_LABELS["product"] !== undefined);
    assert.ok(AGENT_DIR_GROUP_LABELS["project-management"] !== undefined);
  });
});

// ── mergeImportedTemplates ─────────────────────────────────────────────────

describe("mergeImportedTemplates", () => {
  it("无碰撞 → 追加保序", () => {
    const existing = [fullEntry({ id: "a", name: "甲", text: "一" })];
    const incoming = [
      fullEntry({ id: "b", name: "乙", text: "二" }),
      fullEntry({ id: "c", name: "丙", text: "三" }),
    ];
    const out = mergeImportedTemplates(existing, incoming);
    assert.deepEqual(
      out.map((entry) => entry.id),
      ["a", "b", "c"],
    );
  });

  it("id 碰撞 → 追加 -i 直到唯一；不改输入", () => {
    const existing = [fullEntry({ id: "x", name: "甲", text: "一" })];
    const incoming = [
      fullEntry({ id: "x", name: "乙", text: "二" }),
      fullEntry({ id: "x", name: "丙", text: "三" }),
      fullEntry({ id: "x-i", name: "丁", text: "四" }),
    ];
    const existingSnapshot = structuredClone(existing);
    const out = mergeImportedTemplates(existing, incoming);
    assert.equal(out.length, 4);
    assert.equal(new Set(out.map((entry) => entry.id)).size, 4, "输出 id 唯一");
    assert.equal(out[0]!.id, "x", "既有保留");
    assert.equal(out[1]!.name, "乙");
    assert.equal(out[1]!.id, "x-i", "首个碰撞改写为 x-i");
    assert.equal(out[2]!.name, "丙");
    assert.equal(out[2]!.id, "x-ii", "x-i 已占用 → while 追加单字符 i 得 x-ii");
    assert.equal(out[3]!.name, "丁");
    assert.equal(out[3]!.id, "x-i-i", "原 id 为 x-i 的条目碰撞后按 baseId 重建为 x-i-i");
    assert.deepEqual(existing, existingSnapshot, "不改输入");
  });
});

// ── applyTemplateToDraft ───────────────────────────────────────────────────

describe("applyTemplateToDraft", () => {
  const template = "模板正文第一行\n- 条目";

  it("空草稿 → 整段填入", () => {
    assert.equal(applyTemplateToDraft("", template), template);
  });

  it("纯空白草稿 → 视为空，整段填入且不带前导换行", () => {
    assert.equal(applyTemplateToDraft("   \n\t ", template), template);
  });

  it("非空草稿 → 原内容 trimEnd + 空两行追加，原内容保留", () => {
    assert.equal(applyTemplateToDraft("已写内容", template), `已写内容\n\n${template}`);
  });

  it("草稿尾随空白/空行被收敛，不产生多余空行", () => {
    assert.equal(applyTemplateToDraft("已写内容\n\n \n", template), `已写内容\n\n${template}`);
    assert.equal(applyTemplateToDraft("已写内容   ", template), `已写内容\n\n${template}`);
  });

  it("模板正文原样插入（不受草稿影响、内部换行保留）", () => {
    const out = applyTemplateToDraft("草稿", template);
    assert.ok(out.endsWith(template));
    assert.ok(out.includes("模板正文第一行\n- 条目"));
  });
});

// ── 模板正文全量（不截断契约）───────────────────────────────────────────────

describe("模板正文不设上限（用户拍板）", () => {
  it("默认精选集存在超过旧 1500 上限的长正文（证明无截断生效）", () => {
    const longest = Math.max(...DEFAULT_TEMPLATES.map((entry) => entry.text.length));
    assert.ok(
      longest > 1500,
      `至少一条精选正文超过旧上限 1500，实际最长 ${String(longest)}（截断已移除）`,
    );
  });
});

// ── sanitizeAllowRoots（导入允许目录：设置卡草稿 → 落盘列表）────────────────

/** 一条绝对路径夹具：本面只验「trim / 剔空 / 去重」的归一形状，路径语义无关。 */
const ALLOW_ROOT = "/Users/me/roles";

describe("sanitizeAllowRoots", () => {
  it("未设置 / 非数组 → 空表（空表是「一个额外口子都不给」，不是全放行）", () => {
    assert.deepEqual(sanitizeAllowRoots(undefined), []);
    assert.deepEqual(sanitizeAllowRoots(ALLOW_ROOT), []);
    assert.deepEqual(sanitizeAllowRoots({ a: 1 }), []);
  });

  it("trim + 剔空 + 去重（空串登记不得变成「允许 process.cwd()」）", () => {
    assert.deepEqual(sanitizeAllowRoots([` ${ALLOW_ROOT} `, ALLOW_ROOT, "", "   ", 42, null]), [
      ALLOW_ROOT,
    ]);
  });

  it("保持登记顺序（用户看到的顺序 = 落盘的顺序）", () => {
    assert.deepEqual(sanitizeAllowRoots(["/b", "/a"]), ["/b", "/a"]);
  });
});
