#!/usr/bin/env node
/// <reference types="node" />
// 构建 types/：先让 tsc 出声明，再把声明里的相对说明符从源码后缀改写成产物后缀。
//
// 为什么需要后处理：`host.ts` 按 NodeNext 约定写 `./src/templates.ts` 这种显式 `.ts` 后缀
// （base tsconfig 的 allowImportingTsExtensions + verbatimModuleSyntax 都要求它），而 tsc 的
// **声明**产物会把这个说明符原样抄进 .d.ts——于是 `types/host.d.ts` 里留着
// `from "./src/templates.ts"`，而包里根本没有那个文件（只有 `types/src/templates.d.ts`）。
// `rewriteRelativeImportExtensions` 救不了：它只作用于 JS 产物，不动声明。
//
// 改成 `./src/templates.js` 才是对的：TypeScript 把 `.js` 说明符解析到同名 `.d.ts`，于是
// 消费方解析 `types/src/templates.d.ts`，正是本包发出去的那份。
//
// 顶部 node reference：oxlint 类型检查对 .mjs 不自动加载 @types/node，需显式声明才能解析
// node:fs/promises、node:child_process、process（否则整文件按 error 类型误报 unsafe）。
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const outDir = path.join(root, "types");

/**
 * 只改写相对说明符（以 `./` 或 `../` 开头）里的 `.ts` 后缀。
 *
 * 裸说明符（`node:http`、`@deepseek-ai/…`）一概不碰：包名段里出现 `.ts` 的形状不存在，
 * 而放宽到任意说明符会误伤 `import("some-pkg.ts")` 这类合法的第三方引用。
 * 命中的形态有三处，`import type … from`、`export … from` 与内联的 `import("…")` 类型。
 */
const RELATIVE_SOURCE_SPECIFIER = /(?<quote>["'])(?<prefix>\.{1,2}\/[^"']*)\.ts\k<quote>/gu;

/**
 * 把一段声明正文里的相对 `.ts` 说明符改写成 `.js`。
 *
 * @param {string} text - 声明文件正文
 * @returns {string} 改写后的正文
 */
export function canonicalizeDeclarationSpecifiers(text) {
  return text.replace(
    RELATIVE_SOURCE_SPECIFIER,
    (_match, quote, prefix) => `${quote}${prefix}.js${quote}`,
  );
}

/**
 * 跑一条命令；失败时抛出的信息取子进程自己的 stderr，而不是包装层的壳。
 *
 * 用同步版而不是回调/promise 版：这是构建步骤，阻塞等 tsc 跑完完全够用，而异步包装在这里
 * 只会为了一个用不上的并发度引入回调与 Promise 两种形态。
 *
 * @param {string} file - 可执行文件
 * @param {string[]} args - 参数
 * @returns {void}
 */
function run(file, args) {
  try {
    execFileSync(file, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? error.stderr : "";
    const detail = typeof stderr === "string" ? stderr.trim() : "";
    throw new Error(detail === "" ? String(error) : detail, { cause: error });
  }
}

/**
 * 递归列出 `types/` 下的声明文件（相对包根、`/` 分隔）。
 *
 * 文件与目录分成两支再汇总：混在一个 map 里时，只有文件的那一支会变成一个没有 `await`
 * 的 `async` 回调；拆开后两支各自理由完整。
 *
 * @param {string} dir - 当前目录绝对路径
 * @param {string} prefix - 相对包根前缀
 * @returns {Promise<string[]>} 命中的文件清单
 */
async function listDeclarations(dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".d.ts"))
    .map((entry) => `${prefix}${entry.name}`);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => listDeclarations(path.join(dir, entry.name), `${prefix}${entry.name}/`)),
  );
  return [...files, ...nested.flat()];
}

/**
 * 产出 types/：跑 tsc 出声明，再逐个改写相对说明符。
 *
 * @returns {Promise<string[]>} 改写过的声明文件清单（相对包根）
 */
export async function buildTypes() {
  // 先清空：tsc 不清 outDir，留着旧声明等于把陈旧（可能已无对应源码的）类型一起发出去。
  await rm(outDir, { recursive: true, force: true });
  // tsc 自己已经按 tsconfig 排好了依赖与增量，交给它报错即可；这里只把失败原样抛出。
  //
  // 直接跑本地 tsc 的入口 JS，不经 `npx`：Windows 上 `npx` 实际是 `npx.cmd`，而
  // `execFileSync` 不按 PATHEXT 解析（`shell` 默认 false），于是这条调用在 Windows
  // runner 上一律 `spawnSync npx ENOENT`——构建在 `build:types` 这一步必红，与代码无关。
  // 用 `process.execPath` 跑同一个入口文件，则不依赖任何 shell 与扩展名。
  run(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.types.json",
  ]);
  const files = await listDeclarations(outDir, "");
  await Promise.all(
    files.map(async (file) => {
      const full = path.join(outDir, file);
      const text = await readFile(full, "utf8");
      await writeFile(full, canonicalizeDeclarationSpecifiers(text), "utf8");
    }),
  );
  return files;
}

async function main() {
  const files = await buildTypes();
  console.info("types/ written:", files.length, "files");
}

/**
 * 直跑守卫：argv[1] 可能缺席或是软链路径，两边折成 realpath 再比。
 * @returns {boolean}
 */
function invokedDirectly() {
  const entry = process.argv.at(1);
  if (entry === undefined || entry.length === 0) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
