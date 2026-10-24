// src/remote.ts —— 设置卡读面（官方 Typert Remote 的消费侧）。
//
// descriptor 手写（来源模式要求）、参数走 strict 形状校验，结果走 src-json；宿主侧按
// 方法签名推参数名。`remote` 是可选读面：没有它时设置卡照常渲染，只把数据面显示为读不到。
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertCodec,
} from "@deepseek-ai/dsh-typert-protocol";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";

/** Typert Remote 命名空间（client 半这一侧的唯一一枚）。
 *
 *  宿主半的注册键在 host.ts 的 `DIR_PREP_REMOTE_NAMESPACE`——两半各自打包、client 包
 *  不能 import host.ts，所以这一枚字面量必然有两份。两边取值必须一致：写岔了的表现是
 *  网关挂上的是 A、报错文案说的是 B，而没有任何运行期信号。 */
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

const unwrap = (raw: unknown): unknown => {
  // 先验形状再读字段：这一层跨的是进程/版本边界，应答由宿主侧协议栈组装，
  // 形状不对时要报「形状不对」，而不是在解构 undefined 时抛一个与成因无关的 TypeError。
  // 参数按 unknown 收：声明里的 RemoteResult 只是期望，运行时拿到的东西不归它保证。
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean") {
    throw new TypeError("Typert Remote 应答不是 RemoteResult：缺少布尔字段 ok");
  }
  if (!raw["ok"]) {
    const { error } = raw;
    if (
      !isRecord(error) ||
      typeof error["code"] !== "string" ||
      typeof error["message"] !== "string"
    ) {
      throw new TypeError("Typert Remote 应答的 error 分支缺 code/message");
    }
    // 宿主给的 message 是面向用户的句子，前面挂上协议码便于对照网关日志；不要把它吞掉。
    throw new Error(`${error["code"]}: ${error["message"]}`);
  }
  // 成功分支同样要验键：`ok: true` 与「带 value」是两件事，协议栈换版本或某条方法
  // 声明成 void 时，`raw["value"]` 会读到 undefined，而调用方拿到的是一份「成功但空」
  // 的结果——它会在下游解构时才炸，错因指向卡片而不是应答形状。
  if (!("value" in raw)) {
    throw new TypeError("Typert Remote 应答的 ok 分支缺 value 字段");
  }
  return raw["value"];
};

function buildReader(ctx: RemoteHost, remote: RemoteMounter): DirPrepReader {
  let mounted: Promise<unknown> | undefined;
  const namespaceOf = async (): Promise<DirPrepNamespace> => {
    // 被拒的挂载不留在缓存里：$mount 失败一次（宿主还没起远端栈、descriptor 与当前协议版
    // 不兼容）之后每一次读都该重试，否则整张卡在这个页面生命周期内永久显示「读不到」，
    // 而症状看起来是数据面没挂上——与真实成因无关。
    //
    // 无条件清空即可：这一行是同步赋值，清缓存又发生在同一个 promise 的 catch 里，
    // 因此「清掉别人刚建好的挂载」这一刻在时序上不存在（并发等待者共享同一枚在途
    // promise，它们的 catch 都在同一次微任务排空里跑，其间没有别处会再赋值）。
    // 实测：一枚失败的挂载被两个并发读共用时 $mount 只调一次、两个调用方都拿到原错，
    // 下一次读重新挂载（.probe 回执 T1 mounts=1 / T2 mounts=2）。
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: DIR_PREP_DESCRIPTORS });
    try {
      await mounted;
    } catch (error) {
      mounted = undefined;
      throw error;
    }
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

/** 造读取器；当前部署没有远程面时 undefined（卡片只显示读不到）。
 *
 *  `get` 的两个口径与 buildReader 里查命名空间时保持一致，都显式传 `strict = false`：
 *  不传时 cordis 默认只返回「提供者 fiber 当前 active」的实现，而设置卡可能在 fiber
 *  就绪前就挂上——那时读面会拿到 undefined 并显示「读不到」，看起来是插件没装。
 *  `get` 本身也可能抛（宿主版本演进后反射面可能不再接受 bool），兜住它只是为了把这
 *  一栏降级成「读不到」，不让整张卡片跟着炸。 */
export function createDirPrepReader(ctx: RemoteHost): DirPrepReader | undefined {
  // 单出口满足 consistent-return：任一分支取不到可挂载的 remote 面都保持 undefined。
  let remote: unknown;
  try {
    remote = ctx.get?.("remote", false);
  } catch {
    remote = undefined;
  }
  return isMounter(remote) ? buildReader(ctx, remote) : undefined;
}
