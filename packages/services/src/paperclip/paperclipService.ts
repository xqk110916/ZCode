/* Paperclip 服务 Node 侧实现。
   组合 REST 客户端与 live-events WS：配置现读（settings + credential），URL 变更后
   下一次调用自动重建连接（companyId 缓存与 URL 绑定）；WS 认证拒绝或断开时降级
   polling（REST 仍可用），重连成功自动恢复 connected。 */
import { Emitter } from "@zcode/rpc";
import {
  mergePaperclipRuns,
  resolvePaperclipServerUrl,
  type PaperclipAgent,
  type PaperclipConnectionState,
  type PaperclipConnectionStateSnapshot,
  type PaperclipIssueEvent,
  type PaperclipLocalServerStatus,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { ICredentialService } from "../credential/credential.js";
import type { ISettingService } from "../setting/setting.js";
import type {
  IPaperclipService,
} from "./paperclip.js";
import {
  createPaperclipRestClient,
  PaperclipApiError,
  type PaperclipRestClient,
} from "./paperclipRestClient.js";
import { createPaperclipLiveEvents, type PaperclipLiveEvents } from "./paperclipLiveEvents.js";
import { discoverClaudeModels as discoverClaudeModelsImpl } from "./paperclipModelDiscovery.js";
import { detectLocalAgentAdapters as detectLocalAgentAdaptersImpl } from "./paperclipAdapters.js";
import {
  createPaperclipLocalServerController,
  type PaperclipLocalServerDeps,
} from "./paperclipLocalServer.js";

/** Bearer token 在 ICredentialService 的存储键。 */
export const PAPERCLIP_TOKEN_CREDENTIAL_KEY = "paperclip-api-token";

export interface PaperclipServiceFactoryDeps {
  settingService: ISettingService;
  credentialService: ICredentialService;
  fetchImpl?: typeof fetch;
  logger?: ServiceLogger;
  env?: Record<string, string | undefined>;
  /** 本地 server 启停控制器的依赖注入（测试用）；缺省按真实进程/文件系统构造。 */
  localServerDeps?: Partial<PaperclipLocalServerDeps>;
}

export type PaperclipServiceHandle = IPaperclipService & { dispose(): void };

export function createPaperclipService(deps: PaperclipServiceFactoryDeps): PaperclipServiceHandle {
  const logger = deps.logger ?? createServiceLogger("paperclip");
  const env = deps.env ?? process.env;

  const connectionEmitter = new Emitter<PaperclipConnectionStateSnapshot>();
  const issueEventEmitter = new Emitter<PaperclipIssueEvent>();

  let snapshot: PaperclipConnectionStateSnapshot = {
    state: "disconnected",
    serverUrl: "",
    changedAt: Date.now(),
  };
  /** companyId 发现缓存；与解析时的 serverUrl 绑定，URL 变更后失效重解析。 */
  let resolvedCompany: { serverUrl: string; companyId: string } | null = null;
  let ensureInFlight: Promise<string> | null = null;
  let ensureAttempted = false;

  function setState(state: PaperclipConnectionState, lastError?: string): void {
    if (snapshot.state === state && snapshot.lastError === lastError && snapshot.serverUrl) {
      return;
    }
    snapshot = {
      state,
      serverUrl: snapshot.serverUrl,
      changedAt: Date.now(),
      ...(lastError === undefined ? {} : { lastError }),
    };
    connectionEmitter.fire(snapshot);
  }

  async function resolveBaseUrl(): Promise<string> {
    const settings = await deps.settingService.get();
    const url = resolvePaperclipServerUrl({
      ...(settings.paperclipServerUrl === undefined
        ? {}
        : { settingsValue: settings.paperclipServerUrl }),
      env,
    });
    return url;
  }

  async function resolveToken(): Promise<string | null> {
    const token = await deps.credentialService.load(PAPERCLIP_TOKEN_CREDENTIAL_KEY);
    return token && token.trim() ? token.trim() : null;
  }

  function buildRestClient(): PaperclipRestClient {
    return createPaperclipRestClient({
      resolveBaseUrl,
      resolveToken,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      logger,
    });
  }

  /** 探活 + 公司发现；成功后启动 WS 订阅并返回 companyId。单飞防并发重复探测。 */
  async function ensureReady(): Promise<string> {
    if (ensureInFlight) return ensureInFlight;
    const baseUrl = await resolveBaseUrl();
    const cached = resolvedCompany;
    if (cached && cached.serverUrl === baseUrl) {
      // 连接已就绪（或曾在该 URL 上成功过）：WS 幂等 start，直接返回。
      liveEvents.start(cached.companyId);
      return cached.companyId;
    }
    snapshot = { state: "connecting", serverUrl: baseUrl, changedAt: Date.now() };
    connectionEmitter.fire(snapshot);

    const rest = buildRestClient();
    const attempt = (async () => {
      await rest.health();
      let companies = await rest.listCompanies();
      if (companies.length === 0) {
        // 全新 Paperclip 实例 companies 为空（onboard 不建公司）；ZCode 首连自举默认公司，
        // 否则面板永远停在 "no companies" 断连态。失败按原口径抛错。
        const created = await rest.createCompany({ name: "ZCode" });
        companies = [created];
      }
      // 至此 companies 必非空（原列表非空或刚自举创建）。
      const first = companies[0]!;
      resolvedCompany = { serverUrl: baseUrl, companyId: first.id };
      liveEvents.start(first.id);
      return first.id;
    })();
    ensureInFlight = attempt;
    try {
      const companyId = await attempt;
      ensureAttempted = true;
      return companyId;
    } catch (error) {
      resolvedCompany = null;
      const message = error instanceof Error ? error.message : String(error);
      setState("disconnected", message);
      throw error;
    } finally {
      ensureInFlight = null;
    }
  }

  const liveEvents: PaperclipLiveEvents = createPaperclipLiveEvents({
    resolveBaseUrl,
    resolveToken,
    callbacks: {
      onOpen: () => setState("connected"),
      onClose: ({ willRetry }) => {
        // REST 可用但实时链路不可用：polling 降级态（连接状态条如实展示，UI 手动刷新）。
        setState("polling", willRetry ? undefined : "live-events unavailable");
      },
      onEvent: (event) => issueEventEmitter.fire(event),
    },
    logger,
  });

  async function withCompanyId<T>(fn: (companyId: string) => Promise<T>): Promise<T> {
    const companyId = await ensureReady();
    return await fn(companyId);
  }

  /** 幂等 ensure 骨架：命中即返回；创建撞唯一约束（4xx）时回读既有。 */
  async function ensureUnique<T>(
    list: () => Promise<T[]>,
    match: (item: T) => boolean,
    create: () => Promise<T>,
  ): Promise<T> {
    const existing = (await list()).find(match);
    if (existing) return existing;
    try {
      return await create();
    } catch (error) {
      if (error instanceof PaperclipApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
        const raced = (await list()).find(match);
        if (raced) return raced;
      }
      throw error;
    }
  }

  async function pauseAgentQuietly(agent: PaperclipAgent): Promise<PaperclipAgent> {
    if (agent.status === "paused") return agent;
    try {
      return await rest.pauseAgent(agent.id);
    } catch (error) {
      logger.warn(undefined, "paperclip zcode agent pause failed", { agentId: agent.id });
      void error;
      return agent;
    }
  }

  /** ZCode 自主执行身份（http agent，公司内唯一）；创建/命中后自动 pause 暂停心跳
   *（防 heartbeat 反复执行失败把任务标 blocked，见 spec「ZCode 自主执行模式」）。 */
  async function ensureZCodeAgentInternal(): Promise<PaperclipAgent> {
    const companyId = await ensureReady();
    const match = (agent: PaperclipAgent) => agent.adapterType === "http";
    const agent = await ensureUnique(
      () => rest.listAgents(companyId),
      match,
      () => rest.createAgent(companyId, { name: "ZCode", adapterType: "http" }),
    );
    // pause 失败不阻断：agent 已存在，下次 ensure 会重试 pause。
    return pauseAgentQuietly(agent);
  }

  const localServer = createPaperclipLocalServerController({
    resolveBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...deps.localServerDeps,
  } satisfies PaperclipLocalServerDeps);

  const rest = buildRestClient();

  const handle: PaperclipServiceHandle = {
    async getConnectionState() {
      if (!ensureAttempted) {
        // 首次询问即懒启动连接（UI 打开面板自动探测）；失败不抛出，状态条展示原因。
        ensureAttempted = true;
        try {
          await ensureReady();
        } catch {
          // 快照已由 ensureReady 落为 disconnected。
        }
      }
      if (!snapshot.serverUrl) {
        snapshot = { ...snapshot, serverUrl: await resolveBaseUrl(), changedAt: snapshot.changedAt };
      }
      return snapshot;
    },

    async testConnection(url, token) {
      // 探活不影响当前生效配置：独立 client 直连给定地址。
      const probeRest = createPaperclipRestClient({
        resolveBaseUrl: () => url,
        resolveToken: () => token ?? null,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        logger,
      });
      try {
        const health = await probeRest.health();
        return { ok: true, serverInfo: { version: health.version } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    },

    async startLocalServer(): Promise<PaperclipLocalServerStatus> {
      const status = await localServer.start();
      if (status.state === "running") {
        // 启动成功后主动重连一次，面板不必等 WS 退避重试。
        resolvedCompany = null;
        ensureAttempted = true;
        void ensureReady().catch(() => {
          // 失败快照已由 ensureReady 落为 disconnected；下一次调用重试。
        });
      }
      return status;
    },

    async stopLocalServer(): Promise<PaperclipLocalServerStatus> {
      const status = await localServer.stop();
      if (status.state === "stopped") {
        // 服务是用户主动停止的：立即停掉 WS 重试链路并把连接态置为 disconnected。
        // 否则 WS 断开会被状态机解读为 polling 降级并无限退避重试，面板停在
        // 黄色"手动刷新"转圈，永远不会回到断连引导（启动按钮）。
        liveEvents.stop();
        resolvedCompany = null;
        setState("disconnected", "Local paperclip server stopped");
      }
      return status;
    },

    getLocalServerStatus: () => localServer.getStatus(),

    listAgents: () => withCompanyId((companyId) => rest.listAgents(companyId)),

    listAdapterModels: (adapterType) =>
      withCompanyId((companyId) => rest.listAdapterModels(companyId, adapterType)),

    updateAgent: (agentId, patch) => rest.updateAgent(agentId, patch),

    deleteAgent: (agentId) => rest.deleteAgent(agentId),

    // 幂等 ensure：命中 role=ceo 即返回，创建撞唯一约束回读（骨架见 ensureUnique）。
    ensureDispatcherAgent: () =>
      withCompanyId((companyId) =>
        ensureUnique(
          () => rest.listAgents(companyId),
          (agent) => agent.role === "ceo",
          () =>
            rest.createAgent(companyId, {
              name: "Dispatcher",
              adapterType: "claude_local",
              role: "ceo",
            }),
        ),
      ),

    async createAgent(input) {
      return withCompanyId(async (companyId) => {
        // 产品规则：每个 CLI（adapterType）只允许注册一个 agent，重复添加直接拒绝。
        const agents = await rest.listAgents(companyId);
        if (agents.some((agent) => agent.adapterType === input.adapterType)) {
          throw new PaperclipApiError(
            `adapter ${input.adapterType} already has an agent`,
            409,
            "/agents",
          );
        }
        return rest.createAgent(companyId, input);
      });
    },

    async ensureZCodeAgent() {
      return ensureZCodeAgentInternal();
    },

    // board 代 ZCode 认领：agent 身份直写需真实 run 上下文（实测 401），自主模式
    // 刻意不走 Paperclip 驱动，进度/完成回写同理走 board 写路径。
    claimIssueForZCode: async (issueId) =>
      rest.checkoutIssue(issueId, (await ensureZCodeAgentInternal()).id),

    // 第三方网关模型发现实现见 paperclipModelDiscovery.ts（行数控制拆分）。
    discoverClaudeModels: () => discoverClaudeModelsImpl(),

    listProjects: () => withCompanyId((companyId) => rest.listProjects(companyId)),

    async ensureProjectForWorkspace(input) {
      const companyId = await ensureReady();
      return ensureUnique(
        () => rest.listProjects(companyId),
        (project) => project.codebase?.localFolder === input.cwd,
        () => rest.createProject(companyId, input),
      );
    },

    detectLocalAgentAdapters: () => Promise.resolve(detectLocalAgentAdaptersImpl()),

    listIssues: (filter) =>
      withCompanyId((companyId) => rest.listIssues(companyId, filter)),

    createIssue: (input) => withCompanyId((companyId) => rest.createIssue(companyId, input)),

    updateIssue: (issueId, patch) => rest.updateIssue(issueId, patch),

    postComment: (issueId, body) => rest.postComment(issueId, body),

    async listRunSnapshots() {
      return withCompanyId(async (companyId) => {
        const [liveResult, recentResult] = await Promise.allSettled([
          rest.listLiveRuns(companyId),
          rest.listRecentRuns(companyId),
        ]);
        const live = liveResult.status === "fulfilled" ? liveResult.value : [];
        const recent = recentResult.status === "fulfilled" ? recentResult.value : [];
        if (liveResult.status === "rejected" && recentResult.status === "rejected") {
          throw liveResult.reason;
        }
        return mergePaperclipRuns(live, recent);
      });
    },

    listIssueComments: (issueId) => rest.listIssueComments(issueId),

    listIssueRuns: (issueId) => rest.listIssueRuns(issueId),

    listIssueInteractions: (issueId) => rest.listIssueInteractions(issueId),

    acceptIssueInteraction: (issueId, interactionId, body) =>
      rest.acceptIssueInteraction(issueId, interactionId, body),

    rejectIssueInteraction: (issueId, interactionId, reason) =>
      rest.rejectIssueInteraction(issueId, interactionId, reason),

    respondIssueInteraction: (issueId, interactionId, answers) =>
      rest.respondIssueInteraction(issueId, interactionId, answers),

    onDidChangeConnectionState: connectionEmitter.event,

    onDidReceiveIssueEvent: issueEventEmitter.event,

    dispose() {
      // 原生形态下宿主不持有子进程句柄；dispose 仅释放控制器内部状态。
      localServer.dispose();
      liveEvents.stop();
      connectionEmitter.dispose();
      issueEventEmitter.dispose();
    },
  };
  return handle;
}
