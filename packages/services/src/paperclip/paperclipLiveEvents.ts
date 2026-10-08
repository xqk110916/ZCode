/* Paperclip live-events WebSocket 订阅（服务私有，host/server 进程持有）。
   路径 /api/companies/{companyId}/events/ws，query token 或 trusted-local 免认证。
   重连语义：非认证类断开按 1s..30s 指数退避；认证拒绝（close 1008）不再重试，
   由服务层降级为 polling 态（REST 仍可用，UI 手动刷新）。 */
import {
  paperclipIssueSchema,
  readPaperclipLiveExtras,
  type PaperclipIssueEvent,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/** 依赖注入的最小 WebSocket 形状（Node 24 全局 WebSocket 满足；测试可替换）。 */
export interface PaperclipWebSocketLike {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: string, listener: (...args: never[]) => void): void;
}

export type PaperclipLiveEventsCallbacks = {
  /** WS 建立（可恢复实时推送）。 */
  onOpen: () => void;
  /** WS 断开（将按退避重连；authenticated=false 表示放弃重连、应降级 polling）。 */
  onClose: (input: { willRetry: boolean }) => void;
  /** 归一化后的 issue 事件。 */
  onEvent: (event: PaperclipIssueEvent) => void;
};

export interface PaperclipLiveEvents {
  /** 开始订阅（幂等：已在订阅同一 companyId 时为 no-op）。 */
  start(companyId: string): void;
  /** 停止并释放连接（不触发重连）。 */
  stop(): void;
  /** 当前是否持有打开的连接。 */
  isActive(): boolean;
}

interface PaperclipLiveEventsDeps {
  resolveBaseUrl: () => string | Promise<string>;
  resolveToken: () => string | null | Promise<string | null>;
  callbacks: PaperclipLiveEventsCallbacks;
  logger: ServiceLogger;
  /** 测试注入；缺省用全局 WebSocket（Node >= 22）。 */
  connectImpl?: (url: string) => PaperclipWebSocketLike;
  /** 测试注入定时器；缺省用 setTimeout/clearTimeout。 */
  scheduleRetry?: (delayMs: number, fn: () => void) => () => void;
}

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** close code 1008 = policy violation（Paperclip 拒绝升级，通常是认证）。 */
const CLOSE_POLICY_VIOLATION = 1008;

