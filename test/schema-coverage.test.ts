// test/schema-coverage.test.ts —— 卡片字段覆盖门禁自身的回归。
//
// 这个门禁的失效方式是「静默缩小范围」：解析器少认一种写法、扫描漏一类文件、豁免表写错字段名，
// 结果都是「零问题」，与「真的都覆盖了」无法区分。所以这里的用例全部造**替身包目录**，
// 直接驱动 schemaCoverageProblems，断言它在各种畸形输入下仍然报出问题项。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { schemaCoverageProblems } from "./schema-coverage.ts";

const PKG_NAME = "@fixture/pkg";

const SINGLE_LINE_SCHEMA = "const configSchema = Schema.object({ alpha: 1 });\n";

interface Fixture {
  readonly pkgDir: string;
  readonly cleanup: () => Promise<void>;
}

/** 两字段 host schema：重复出现在多条豁免表用例里，单点定义避免字面量漂移。 */
const TWO_FIELD_SCHEMA = "const configSchema = Schema.object({ alpha: 1, beta: 2 });\n";

const made: Fixture[] = [];

/** 造一个替身包：`files` 的键是相对包根的路径，值是要写进去的文本。 */
async function fixtureOf(files: Record<string, string>): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "sc-"));
  const pkgDir = path.join(root, "pkg");
  // 先登记再落盘：下面的 writeFile / mkdir 抛错时 afterEach 仍能删掉这个 root。
  const fixture: Fixture = {
    pkgDir,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
  made.push(fixture);
  await Promise.all(
    Object.entries(files).map(async ([relative, text]) => {
      const target = path.join(pkgDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }),
  );
  await mkdir(path.join(pkgDir, "test"), { recursive: true });
  return fixture;
}

/** 门禁的入口需要一个 `test/…` 下的文件 URL——它靠 `..` 推包根。 */
function problemsOf(
  fixture: Fixture,
  opts?: { allowUnbound?: { field: string; reason: string }[] },
): string[] {
  const testFile = path.join(fixture.pkgDir, "test", "fake.test.ts");
  return schemaCoverageProblems(pathToFileURL(testFile).href, opts);
}

/** 卡片侧把每个字段都写上写入调用（门禁的「已绑定」来源）。 */
function clientSourceOf(fields: readonly string[]): string {
  return `export const write = (set: (k: string, v: unknown) => void): void => {\n${fields
    .map((field) => `  set("${field}", 1);`)
    .join("\n")}\n};\n`;
}

describe("schemaCoverageProblems：门禁自身的失效方式", () => {
  // 夹具目录统一挂在一条顶层 hook 上：外层 describe 存在，hook 才符合
  // `vitest/require-top-level-describe`；内层 describe 照常分组。
  afterEach(async () => {
    await Promise.all(made.splice(0).map((fixture) => fixture.cleanup()));
  });

  describe("schemaCoverageProblems：设置 schema 的两种写法都要认", () => {
    it("实参是标识符时回溯到同名 const 字面量（本仓 host.ts 的形态）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts":
          "const configShape = { alpha: 1, beta: 2 };\nconst configSchema = Schema.object(configShape);\n",
        "src/x.ts": clientSourceOf(["alpha", "beta"]),
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("单行字面量写法也要取到全部字段（旧实现按行首两空格缩进取，一个都取不到）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": TWO_FIELD_SCHEMA,
        "src/x.ts": clientSourceOf(["alpha", "beta"]),
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("嵌套对象的键不算顶层键（深度不是 0 就不认）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object({\n  alpha: { inner: 1 },\n});\n",
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture);
      assert.deepEqual(problems, []);
    });
  });
  describe("schemaCoverageProblems：花括号只数代码里的，字面量里的不算", () => {
    // 这两条都靠「gamma 必须进 hostFields」来判：gamma 若被截掉，指向它的豁免就会报
    // 「指向了 host schema 里不存在的字段」——门禁静默缩小范围正是这么被看出来的。
    const GAMMA_EXEMPTION = [{ field: "gamma", reason: "仅用于本用例" }];

    it("字段值里出现右花括号不提前收尾", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts":
          'const configShape = {\n  alpha: 1,\n  beta: Schema.string().default("}"),\n  gamma: 3,\n};\nconst configSchema = Schema.object(configShape);\n',
        "src/x.ts": clientSourceOf(["alpha", "beta"]),
      });
      assert.deepEqual(problemsOf(fixture, { allowUnbound: GAMMA_EXEMPTION }), []);
    });

    it("注释里的右花括号同样不算收尾", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts":
          "const configShape = {\n  // 说明 }\n  alpha: 1,\n  beta: 2,\n  gamma: 3,\n};\nconst configSchema = Schema.object(configShape);\n",
        "src/x.ts": clientSourceOf(["alpha", "beta"]),
      });
      assert.deepEqual(problemsOf(fixture, { allowUnbound: GAMMA_EXEMPTION }), []);
    });
  });

  describe("schemaCoverageProblems：client 侧的收集范围", () => {
    it("卡片是 .tsx 时也扫得到（旧实现只收 .ts，会把所有字段判成未暴露）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/card.tsx":
          'export const Card = (): unknown => <div field={"alpha"} />;\nset("alpha", 1);\n',
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("被注释掉的写入调用不算已绑定（否则卡片没控件也过门禁）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/x.ts": 'export const write = (): void => {\n  // set("alpha", 1);\n};\n',
      });
      const problems = problemsOf(fixture);
      assert.ok(
        problems.some((problem) => problem.includes("卡片未暴露") && problem.includes("alpha")),
        `注释里的 set 被当成了绑定：${problems.join(" / ")}`,
      );
    });

    it("注释里的 field: 'x' 不算已绑定", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/x.ts": 'export const card = {\n  /* field: "alpha" */\n};\n',
      });
      const problems = problemsOf(fixture);
      assert.ok(problems.some((problem) => problem.includes("alpha")));
    });
  });

  describe("schemaCoverageProblems：读不到东西时交回问题而不是抛", () => {
    it("包根没有 host.ts", async () => {
      const fixture = await fixtureOf({ "package.json": JSON.stringify({ name: PKG_NAME }) });
      const problems = problemsOf(fixture);
      assert.ok(
        problems.some((problem) => problem.includes("读不到") && problem.includes("host.ts")),
      );
    });

    it("包根没有 package.json", async () => {
      const fixture = await fixtureOf({ "host.ts": "const s = Schema.object({ alpha: 1 });\n" });
      const problems = problemsOf(fixture);
      assert.ok(problems.some((problem) => problem.includes("package.json")));
    });

    it("一处 Schema.object 块都解析不出来时点名它，而不是照绿", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object(buildShape());\n",
        "src/x.ts": "",
      });
      const problems = problemsOf(fixture);
      assert.ok(
        problems.some((problem) => problem.includes("解析不出")),
        `解析失败没有被点名：${problems.join(" / ")}`,
      );
    });
  });

  describe("schemaCoverageProblems：豁免表要能自己查账", () => {
    it("指向不存在的字段也算问题（拼错之后豁免会静默失效）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture, {
        allowUnbound: [{ field: "alpah", reason: "拼错了" }],
      });
      assert.ok(
        problems.some((problem) => problem.includes("不存在") && problem.includes("alpah")),
      );
    });

    it("重复条目要点名（Map 会让后一条静默覆盖前一条的理由）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": TWO_FIELD_SCHEMA,
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture, {
        allowUnbound: [
          { field: "beta", reason: "第一份理由" },
          { field: "beta", reason: "第二份理由" },
        ],
      });
      assert.ok(
        problems.some((problem) => problem.includes("重复") && problem.includes("beta")),
        "重复条目要同时点名具体字段，否则 Map 覆盖回归仍会漏判",
      );
    });

    it("已绑定的字段还挂在豁免表上 → 点名「已过时」（挂名豁免不能绕过门禁）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object({ alpha: 1 });\n",
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture, {
        allowUnbound: [{ field: "alpha", reason: "以为是漏项" }],
      });
      assert.ok(
        problems.some((problem) => problem.includes("已过时") && problem.includes("alpha")),
        `已绑定字段的豁免应被点名：${problems.join(" / ")}`,
      );
    });

    it("豁免项缺 reason → 点名该字段（空理由不构成豁免）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": TWO_FIELD_SCHEMA,
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture, {
        allowUnbound: [{ field: "beta", reason: "" }],
      });
      assert.ok(
        problems.some((problem) => problem.includes("缺少 reason") && problem.includes("beta")),
        `空 reason 的豁免应被点名：${problems.join(" / ")}`,
      );
    });
  });

  describe("schemaCoverageProblems：解析器的边界（正则、三元、空 schema、JSX prop）", () => {
    it("正则字面量里的引号不把后续代码带进字符串（注释掉的写入仍然不算绑定）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/x.ts":
          'const re = /["\u0027]/u;\nexport const write = (): void => {\n  // set("alpha", 1);\n};\n',
      });
      const problems = problemsOf(fixture);
      assert.ok(
        problems.some((problem) => problem.includes("alpha")),
        `正则里的引号让注释段被当成代码，门禁假绿：${problems.join(" / ")}`,
      );
    });

    it("三元表达式的冒号不被当成顶层键（否则报一条虚构的「未暴露」）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object({ alpha: cond ? beta : gamma });\n",
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      const problems = problemsOf(fixture, { allowUnbound: [{ field: "beta", reason: "探针" }] });
      assert.ok(
        problems.some((problem) => problem.includes("不存在") && problem.includes("beta")),
        `三元分支被收成了 host 字段：${problems.join(" / ")}`,
      );
    });

    it("合法的空 schema 不报「解析不出来」", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object({});\n",
        "src/x.ts": "",
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("字面量带 as const 尾巴时仍取得到字段", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": "const configSchema = Schema.object({ alpha: 1 } as const);\n",
        "src/x.ts": clientSourceOf(["alpha"]),
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("jsx 传参也算已绑定（只认冒号会漏掉全部 JSX 写法）", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        "src/card.tsx": 'export const Card = (): unknown => <Input field="alpha" />;\n',
      });
      assert.deepEqual(problemsOf(fixture), []);
    });

    it("扫描面读不动时点名路径，而不是静默缩小范围", async () => {
      const fixture = await fixtureOf({
        "package.json": JSON.stringify({ name: PKG_NAME }),
        "host.ts": SINGLE_LINE_SCHEMA,
        src: "这不是目录，是文件：readdirSync 会 ENOTDIR\n",
      });
      const problems = problemsOf(fixture);
      assert.ok(
        problems.some((problem) => problem.includes("扫描面不完整")),
        `扫描面缩小没有被点名：${problems.join(" / ")}`,
      );
    });
  });
});
