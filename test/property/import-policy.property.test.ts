// 路径导入策略与模板清洗的属性面：单测（test/host.test.ts、test/templates.test.ts）钉的是
// 手工枚举的形状，这一层用 fast-check 扫「任意段组合」。期望值全部来自探针实测与
// host.ts / src/templates.ts 头注写明的判据（原始段检查先于 resolve；"." 与 ".." 与
// 隐藏段一律非法；allowRoots 只收绝对形），不从实现派生。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";

import { buildOrganizeUser, clampInt, importPathError } from "../../host.ts";
import {
  sanitizeAllowRoots,
  sanitizeTemplateList,
  tryCondenseRoleBody,
} from "../../src/templates.ts";
import { HOST_MESSAGES } from "../../src/host-messages.ts";

const { zh } = HOST_MESSAGES;

/** 合法路径段：小写字母开头，不含点、斜杠、反斜杠、空白。 */
const safeSegmentArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/u);
const safeRelativeArb = fc
  .array(safeSegmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));
/** 非法段：`.` / `..` / 隐藏段（点开头）三种，判据表来自报错文案写明的那三类。 */
const illegalSegmentArb = fc.constantFrom(".", "..", ".ssh", ".hidden");
const cwdArb = fc
  .array(safeSegmentArb, { minLength: 1, maxLength: 3 })
  .map((segments) => `/${segments.join("/")}`);

describe("importPathError 的策略性质", () => {
  it("cwd 内的合法相对路径恒放行（undefined）", () => {
    fc.assert(
      fc.property(cwdArb, safeRelativeArb, (cwd, relative) => {
        assert.equal(importPathError(relative, cwd, [], zh), undefined);
      }),
    );
  });

  it("任何位置混入非法段（. / .. / 隐藏段）一律拒绝——原始串检查先于 resolve", () => {
    fc.assert(
      fc.property(
        cwdArb,
        safeRelativeArb,
        illegalSegmentArb,
        fc.integer({ min: 0, max: 4 }),
        (cwd, relative, illegal, position) => {
          const segments = relative.split("/");
          segments.splice(Math.min(position, segments.length), 0, illegal);
          assert.equal(typeof importPathError(segments.join("/"), cwd, [], zh), "string");
        },
      ),
    );
  });

  it("绝对路径：cwd 内放行，cwd 外拒绝", () => {
    fc.assert(
      fc.property(cwdArb, safeRelativeArb, (cwd, relative) => {
        assert.equal(importPathError(`${cwd}/${relative}`, cwd, [], zh), undefined);
        assert.equal(
          typeof importPathError(`${cwd}x/${relative}`, cwd, [], zh),
          "string",
          "同级前缀目录（/projx）不是 cwd 内",
        );
      }),
    );
  });

  it("登记的允许根同样可放行（无 cwd 时 allowRoots 仍生效）", () => {
    fc.assert(
      fc.property(cwdArb, safeRelativeArb, (root, relative) => {
        assert.equal(importPathError(`${root}/${relative}`, undefined, [root], zh), undefined);
        assert.equal(
          typeof importPathError(`${root}x/${relative}`, undefined, [root], zh),
          "string",
        );
      }),
    );
  });

  it("空串与缺 cwd 两档各回点名词", () => {
    fc.assert(
      fc.property(fc.constantFrom("", "   ", "\t"), (blank) => {
        assert.equal(importPathError(blank, "/tmp", [], zh), zh.emptyImportPath);
      }),
    );
    assert.equal(importPathError("a.md", undefined, [], zh), zh.relativeNeedsCwd);
  });
});

describe("clampInt 的取值域性质", () => {
  it("有限值折进 [min,max] 且为整数；非有限值回 fallback", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: 1e9 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 65, max: 200 }),
        (value, min, max) => {
          const clamped = clampInt(value, min, max, min);
          assert.ok(Number.isInteger(clamped));
          assert.ok(clamped >= min && clamped <= max);
          assert.equal(clampInt(Number.NaN, min, max, min), min);
          assert.equal(clampInt(Number.POSITIVE_INFINITY, min, max, min), min);
        },
      ),
    );
  });
});

describe("buildOrganizeUser 的围栏 defuse 性质", () => {
  /** 混入围栏标记与正文的数据文本（注入面的生成域）。 */
  const dataTextArb = fc
    .array(fc.constantFrom("正文", zh.sysDataFenceStart, zh.sysDataFenceEnd, "plain"), {
      maxLength: 4,
    })
    .map((parts) => parts.join(""));

  it("注入内容里的围栏标记被换成名（[fence-open]/[fence-close]），输出围栏数 == 提供的字段数", () => {
    fc.assert(
      fc.property(
        fc.option(dataTextArb, { nil: undefined }),
        fc.option(dataTextArb, { nil: undefined }),
        (summary, roleText) => {
          const input: { cwd: string; entriesSummary?: string; roleText?: string } = {
            cwd: "/tmp/proj",
          };
          if (summary !== undefined) {
            input.entriesSummary = summary;
          }
          if (roleText !== undefined) {
            input.roleText = roleText;
          }
          const output = buildOrganizeUser("PROMPT", input, zh);
          const expectedFences =
            (summary !== undefined && summary !== "" ? 1 : 0) +
            (roleText !== undefined && roleText !== "" ? 1 : 0);
          const starts = output.split(zh.sysDataFenceStart).length - 1;
          assert.equal(starts, expectedFences, JSON.stringify({ summary, roleText, output }));
          // 替换形态只由「内容确含标记」决定：干净的正文有围栏块也没有 [fence-open]。
          const hasSubstitute = output.includes("[fence-open]") || output.includes("[fence-close]");
          const injectsMarker = (text: string | undefined): boolean =>
            text !== undefined &&
            (text.includes(zh.sysDataFenceStart) || text.includes(zh.sysDataFenceEnd));
          assert.equal(hasSubstitute, injectsMarker(summary) || injectsMarker(roleText));
        },
      ),
    );
  });

  it("三个字段都缺席时输出就是 prompt 本身", () => {
    assert.equal(buildOrganizeUser("PROMPT", { cwd: "/tmp/proj" }, zh), "PROMPT");
  });
});