export function createPaperclipLiveEvents(deps: PaperclipLiveEventsDeps): PaperclipLiveEvents {
  const connectImpl =
    deps.connectImpl ?? ((url: string) => new WebSocket(url) as unknown as PaperclipWebSocketLike);
  const scheduleRetry =
    deps.scheduleRetry ?? ((delayMs: number, fn: () => void) => {
      const timer = setTimeout(fn, delayMs);
      return () => clearTimeout(timer);
    });

  let activeCompanyId: string | null = null;
  let socket: PaperclipWebSocketLike | null = null;
  let stopped = true;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  function teardownSocket() {
    if (!socket) return;
    const current = socket;
    socket = null;
    try {
      current.close();
    } catch {
      // 已在关闭中；忽略。
    }
  }

  function clearRetry() {
    if (cancelRetry) {
      cancelRetry();
      cancelRetry = null;
    }
  }

  async function connect(companyId: string) {
    if (stopped || activeCompanyId !== companyId || socket) return;
    try {
      const baseUrl = await deps.resolveBaseUrl();
      if (stopped || activeCompanyId !== companyId) return;
      const token = await deps.resolveToken();
      if (stopped || activeCompanyId !== companyId) return;
      const wsUrl =
        `${baseUrl.replace(/^http/, "ws")}/api/companies/${encodeURIComponent(companyId)}/events/ws` +
        (token ? `?token=${encodeURIComponent(token)}` : "");
      attach(companyId, wsUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.warn(undefined, "paperclip live-events url resolve failed", { reason });
      scheduleReconnect(companyId);
    }
  }

  function attach(companyId: string, wsUrl: string) {
    let ws: PaperclipWebSocketLike;
    try {
      ws = connectImpl(wsUrl);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.warn(undefined, "paperclip live-events connect failed", { reason });
      scheduleReconnect(companyId);
      return;
    }
    socket = ws;

    const onOpen = () => {
      if (socket !== ws) return;
      attempt = 0;
      deps.callbacks.onOpen();
    };
    const onClose = (event: { code: number; reason: string }) => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      const authenticated = event.code === CLOSE_POLICY_VIOLATION;
      if (authenticated) {
        // 认证被拒：重试无意义，交由服务层降级 polling。
        deps.logger.warn(undefined, "paperclip live-events rejected, degrading to polling", {
          code: event.code,
        });
        deps.callbacks.onClose({ willRetry: false });
        return;
      }
      deps.callbacks.onClose({ willRetry: true });
      scheduleReconnect(companyId);
    };
    const onError = () => {
      // WebSocket 出错后必有 close 事件（或连接从未建立）；不在 error 里做状态迁移，
      // 避免与 onClose 双重触发重连。
    };
    const onMessage = (event: { data: unknown }) => {
      if (socket !== ws) return;
      handleEventMessage(event.data, deps.callbacks.onEvent, deps.logger);
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
    ws.addEventListener("message", onMessage);
  }

  function scheduleReconnect(companyId: string) {
    if (stopped || cancelRetry) return;
    const delay = Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS);
    attempt += 1;
    cancelRetry = scheduleRetry(delay, () => {
      cancelRetry = null;
      connect(companyId);
    });
  }

  return {
    start(companyId) {
      if (!stopped && activeCompanyId === companyId) return;
      stopped = false;
      const changed = activeCompanyId !== companyId;
      activeCompanyId = companyId;
      if (changed) {
        teardownSocket();
        clearRetry();
        attempt = 0;
      }
      connect(companyId);
    },
    stop() {
      stopped = true;
      clearRetry();
      teardownSocket();
      activeCompanyId = null;
      attempt = 0;
    },
    isActive() {
      return socket !== null;
    },
  };
}

/**
 * 归一化上游 LiveEvent：{ id, companyId, type, createdAt, payload }。
 * 只透出 issue 相关事件；type 命名上游未稳定承诺，故按包含 "issue" 宽容匹配，
 * payload.issue 尽力解析为 PaperclipIssue，失败仍保留 issueId 线索。
 */
function handleEventMessage(
  data: unknown,
  emit: (event: PaperclipIssueEvent) => void,
  logger: ServiceLogger,
): void {
  if (typeof data !== "string") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  // 事件 type 命名上游未稳定承诺（实测存在 issue.* 与 heartbeat.run.* 两族——后者
  // payload 带 issueId 的执行进度），按「type 含 issue 或 payload 带 issueId」宽容透出。
  const issueIdFromPayload =
    typeof payload.issueId === "string" && payload.issueId ? payload.issueId : undefined;
  if (!type || (!type.toLowerCase().includes("issue") && !issueIdFromPayload)) return;
  const rawIssue = payload.issue ?? payload.data ?? payload.item;
  const issueResult = rawIssue ? paperclipIssueSchema.safeParse(rawIssue) : null;
  const issueId =
    issueIdFromPayload ??
    (issueResult?.success ? issueResult.data.id : undefined) ??
    (typeof record.id === "string" ? record.id : undefined);
  if (issueResult && !issueResult.success) {
    logger.debug(undefined, "paperclip live-event issue payload unparsed", { type });
  }
  const normalizedType = type.toLowerCase();
  const kind: PaperclipIssueEvent["kind"] = normalizedType.includes("creat")
    ? "created"
    : normalizedType.includes("delet") || normalizedType.includes("remov")
      ? "deleted"
      : normalizedType.includes("updat") || normalizedType.includes("status") || normalizedType.includes("comment")
        ? "updated"
        : "unknown";
  const extras = readPaperclipLiveExtras(payload);
  emit({
    kind,
    issueId: extras.run?.issueId ?? issueId,
    ...(issueResult?.success ? { issue: issueResult.data } : {}),
    ...(extras.run ? { run: extras.run } : {}),
    ...(extras.comment ? { comment: extras.comment } : {}),
    rawType: type,
    receivedAt: Date.now(),
  });
}
