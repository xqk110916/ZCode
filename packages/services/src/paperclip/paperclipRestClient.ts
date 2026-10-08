/* Paperclip REST 客户端。
   只覆盖 ZCode 集成面：探活 / 公司发现 / agents 列表 / issues 增改查 / 评论。
   无内建重试与自动唤醒——唤醒语义归 Paperclip heartbeat 引擎（createIssue 即入队），
   手动唤醒走 heartbeat/invoke 仅作为列表页的显式动作。
   错误体按 Paperclip 惯例 { error: string }；zod 宽容解析见 shared/src/paperclip.ts。 */
import {
  paperclipAgentSchema,
  paperclipCompanySchema,
  paperclipIssueSchema,
  paperclipProjectSchema,
  type PaperclipAdapterModel,
  type PaperclipAgent,
  type PaperclipCompany,
  type PaperclipCreateIssueInput,
  type PaperclipIssue,
  type PaperclipIssueFilter,
  type PaperclipInteraction,
  type PaperclipIssueComment,
  type PaperclipProject,
  type PaperclipRunSnapshot,
  type PaperclipUpdateAgentInput,
  type PaperclipUpdateIssueInput,
  normalizePaperclipComments,
  normalizePaperclipInteractions,
  parsePaperclipRunList,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/** 类型化上游错误：调用方按 httpStatus 分流（401 配置问题 / 5xx 上游故障 / 网络错误 0）。 */
export class PaperclipApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

export interface PaperclipRestClient {
  health(): Promise<{ version?: string }>;
  listCompanies(): Promise<PaperclipCompany[]>;
  /** 创建公司（全新 Paperclip 实例 companies 为空时由 ZCode 首连自举）。 */
  createCompany(input: { name: string }): Promise<PaperclipCompany>;
  listAgents(companyId: string): Promise<PaperclipAgent[]>;
  listIssues(companyId: string, filter?: PaperclipIssueFilter): Promise<PaperclipIssue[]>;
  createIssue(companyId: string, input: PaperclipCreateIssueInput): Promise<PaperclipIssue>;
  updateIssue(issueId: string, patch: PaperclipUpdateIssueInput): Promise<PaperclipIssue>;
  postComment(issueId: string, body: string): Promise<void>;
  /** 删除 agent（团队管理）；主 Agent 也可删，删除后由后续新增/切换补位。 */
  deleteAgent(agentId: string): Promise<void>;
  /** adapter 可选模型列表（按 adapterType，如 claude_local）。 */
  listAdapterModels(companyId: string, adapterType: string): Promise<PaperclipAdapterModel[]>;
  /** 更新 agent 配置；adapterConfig 为 merge 语义（只传要改的字段）。 */
  updateAgent(agentId: string, patch: PaperclipUpdateAgentInput): Promise<PaperclipAgent>;
  /** 创建 agent（ZCode 侧仅用于一键创建 dispatcher，常规雇佣留在 Paperclip UI）。 */
  createAgent(
    companyId: string,
    input: { name: string; adapterType: string; role?: string },
  ): Promise<PaperclipAgent>;
  /** 项目列表（任务工作区载体）。 */
  listProjects(companyId: string): Promise<PaperclipProject[]>;
  /** 创建绑定本地路径工作区的项目（sourceType=local_path）。 */
  createProject(
    companyId: string,
    input: { name: string; cwd: string },
  ): Promise<PaperclipProject>;
  /** 当前 queued/running 的心跳（GET /companies/:id/live-runs）。 */
  listLiveRuns(companyId: string): Promise<PaperclipRunSnapshot[]>;
  /** 最近心跳摘要（含已结束，用来显示失败原因；客户端再和 live 合并）。 */
  listRecentRuns(companyId: string): Promise<PaperclipRunSnapshot[]>;
  /** 任务评论，新的在前，最多 12 条。 */
  listIssueComments(issueId: string): Promise<PaperclipIssueComment[]>;
  /** 某个任务自己的心跳历史（公司级最近 40 条盖不住时用）。 */
  listIssueRuns(issueId: string): Promise<PaperclipRunSnapshot[]>;
  /** 线程交互：提问、确认、建议拆任务。 */
  listIssueInteractions(issueId: string): Promise<PaperclipInteraction[]>;
  acceptIssueInteraction(
    issueId: string,
    interactionId: string,
    body?: { selectedOptionIds?: string[] },
  ): Promise<void>;
  rejectIssueInteraction(issueId: string, interactionId: string, reason?: string): Promise<void>;
  respondIssueInteraction(
    issueId: string,
    interactionId: string,
    answers: ReadonlyArray<{ questionId: string; optionIds: string[]; otherText?: string | null }>,
  ): Promise<void>;
}

interface PaperclipRestClientDeps {
  /** 生效 base URL（无 /api 后缀，客户端统一拼）。每次调用重解析以支持配置热切换。 */
  resolveBaseUrl: () => string | Promise<string>;
  /** 可选 Bearer token；trusted-local 部署返回 null/空。 */
  resolveToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  logger: ServiceLogger;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createPaperclipRestClient(deps: PaperclipRestClientDeps): PaperclipRestClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; parse?: (raw: unknown) => T } = {},
  ): Promise<T> {
    const baseUrl = await deps.resolveBaseUrl();
    const token = await deps.resolveToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      const response = await fetchImpl(`${baseUrl}/api${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      const json: unknown = text ? safeJsonParse(text) : {};
      if (!response.ok) {
        // 只记录方法/路径/状态与上游错误摘要；token 从不进日志。
        const upstreamError =
          json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
            ? (json as { error: string }).error
            : "";
        deps.logger.warn(undefined, "paperclip request rejected", {
          httpStatus: response.status,
          method,
          path,
        });
        throw new PaperclipApiError(
          `paperclip ${method} ${path} failed: HTTP ${response.status}${upstreamError ? ` ${upstreamError}` : ""}`,
          response.status,
          path,
        );
      }
      return options.parse ? options.parse(json) : (json as T);
    } catch (error) {
      if (error instanceof PaperclipApiError) throw error;
      // AbortController 超时与网络层错误（ECONNREFUSED/DNS）统一归一化为 httpStatus=0。
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.warn(undefined, "paperclip request network error", { method, path, reason });
      throw new PaperclipApiError(`paperclip ${method} ${path} network error: ${reason}`, 0, path);
    } finally {
      clearTimeout(timer);
    }
  }

  const healthResponseSchema = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return {};
    const record = raw as Record<string, unknown>;
    const version =
      typeof record.version === "string" ? record.version : undefined;
    return { version };
  };

  return {
    health: () => request("GET", "/health", { parse: healthResponseSchema }),
    listCompanies: () =>
      request("GET", "/companies", {
        parse: (raw) => {
          const list = Array.isArray(raw) ? raw : arrayFromEnvelope(raw);
          return list.map((entry) => paperclipCompanySchema.parse(entry));
        },
      }),
    createCompany: (input) =>
      request("POST", "/companies", {
        body: { name: input.name },
        parse: (raw) => paperclipCompanySchema.parse(raw),
      }),
    listAgents: (companyId) =>
      request("GET", `/companies/${encodeURIComponent(companyId)}/agents`, {
        parse: (raw) => {
          const list = Array.isArray(raw) ? raw : arrayFromEnvelope(raw);
          return list.map((entry) => paperclipAgentSchema.parse(entry));
        },
      }),
    listIssues: (companyId, filter) => {
      const params = new URLSearchParams();
      if (filter?.status?.length) params.set("status", filter.status.join(","));
      if (filter?.assigneeAgentId) params.set("assigneeAgentId", filter.assigneeAgentId);
      const query = params.toString();
      return request("GET", `/companies/${encodeURIComponent(companyId)}/issues${query ? `?${query}` : ""}`, {
        parse: (raw) => {
          const list = Array.isArray(raw) ? raw : arrayFromEnvelope(raw);
          return list.map((entry) => paperclipIssueSchema.parse(entry));
        },
      });
    },
    createIssue: (companyId, input) =>
      request("POST", `/companies/${encodeURIComponent(companyId)}/issues`, {
        body: {
          title: input.title,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.assigneeAgentId === undefined ? {} : { assigneeAgentId: input.assigneeAgentId }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        },
        parse: (raw) => paperclipIssueSchema.parse(raw),
      }),
    updateIssue: (issueId, patch) =>
      request("PATCH", `/issues/${encodeURIComponent(issueId)}`, {
        body: {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }),
          ...(patch.comment === undefined ? {} : { comment: patch.comment }),
        },
        parse: (raw) => paperclipIssueSchema.parse(raw),
      }),
    postComment: (issueId, body) =>
      request("POST", `/issues/${encodeURIComponent(issueId)}/comments`, {
        body: { body },
      }),
    deleteAgent: (agentId) =>
      request("DELETE", `/agents/${encodeURIComponent(agentId)}`, {
        parse: () => undefined,
      }),
    listAdapterModels: (companyId, adapterType) =>
      request("GET", `/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(adapterType)}/models`, {
        parse: (raw) => {
          const list = Array.isArray(raw) ? raw : arrayFromEnvelope(raw);
          return list.flatMap((entry): PaperclipAdapterModel[] => {
            if (!entry || typeof entry !== "object") return [];
            const record = entry as Record<string, unknown>;
            if (typeof record.id !== "string" || !record.id) return [];
            return [
              {
                id: record.id,
                ...(typeof record.label === "string" ? { label: record.label } : {}),
              },
            ];
          });
        },
      }),
    updateAgent: (agentId, patch) =>
      request("PATCH", `/agents/${encodeURIComponent(agentId)}`, {
        body: {
          ...(patch.name === undefined || patch.name.trim() === ""
            ? {}
            : { name: patch.name.trim() }),
          adapterConfig: {
            ...(patch.model === undefined ? {} : { model: patch.model }),
            ...(patch.effort === undefined ? {} : { effort: patch.effort }),
          },
        },
        parse: (raw) => paperclipAgentSchema.parse(raw),
      }),
    createAgent: (companyId, input) =>
      request("POST", `/companies/${encodeURIComponent(companyId)}/agents`, {
        body: {
          name: input.name,
          adapterType: input.adapterType,
          ...(input.role === undefined ? {} : { role: input.role }),
        },
        parse: (raw) => paperclipAgentSchema.parse(raw),
      }),
    listProjects: (companyId) =>
      request("GET", `/companies/${encodeURIComponent(companyId)}/projects`, {
        parse: (raw) => {
          const list = Array.isArray(raw) ? raw : arrayFromEnvelope(raw);
          return list.map((entry) => paperclipProjectSchema.parse(entry));
        },
      }),
    createProject: (companyId, input) =>
      request("POST", `/companies/${encodeURIComponent(companyId)}/projects`, {
        body: {
          name: input.name,
          workspace: {
            sourceType: "local_path",
            cwd: input.cwd,
            isPrimary: true,
          },
        },
        parse: (raw) => paperclipProjectSchema.parse(raw),
      }),
    listLiveRuns: (companyId) =>
      request("GET", `/companies/${encodeURIComponent(companyId)}/live-runs`, {
        parse: (raw) => parsePaperclipRunList(raw),
      }),
    listRecentRuns: (companyId) =>
      request(
        "GET",
        `/companies/${encodeURIComponent(companyId)}/heartbeat-runs?limit=40&summary=true`,
        { parse: (raw) => parsePaperclipRunList(raw) },
      ),
    listIssueComments: (issueId) =>
      request("GET", `/issues/${encodeURIComponent(issueId)}/comments`, {
        parse: (raw) => normalizePaperclipComments(raw),
      }),
    listIssueRuns: (issueId) =>
      request("GET", `/issues/${encodeURIComponent(issueId)}/runs`, {
        parse: (raw) => parsePaperclipRunList(raw),
      }),
    listIssueInteractions: (issueId) =>
      request("GET", `/issues/${encodeURIComponent(issueId)}/interactions`, {
        parse: (raw) => normalizePaperclipInteractions(raw),
      }),
    acceptIssueInteraction: (issueId, interactionId, body) =>
      request("POST", interactionPath(issueId, interactionId, "accept"), {
        body: body ?? {},
        parse: () => undefined,
      }),
    rejectIssueInteraction: (issueId, interactionId, reason) =>
      request("POST", interactionPath(issueId, interactionId, "reject"), {
        body: reason ? { reason } : {},
        parse: () => undefined,
      }),
    respondIssueInteraction: (issueId, interactionId, answers) =>
      request("POST", interactionPath(issueId, interactionId, "respond"), {
        body: { answers },
        parse: () => undefined,
      }),
  };
}

function interactionPath(issueId: string, interactionId: string, action: string): string {
  return `/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${action}`;
}

/** 兼容裸数组与 { issues: [...] } / { agents: [...] } / { data: [...] } 信封。 */
function arrayFromEnvelope(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  for (const key of ["issues", "agents", "companies", "data", "items", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
