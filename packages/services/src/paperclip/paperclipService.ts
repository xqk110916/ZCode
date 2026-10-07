/* Paperclip 服务 Node 侧实现。
   组合 REST 客户端与 live-events WS：配置现读（settings + credential），URL 变更后
   下一次调用自动重建连接（companyId 缓存与 URL 绑定）；WS 认证拒绝或断开时降级
   polling（REST 仍可用），重连成功自动恢复 connected。 */
import { Emitter } from "@zcode/rpc";
import {
  resolvePaperclipServerUrl,
  type PaperclipConnectionState,
  type PaperclipConnectionStateSnapshot,
  type PaperclipIssueEvent,
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

/** Bearer token 在 ICredentialService 的存储键。 */
export const PAPERCLIP_TOKEN_CREDENTIAL_KEY = "paperclip-api-token";

export interface PaperclipServiceFactoryDeps {
  settingService: ISettingService;
  credentialService: ICredentialService;
  fetchImpl?: typeof fetch;
  logger?: ServiceLogger;
  env?: Record<string, string | undefined>;
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
      const companies = await rest.listCompanies();
      const first = companies[0];
      if (!first) {
        throw new PaperclipApiError("paperclip server has no companies", 0, "/companies");
      }
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

    listAgents: () => withCompanyId((companyId) => rest.listAgents(companyId)),

    listAdapterModels: (adapterType) =>
      withCompanyId((companyId) => rest.listAdapterModels(companyId, adapterType)),

    updateAgent: (agentId, patch) => rest.updateAgent(agentId, patch),

    async ensureDispatcherAgent() {
      const companyId = await ensureReady();
      const agents = await rest.listAgents(companyId);
      const existing = agents.find((agent) => agent.role === "ceo");
      if (existing) return existing;
      // 竞态兜底：并发两次 ensure 时后者撞唯一 CEO 约束（409/422），回读取既有。
      try {
        return await rest.createAgent(companyId, {
          name: "Dispatcher",
          adapterType: "claude_local",
          role: "ceo",
        });
      } catch (error) {
        if (error instanceof PaperclipApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
          const agentsAfter = await rest.listAgents(companyId);
          const raced = agentsAfter.find((agent) => agent.role === "ceo");
          if (raced) return raced;
        }
        throw error;
      }
    },

    listIssues: (filter) =>
      withCompanyId((companyId) => rest.listIssues(companyId, filter)),

    createIssue: (input) => withCompanyId((companyId) => rest.createIssue(companyId, input)),

    updateIssue: (issueId, patch) => rest.updateIssue(issueId, patch),

    postComment: (issueId, body) => rest.postComment(issueId, body),

    onDidChangeConnectionState: connectionEmitter.event,

    onDidReceiveIssueEvent: issueEventEmitter.event,

    dispose() {
      liveEvents.stop();
      connectionEmitter.dispose();
      issueEventEmitter.dispose();
    },
  };
  return handle;
}
