// test/oxlint-prefixes.test.ts —— oxlint.config.ts 的 titlePrefixes 与 test/ 标题的双向守卫。
//
// 名单是手工镜像：用例标题以大写开头的术语/组件名靠它放行（vitest/prefer-lowercase-title）。
// 没有这道比对时，重命名组件或删改用例会让条目静默失效、新标题则要到 lint 阶段才以
// 难定位的方式报错。扫描面与 shared 基线的用例文件 override 同形状（*.test.ts(x) 与
// test/**、__tests__/** 下的 *.spec.ts），标题抽取只认字面量实参（模板串以 `${` 开头的
// 视为小写起步，不进比对）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = path.join(import.meta.dirname, "..");

const SKIP_DIRS = new Set(["node_modules", "coverage", "agents", "types", "dist", ".git"]);

/** 与 shared 基线 TEST_FILE_OVERRIDES 的 files 面同形状的判断（目录约定在此展开）。 */
function isCaseFile(relPosix: string): boolean {
  return (
    /(?:^|\/)[^/]*\.test\.tsx?$/u.test(relPosix) ||
    /(?:^|\/)__tests__\/[^/]*\.spec\.ts$/u.test(relPosix) ||
    /(?:^|\/)test\/[^/]*\.spec\.ts$/u.test(relPosix)
  );
}

/** 与 shared 基线只收裸标识符的口径一致：名单条目必须是合法标识符形状。 */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** 用例标题的字面量形态：双引号 / 单引号 / 反引号（each 的参数列表不在捕获范围）。
 *  捕获整个带引号字面量，引号在消费侧剥掉。 */
const TITLE_CALL =
  /\b(?:describe|it|test)(?:\.each)?(?:<[^>]*>)?\s*\(\s*(?<literal>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/gu;

/** 标题里第一个大写起头的标识符形 run（术语、组件名或常量名）；没有则 undefined。 */
function leadingUppercaseRun(title: string): string | undefined {
  const match = /^[A-Z][\w$]*/u.exec(title);
  return match?.[0];
}

/** 递归收集用例文件（相对包根、`/` 分隔）。每个条目一个 promise 再一起等：收集的是
 *  文件名集合，先返回谁都一样。 */
async function collectCaseFiles(dir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        return SKIP_DIRS.has(entry.name) ? [] : collectCaseFiles(path.join(dir, entry.name), rel);
      }
      return entry.isFile() && isCaseFile(rel) ? [rel] : [];
    }),
  );
  return nested.flat();
}

async function titlePrefixesInConfig(): Promise<string[]> {
  const source = await readFile(path.join(pkgDir, "oxlint.config.ts"), "utf8");
  const block = /titlePrefixes:\s*\[(?<block>[^\]]*)\]/u.exec(source);
  expect(block, "oxlint.config.ts 里应有 titlePrefixes 数组").not.toBeNull();
  const blockText = block?.groups?.["block"] ?? "";
  const names = Array.from(
    blockText.matchAll(/"(?<name>[^"]*)"/gu),
    (match) => match.groups?.["name"],
  ).filter((name): name is string => name !== undefined);
  return names;
}

async function titlePrefixesInTitles(): Promise<Set<string>> {
  const files = await collectCaseFiles(pkgDir, "");
  expect(files.length, "扫描面不该是空的：用例文件一个都没找到").toBeGreaterThan(0);
  const sources = await Promise.all(
    files.map(async (rel) => ({ rel, text: await readFile(path.join(pkgDir, rel), "utf8") })),
  );
  const prefixes = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(TITLE_CALL)) {
      const literal = match.groups?.["literal"] ?? "";
      const title = literal.slice(1, -1);
      const prefix = leadingUppercaseRun(title);
      if (prefix !== undefined) {
        prefixes.add(prefix);
      }
    }
  }
  return prefixes;
}

describe("titlePrefixes 与用例标题互为镜像", () => {
  it("名单里没有失效条目：每一项都是某个用例标题的开头", async () => {
    const [configured, inTitles] = [await titlePrefixesInConfig(), await titlePrefixesInTitles()];
    const dead = configured.filter((name) => !inTitles.has(name));
    expect(
      dead,
      `名单里这些条目已无对应标题，应删除或改回实体名：${dead.join("、")}`,
    ).toStrictEqual([]);
  });

  it("名单没有缺漏：每个大写起头的标题 run 都已登记", async () => {
    const [configured, inTitles] = [await titlePrefixesInConfig(), await titlePrefixesInTitles()];
    const missing = [...inTitles].filter((name) => !configured.includes(name));
    expect(
      missing,
      `这些标题前缀不在 titlePrefixes 里，oxlint 会判红；确认是术语后加进名单：${missing.join("、")}`,
    ).toStrictEqual([]);
  });

  it("名单条目都是裸标识符（shared 基线对通配/带点/带空格的条目直接抛错）", async () => {
    const configured = await titlePrefixesInConfig();
    const illegal = configured.filter((name) => !BARE_IDENTIFIER.test(name));
    expect(illegal, `这些条目不是裸标识符：${illegal.join("、")}`).toStrictEqual([]);
    expect(new Set(configured).size, "名单里有重复条目").toBe(configured.length);
  });
});
