// build-client 侧门禁：本文件只承担逐字节新鲜度指纹（磁盘 client.js vs 当期内存
// 构建），把「改了 src/ 忘跑 node build-client.mjs」变成机器可判的红点。
// 归属说明：本包 src/ 的行为契约在 test/client.test.ts（happy-dom 真实 React 渲染），
// 卡片字段覆盖由 test/schema-coverage.ts 的夹具提供，两者都不判产物字节。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { singleEntryChunk } from "../build-client.mjs";
import { clientFreshnessEvidence } from "./client-freshness.ts";

// 模块表 id 必须等于包名（dsh 的 client-modules 只扫裸包名条目并按包名建键）：
// 断言两侧同源，验的是「构建器取了 package.json 的 name」，改名不再需要改测试。
const PKG_NAME = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown as {
    name: string;
  }
).name;

describe("buildClient", () => {
  it(`${PKG_NAME}: client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）`, async () => {
    const { pkgName, pkgDir, onDisk, built } = await clientFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] client.js 已过期：src/client-entry.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-client.mjs`,
    );
  });
});

/** 输出守卫测试用的最小 chunk 正文。 */
const CHUNK_CODE = "export {};";
/** 输出守卫测试用的产物文件名。 */
const ARTIFACT_FILE = "artifact.js";

/**
 * 造一个最小输出项；判据只看 type/fileName/isEntry/code。
 * @param type - rolldown 输出项类型
 * @param fileName - 产物文件名
 * @param extra - 该类型需要的其余字段
 * @returns 可交给 singleEntryChunk 的输出项
 */
function outputItem(
  type: string,
  fileName: string,
  extra: Partial<{ isEntry: boolean; code: string }> = {},
): { type: string; fileName: string } & Partial<{ isEntry: boolean; code: string }> {
  return { type, fileName, ...extra };
}

describe("单文件产物的输出守卫", () => {
  it("拒绝多个 chunk：单文件产物不能静默丢掉第二个", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE }),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝 asset：单文件产物没有落盘 asset 的位置", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("asset", "x.css"),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝非 entry 的单个 chunk", () => {
    const output = [outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("接受唯一的 entry chunk", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE })];
    const chunk = singleEntryChunk(output, "entry.ts");
    assert.equal(chunk.code, CHUNK_CODE);
  });
});
