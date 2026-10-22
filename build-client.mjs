#!/usr/bin/env node
// @ts-check
// 构建 client.js：rolldown 把 src/client-entry.ts 打包为 CJS（react 外部化），
// 再包进 window.__ModuleLoader__.load({ id, factory }) 外壳（danger-guard 同款）。
// id 取 package.json 的 name，与 dsh.client 模块表键一致。
// 运行：node build-client.mjs（或 npm run build:client）。buildClient() 供测试导入。
/// <reference types="node" />
import { realpathSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { rolldown } from "rolldown";
import { canonicalizeRegionPaths } from "@jayyuen66/dsh-plugin-shared/lib/canonicalize-region-paths";

const root = import.meta.dirname;

/**
 * 对象守卫：数组与非对象都不算 Record。
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
function isRecord(raw) {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

/** 从 JSON.parse 的 unknown 投影为 Record（非对象 → 空对象兜底），避免 any 索引。
 *  @param {unknown} raw
 *  @returns {Record<string, unknown>}
 */
function asRecord(raw) {
  if (isRecord(raw)) {
    return raw;
  }
  return {};
}

/**
 * 把 `//#region` 行里的 pnpm 内容寻址段（store 目录里带「名@版_哈希」的那一层）折成
 * 普通的 `node_modules/` 一层。client 必须内联 shared（浏览器解析不了裸说明符），
 * rolldown 写下的标记因此烙着依赖版本与本机 store 哈希；不折的话同一份源码在不同
 * 机器（链接态 vs 单仓 registry 安装）会产出不同字节，并把安装布局带进发布产物。
 * 只碰行首是 `//#region` 的那些行，与 canonicalizeRegionPaths 同一口径。
 * @param {string} code
 * @returns {string}
 */
function collapseStorePaths(code) {
  return code.replaceAll(/^\/\/#region .*$/gmu, (line) =>
    line.replaceAll(/node_modules\/\.pnpm\/[^/]+\/node_modules\//gu, "node_modules/"),
  );
}

/**
 * rolldown 输出项的最小投影：单文件产物只关心这几项。
 * @typedef {{ type: string, fileName: string, code?: string, isEntry?: boolean }} OutputItem
 */

/**
 * 单文件产物只接受一个带正文的 entry chunk。
 * @param {OutputItem | undefined} item
 * @returns {item is { type: "chunk", fileName: string, code: string }}
 */
function isEntryChunk(item) {
  return item?.type === "chunk" && item.isEntry === true && typeof item.code === "string";
}

/**
 * 单文件产物只允许一个 entry chunk：多余 chunk / asset 不落盘，宿主加载时才炸。
 * @param {readonly OutputItem[]} output
 * @param {string} source
 * @returns {{ type: "chunk", code: string }}
 */
export function singleEntryChunk(output, source) {
  if (output.length !== 1) {
    const names = output.map((item) => `${item.type}:${item.fileName}`).join(", ");
    throw new Error(
      `rolldown 为 ${source} 产出了 ${output.length} 项输出（期望恰好一个 entry chunk）：${names}`,
    );
  }
  const chunk = output.at(0);
  if (!isEntryChunk(chunk)) {
    throw new Error(`rolldown 为 ${source} 产出的不是单个 entry chunk`);
  }
  return chunk;
}

/** 生成 client.js 的完整文本（含 ModuleLoader 外壳）。 */
export async function buildClient() {
  /** @type {unknown} */
  const pkgJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const nameKey = "name";
  const pkgNameRaw = asRecord(pkgJson)[nameKey];
  // 刻意 fail loud：id 写进产物的模块表键，键对不上时宿主不报错、整张设置卡静默不渲染。
  // 退化兜底只会让构建与新鲜度门禁两端一起绿，缺陷直达运行时。
  if (typeof pkgNameRaw !== "string" || pkgNameRaw === "") {
    throw new Error(
      "build-client：package.json 的 name 缺失或非字符串。client.js 的 id 必须等于 dsh client 模块表的键（bundle 包名）。",
    );
  }
  const pkgName = pkgNameRaw;
  // id 那一行是手写源码而不是 JSON：放行 npm 允许的字符集，挡住引号/反斜杠/换行造成的
  // 产物语法错误，让下面的 JSON.stringify 只是兜底而不是唯一防线。
  if (!/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(pkgName)) {
    throw new Error(
      `build-client：package.json 的 name ${JSON.stringify(pkgName)} 不符合 npm 包名字符集。`,
    );
  }
  const bundle = await rolldown({
    input: path.join(root, "src", "client-entry.ts"),
    // react 及其子路径都要外部化：子路径一旦被内联，页面里会出现第二份 React，
    // hooks 直接失效且不报错。
    external: (id) => id === "react" || id.startsWith("react/"),
    platform: "browser",
    // `//#region` 行的相对路径由 rolldown 按 cwd 算出。cwd 缺省是 process.cwd()，
    // 于是同一份源码在包根/伞根/别处构建出三种字节。钉成包根后产物与调用者的 cwd 无关。
    cwd: root,
    // 显式 extensions 是**替换**默认值而不是追加：默认含 .tsx/.jsx（实测），
    // 只列 .ts/.js/.json 会让导入 .tsx 组件的构建直接 UNRESOLVED_IMPORT。
    resolve: {
      extensions: [".tsx", ".ts", ".jsx", ".js", ".mjs", ".json"],
    },
  });
  let body;
  try {
    const { output } = await bundle.generate({
      format: "cjs",
    });
    // CJS 外壳只包一块：多余 chunk / asset 不落盘，产物要到运行时才因缺模块而炸。
    const chunk = singleEntryChunk(output, "src/client-entry.ts");
    // 折 canonical 必须落在返回值之前：test/client-freshness.ts 逐字节比内存构建与磁盘产物。
    body = collapseStorePaths(canonicalizeRegionPaths(chunk.code.trimEnd(), root));
  } finally {
    // bundle 持有原生资源；generate 或上面的守卫抛错时同样要释放。
    await bundle.close();
  }
  // 槽位 key 写死在 src 的 BUNDLE_PKG，外壳 id 取自 package.json.name，两者不同源。
  // 宿主按包名逐字匹配模块表键，对不上就是整张卡静默不渲染，而改名在别的环节没有症状。
  // 所以判据必须读 BUNDLE_PKG 的声明值本身：产物里包名一共出现多次（外壳 id、BUNDLE_PKG 的
  // 声明与引用），拿 includes 去判会被其中任意一处满足，而这个不变量要的正是"这三处同源"。
  const declared = /(?:const|let|var)\s+BUNDLE_PKG\s*=\s*(?<literal>"(?:[^"\\]|\\.)*")/u.exec(body);
  const literal = declared?.groups?.literal;
  if (literal === undefined) {
    throw new Error(
      "build-client：产物里找不到 BUNDLE_PKG 的声明，src/client-entry.ts 的槽位 key 无从核对。",
    );
  }
  const declaredName = JSON.parse(literal);
  if (declaredName !== pkgName) {
    throw new Error(
      `build-client：src 的 BUNDLE_PKG 是 ${JSON.stringify(declaredName)}，package.json 的 name 是 ${JSON.stringify(pkgName)}——两者不同源，槽位 key 与模块表键会对不上。`,
    );
  }
  return [
    "// GENERATED by buildClient() in build-client.mjs — edit src/client-entry.ts, then run `node build-client.mjs`.",
    "window.__ModuleLoader__.load({",
    // JSON.stringify 负责转义：id 是拼进源码的字面量。
    `  id: ${JSON.stringify(pkgName)},`,
    "  factory: (require) => {",
    // 'use strict' 必须在指令序言里：外壳的两条声明排在 chunk 之前，chunk 自带的
    // "use strict" 会被顶出序言，整份产物降级为 sloppy 模式。
    "    'use strict';",
    "    const module = { exports: {} };",
    "    let exports = module.exports;",
    body,
    "    return module.exports;",
    "  },",
    "});",
    "",
  ].join("\n");
}

async function main() {
  const out = await buildClient();
  const target = path.join(root, "client.js");
  // 同目录临时文件 + rename：rename 在同一文件系统内是原子的，中断/OOM 只会留下临时文件，
  // 不会把 client.js 截断成半份 JS——后者要等到宿主加载时才炸。失败路径要自己把临时文件收掉：
  // 留一份 <pid>.tmp 在包根既不进 .gitignore（规则钉的是 client.js 这个精确名字），也会混进下次的产物比对。
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, out, "utf8");
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  console.info("client.js written:", Buffer.byteLength(out, "utf8"), "bytes");
}

/**
 * 直跑守卫：argv[1] 与本文件按 realpath 逐字比。pnpm 等场景 argv[1] 可能是符号链接路径，
 * 裸字符串比较会让直跑分支被静默跳过。argv[1] 缺席时直接判否。
 * @returns {boolean}
 */
function invokedDirectly() {
  const entry = process.argv.at(1);
  if (entry === undefined) {
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
    // 用 exitCode 而不是 process.exit：后者会在 stdout/stderr 管道被占满时截断错误输出。
    console.error(error);
    process.exitCode = 1;
  }
}
