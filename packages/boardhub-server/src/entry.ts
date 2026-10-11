/**
 * BoardHub 独立应用服务端入口：只装配 dbBoard 三件套 + paperclip + 基础设施，
 * 不注册 zcodeAgent/会话/任务等 ZCode 核心服务。见 specs/boardhub/standalone-app.md。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBroadcastService,
  createCredentialService,
  createDbBoardAgentService,
  createDbBoardKnowledgeService,
  createDbBoardService,
  createPaperclipService,
  createSettingService,
  setDataBaseDir,
} from "@zcode/services/node";
import {
  IBroadcastService,
  ICredentialService,
  IDbBoardAgentService,
  IDbBoardKnowledgeService,
  IDbBoardService,
  IPaperclipService,
  ISettingService,
  ServiceCollection,
} from "@zcode/services";
import type { DbBoardKnowledge } from "@zcode/services";
import { createHttpServer } from "@zcode/server";
import { installBoardhubFileLogSink } from "./boardhubLog.js";
import { createBoardhubModelRuntime } from "./boardhubModel.js";

const BOARDHUB_DATA_ROOT = join(homedir(), ".boardhub");

/**
 * 数据目录必须在任何服务实例化前切换：BoardHub 与 ZCode 主应用的
 * setting/credentials/dbBoard 配置互不可见（setDataBaseDir 优先级最高）。
 */
setDataBaseDir(BOARDHUB_DATA_ROOT);
// 桌面打包形态没有终端，console 日志必须同步落盘供错误页指引查看。
installBoardhubFileLogSink(join(BOARDHUB_DATA_ROOT, "logs"));

function resolveStaticRoot(): string | undefined {
  const fromEnv =
    process.env["BOARDHUB_WEB_ROOT"]?.trim() || process.env["ZCODE_WEB_STATIC_ROOT"]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const defaultWebDist = join(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../boardhub-web/dist",
  );
  return existsSync(defaultWebDist) ? defaultWebDist : undefined;
}

function main(): void {
  // PORT=0 表示随机端口（桌面壳用）：消除「先探测端口再启动」的 TOCTOU 竞态，
  // 实际端口经 READY 协议行从 stdout 回传。注意 0 是合法显式值，不能被默认值短路。
  const port =
    process.env["PORT"] !== undefined && process.env["PORT"] !== ""
      ? Number(process.env["PORT"])
      : 3210;
  // 默认只绑回环：channel 上有凭据与数据库配置服务，无 authToken 时绝不能暴露到局域网；
  // 需要外部访问时显式设置 BOARDHUB_SERVER_HOST=0.0.0.0。
  const host = process.env["BOARDHUB_SERVER_HOST"]?.trim() || "127.0.0.1";
  const authToken = process.env["BOARDHUB_AUTH_TOKEN"]?.trim() || undefined;
  const staticRoot = resolveStaticRoot();

  const settingService = createSettingService();
  const credentialService = createCredentialService();
  const broadcastService = createBroadcastService(null);
  const model = createBoardhubModelRuntime({ settingService, credentialService });

  // 知识库晚于看板创建（依赖其公开面），loadKnowledge 经懒引用闭包回接，与 node.ts 同一模式。
  let dbBoardKnowledgeServiceRef: {
    getKnowledge(): Promise<DbBoardKnowledge | null>;
  } | null = null;
  const dbBoardService = createDbBoardService({
    credentialService,
    loadKnowledge: async () =>
      dbBoardKnowledgeServiceRef ? await dbBoardKnowledgeServiceRef.getKnowledge() : null,
    readCurrentModel: model.readCurrentModel,
    generateText: model.generateText,
  });
  const dbBoardKnowledgeService = createDbBoardKnowledgeService({
    credentialService,
    dbBoardService,
    readCurrentModel: model.readCurrentModel,
    generateText: model.generateText,
  });
  dbBoardKnowledgeServiceRef = dbBoardKnowledgeService;
  const dbBoardAgentService = createDbBoardAgentService({
    dbBoardService,
    dbBoardKnowledgeService,
  });

  const paperclipService = createPaperclipService({ settingService, credentialService });

  const services = new ServiceCollection()
    .register(ISettingService, settingService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IDbBoardService, dbBoardService)
    .register(IDbBoardKnowledgeService, dbBoardKnowledgeService)
    .register(IDbBoardAgentService, dbBoardAgentService)
    .register(IPaperclipService, paperclipService);

  const server = createHttpServer(services, port, {
    host,
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });

  // READY 协议行：桌面壳经 utilityProcess stdout 解析实际端口（PORT=0 场景）。
  // listen 是异步的，必须等 listening 事件后 address() 才有真实端口。
  const emitReady = () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`BOARDHUB_SERVER_READY ${JSON.stringify({ port: actualPort })}`);
  };
  if (server.listening) {
    emitReady();
  } else {
    server.once("listening", emitReady);
  }

  const shutdown = () => {
    // paperclip 的 WS 连接与事件 emitter 需要显式收口；dbBoard 的 pg 连接池随进程退出释放。
    paperclipService.dispose();
  };
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}

main();
