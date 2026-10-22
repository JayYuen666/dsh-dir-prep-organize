// build-host.mjs 的声明（供 test/build-host.test.ts 等 TS 侧类型化导入）。
// 本包有两个产物入口：host.ts 与 src/default-templates.generated.ts，故返回「落盘路径 → 正文」的 Map。
export function buildHost(): Promise<Map<string, string>>;
/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。 */
export function singleEntryChunk(
  output: readonly {
    type: string;
    fileName: string;
    code?: string;
    isEntry?: boolean;
    moduleIds?: string[];
  }[],
  source: string,
): { type: "chunk"; code: string; moduleIds?: string[] };