/** 模板卡的任意输入条目（settings 快照的可能形状）。 */
const junkRecordArb = fc.record(
  {
    id: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
    name: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
    text: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  },
  { requiredKeys: [] },
);
/** 任意 JSON 兼容值（模板卡 settings 快照的可能形状）。 */
const junkEntryArb = fc.oneof(fc.constant(null), fc.integer(), fc.string(), junkRecordArb);
/** 探针实测的三个绝对形与一个盘符相对形（client 半的形状判据锚点）。 */
const absoluteShapes = ["/abs", String.raw`C:\win`, "//h/s"];
const driveRelative = "C:rel";

/** 非数组的任意 JSON 值（非数组输入恒回空表的那一支）。 */
const nonArrayArb = fc.oneof(
  fc.integer(),
  fc.string(),
  fc.constant({}),
  fc.constant(null),
  fc.boolean(),
);
/** allowRoots 候选：三种绝对形生成器 + 相对/空白负例。 */
const allowRootCandidateArb = fc.oneof(
  fc.stringMatching(/^\/[a-z0-9][a-z0-9/]{0,10}$/u),
  fc.stringMatching(/^\\\\[a-z][a-z0-9]{0,5}\\[a-z]{1,5}$/u),
  fc.constant(driveRelative),
  fc.constant("rel/path"),
  fc.constant(""),
  fc.constant("   "),
);

describe("sanitizeTemplateList 的清洗性质", () => {
  /** 任意 JSON 兼容值（模板卡 settings 快照的可能形状）。 */
  it("幂等：sanitize(sanitize(x)) 与 sanitize(x) 逐字段相等", () => {
    fc.assert(
      fc.property(fc.array(junkEntryArb, { maxLength: 6 }), (raw) => {
        const once = sanitizeTemplateList(raw);
        assert.deepEqual(sanitizeTemplateList(once), once);
      }),
    );
  });

  it("不修改输入；产出的 id 全局唯一", () => {
    fc.assert(
      fc.property(fc.array(junkEntryArb, { maxLength: 6 }), (raw) => {
        const snapshot = JSON.stringify(raw);
        const cleaned = sanitizeTemplateList(raw);
        assert.equal(JSON.stringify(raw), snapshot, "输入被改写");
        const ids = cleaned.map((entry) => entry.id);
        assert.equal(new Set(ids).size, ids.length, JSON.stringify(ids));
      }),
    );
  });

  it("非数组输入恒回空表", () => {
    fc.assert(
      fc.property(nonArrayArb, (raw) => {
        assert.deepEqual(sanitizeTemplateList(raw), []);
      }),
    );
  });
});

describe("sanitizeAllowRoots 的绝对形状判据", () => {
  it("保留项必是绝对形（POSIX 根 / win 盘符带分隔 / UNC）；相对与空串一律丢弃", () => {
    fc.assert(
      fc.property(allowRootCandidateArb, (candidate) => {
        const kept = sanitizeAllowRoots([candidate]);
        for (const root of kept) {
          assert.ok(
            root.startsWith("/") ||
              /^[A-Za-z]:[/\\]/u.test(root) ||
              root.startsWith(String.raw`\\`),
            `非绝对形被保留：${root}`,
          );
        }
      }),
    );
  });

  it("探针实测的三种绝对形都保留，盘符相对（C:rel）被丢弃（client 半无 node:path 的形状判据）", () => {
    assert.deepEqual(
      sanitizeAllowRoots([...absoluteShapes, driveRelative, "rel", ""]),
      absoluteShapes,
    );
  });
});

describe("tryCondenseRoleBody 的围栏判据", () => {
  it("CRLF 正文与 LF 正文同判：无围栏时未闭合标记缺席", () => {
    fc.assert(
      fc.property(safeRelativeArb, (line) => {
        assert.equal(tryCondenseRoleBody(`${line}\r\n${line}`).unclosedFenceLine, undefined);
        assert.equal(tryCondenseRoleBody(`${line}\n${line}`).unclosedFenceLine, undefined);
      }),
    );
  });

  it("开围栏没有闭围栏：交回开栏行号（探针实测第 2 行）", () => {
    const unclosedCrlf = tryCondenseRoleBody("body\r\n```code\r\ntail");
    assert.equal(unclosedCrlf.unclosedFenceLine, 2);
    const unclosedLf = tryCondenseRoleBody("body\n```code\ntail");
    assert.equal(unclosedLf.unclosedFenceLine, 2);
  });
});
