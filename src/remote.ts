// src/remote.ts —— 设置卡读面（官方 Typert Remote 的消费侧）。
//
// 五个方法取代原先的 /_dsh/dir-prep/* HTTP 端点：defaults / context / model /
// organize / importTemplates。descriptor 手写、参数走 strict 形状校验，结果走
// src-json；宿主侧由源模式按方法签名推参数名。`remote` 是可选读面：没有它时
// 设置卡照常渲染，只把数据面显示为读不到。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** Typert Remote 命名空间。**单源**：错误文案与宿主侧注册都用这一枚，
 *  写死两处会让"网关挂的是 A、报错说的是 B"这种漂移没有任何运行期信号。 */
export const DIR_PREP_NAMESPACE = "dirPrepOrganize";
const DIR_PREP_SERVICE_KEY = `remote.${DIR_PREP_NAMESPACE}`;
const PACKAGE_NAME = "@jayyuen66/dsh-dir-prep-organize";

const SESSION_CODEC: TypertCodec<{ sessionId: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#session-request`,
  create: () => ({
    parse(value: unknown): { sessionId: string } {
      if (!isRecord(value) || typeof value["sessionId"] !== "string") {
        throw new TypeError("session request requires a string sessionId");
      }
      return { sessionId: value["sessionId"] };
    },
  }),
};

const ORGANIZE_CODEC: TypertCodec<{
  sessionId: string;
  prompt: string;
  entriesSummary: string;
  roleText?: string;
}> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#organize-request`,
  create: () => ({
    parse(value: unknown): {
      sessionId: string;
      prompt: string;
      entriesSummary: string;
      roleText?: string;
    } {
      if (
        !isRecord(value) ||
        typeof value["sessionId"] !== "string" ||
        typeof value["prompt"] !== "string" ||
        typeof value["entriesSummary"] !== "string"
      ) {
        throw new TypeError(
          "organize request requires string sessionId, prompt and entriesSummary",
        );
      }
      const { roleText } = value;
      if (roleText !== undefined && typeof roleText !== "string") {
        throw new TypeError("organize request roleText must be a string when present");
      }
      return {
        sessionId: value["sessionId"],
        prompt: value["prompt"],
        entriesSummary: value["entriesSummary"],
        ...(roleText === undefined ? {} : { roleText }),
      };
    },
  }),
};

const IMPORT_CODEC: TypertCodec<{ path: string; sessionId: string }> = {
  mode: "strict",
  typeSymbol: `${PACKAGE_NAME}#import-request`,
  create: () => ({
    parse(value: unknown): { path: string; sessionId: string } {
      if (
        !isRecord(value) ||
        typeof value["path"] !== "string" ||
        typeof value["sessionId"] !== "string"
      ) {
        throw new TypeError("import request requires string path and sessionId");
      }
      return { path: value["path"], sessionId: value["sessionId"] };
    },
  }),
};

export const DIR_PREP_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${DIR_PREP_NAMESPACE}/defaults`,
    service: DIR_PREP_NAMESPACE,
    namespace: DIR_PREP_NAMESPACE,
    method: "defaults",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${DIR_PREP_NAMESPACE}/context`,
    service: DIR_PREP_NAMESPACE,
    namespace: DIR_PREP_NAMESPACE,
    method: "context",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: SESSION_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${DIR_PREP_NAMESPACE}/model`,
    service: DIR_PREP_NAMESPACE,
    namespace: DIR_PREP_NAMESPACE,
    method: "model",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: SESSION_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${DIR_PREP_NAMESPACE}/organize`,
    service: DIR_PREP_NAMESPACE,
    namespace: DIR_PREP_NAMESPACE,
    method: "organize",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: ORGANIZE_CODEC }],
    result: { mode: "src-json" },
  },
  {
    id: `${PACKAGE_NAME}#${DIR_PREP_NAMESPACE}/importTemplates`,
    service: DIR_PREP_NAMESPACE,
    namespace: DIR_PREP_NAMESPACE,
    method: "importTemplates",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: IMPORT_CODEC }],
    result: { mode: "src-json" },
  },
];

export interface DirPrepOrganizeArgs {
  sessionId: string;
  prompt: string;
  entriesSummary: string;
  roleText?: string;
}

export interface DirPrepReader {
  defaults: () => Promise<unknown>;
  context: (sessionId: string) => Promise<unknown>;
  model: (sessionId: string) => Promise<unknown>;
  organize: (args: DirPrepOrganizeArgs) => Promise<unknown>;
  importTemplates: (args: { path: string; sessionId: string }) => Promise<unknown>;
}

interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

interface DirPrepNamespace {
  defaults: () => Promise<RemoteResult<unknown>>;
  context: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
  model: (request: { sessionId: string }) => Promise<RemoteResult<unknown>>;
  organize: (request: DirPrepOrganizeArgs) => Promise<RemoteResult<unknown>>;
  importTemplates: (request: { path: string; sessionId: string }) => Promise<RemoteResult<unknown>>;
}

const isMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

const isNamespace = (value: unknown): value is DirPrepNamespace =>
  isRecord(value) &&
  typeof value["defaults"] === "function" &&
  typeof value["context"] === "function" &&
  typeof value["model"] === "function" &&
  typeof value["organize"] === "function" &&
  typeof value["importTemplates"] === "function";

const unwrap = (result: RemoteResult<unknown>): unknown => {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
};

function buildReader(ctx: RemoteHost, remote: RemoteMounter): DirPrepReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<DirPrepNamespace> => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: DIR_PREP_DESCRIPTORS });
    await mounted;
    const namespace = ctx.get?.(DIR_PREP_SERVICE_KEY, false);
    if (!isNamespace(namespace)) {
      throw new Error(`${DIR_PREP_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    return namespace;
  };
  const call = async <Value>(
    invoke: (namespace: DirPrepNamespace) => Promise<RemoteResult<Value>>,
  ): Promise<unknown> => {
    const namespace = await namespaceOf();
    return unwrap(await invoke(namespace));
  };
  return {
    defaults: async () => call((namespace) => namespace.defaults()),
    context: async (sessionId) => call((namespace) => namespace.context({ sessionId })),
    model: async (sessionId) => call((namespace) => namespace.model({ sessionId })),
    organize: async (args) => call((namespace) => namespace.organize(args)),
    importTemplates: async (args) => call((namespace) => namespace.importTemplates(args)),
  };
}

/** 造读取器；当前部署没有远程面时 undefined（卡片只显示读不到）。 */
export function createDirPrepReader(ctx: RemoteHost): DirPrepReader | undefined {
  const remote = ctx.get?.("remote");
  return isMounter(remote) ? buildReader(ctx, remote) : undefined;
}
