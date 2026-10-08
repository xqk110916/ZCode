import { z } from "zod";
import type { PaperclipIssueComment, PaperclipRunSnapshot } from "./paperclipProgress.js";

// ============================================================================
// Paperclip 外部编排服务的共享 DTO
//
// Paperclip（github.com/paperclipai/paperclip）是独立部署的 agent 编排平台，
// ZCode 只是其 REST/WS 客户端。本文件只放 schema 类型 + 纯函数（shared 纪律），
// 运行时连接逻辑在 packages/services 的 node 侧实现。
//
// Paperclip API 迭代快（camelCase 字段、错误体为 { error: string }），所有
// schema 一律 .passthrough() 宽容解析：未知字段透传，新增必填字段缺失时
// 以最小必填集兜底，避免上游演进出的小字段变化打断整份列表解析。
// ============================================================================

/** env 键：部署方覆盖 Paperclip server 默认地址。 */
export const PAPERCLIP_SERVER_URL_ENV = "PAPERCLIP_SERVER_URL";

/** Paperclip 默认地址（官方 quickstart 的本机端口）。 */
export const DEFAULT_PAPERCLIP_SERVER_URL = "http://localhost:3100";

/** 解析生效的 Paperclip server 地址：显式覆盖优先，回落 env 与默认值；非法输入回落默认。 */
export function resolvePaperclipServerUrl(input: {
  settingsValue?: string;
  env?: Record<string, string | undefined>;
}): string {
  const fromSettings = input.settingsValue?.trim();
  if (fromSettings) {
    const normalized = normalizePaperclipServerUrl(fromSettings);
    if (normalized) return normalized;
  }
  const fromEnv = input.env?.[PAPERCLIP_SERVER_URL_ENV]?.trim();
  if (fromEnv) {
    const normalized = normalizePaperclipServerUrl(fromEnv);
    if (normalized) return normalized;
  }
  return DEFAULT_PAPERCLIP_SERVER_URL;
}

/** 规范化 server 地址：去尾部斜杠与 /api 后缀（客户端统一自己拼路径）。空/非法返回 null。 */
export function normalizePaperclipServerUrl(value: string): string | null {
  try {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "/api") path = "";
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

/** Paperclip issue 状态（对应其 issues API 的 status 枚举；未知值透传为字符串）。 */
export const paperclipIssueStatusSchema = z
  .enum(["todo", "in_progress", "in_review", "blocked", "done", "cancelled"])
  .catch("todo");
export type PaperclipIssueStatus = z.infer<typeof paperclipIssueStatusSchema>;

/** Paperclip issue 优先级。 */
export const paperclipIssuePrioritySchema = z
  .enum(["urgent", "high", "medium", "low"])
  .catch("medium");
export type PaperclipIssuePriority = z.infer<typeof paperclipIssuePrioritySchema>;

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

export const paperclipCompanySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().catch(""),
  })
  .passthrough();
export type PaperclipCompany = z.infer<typeof paperclipCompanySchema>;

export const paperclipAgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().catch(""),
    /** adapter 类型（claude_local / grok_local / codex_local …），驱动方式与展示用。 */
    adapterType: z.string().optional().catch(""),
    /** agent 当前模型 id（可能未配置）。 */
    model: z.string().nullish().catch(null),
    /** agent 职级/头衔（Paperclip 组织属性）。 */
    title: z.string().nullish().catch(null),
    /** agent 状态（active/paused 等，Paperclip 侧语义）。 */
    status: z.string().nullish().catch(null),
    /** 组织角色（AGENT_ROLES：ceo/cto/.../general）；"ceo" 用作自动分派的 dispatcher 标识。 */
    role: z.string().optional().catch("general"),
    /** 汇报对象 agent id（组织链）。 */
    reportsTo: z.string().nullish().catch(null),
  })
  .passthrough();
export type PaperclipAgent = z.infer<typeof paperclipAgentSchema>;

/** adapter 可选模型（GET /api/companies/{cid}/adapters/{type}/models）。 */
export interface PaperclipAdapterModel {
  id: string;
  label?: string;
}

/** 推理力度档位（Paperclip 按模型校验，不支持时 422 如实展示）。 */
export const PAPERCLIP_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type PaperclipEffort = (typeof PAPERCLIP_EFFORTS)[number];

/** 更新 agent 配置（PATCH /api/agents/{id}，adapterConfig 为 merge 语义）。 */
export interface PaperclipUpdateAgentInput {
  /** agent 显示名（任务指派、dispatcher 展示用）。 */
  name?: string;
  model?: string;
  effort?: PaperclipEffort;
  /** 组织角色（AGENT_ROLES）；ZCode 侧仅用于切换主 Agent（ceo ↔ general）。 */
  role?: string;
}

/** 本机 CLI 与 Paperclip local adapter 的候选映射（面板「添加本地 agent」用）。 */
export interface PaperclipLocalAdapterCandidate {
  adapterType: string;
  cliName: string;
  /** PATH 上是否可见；不可见时仍可创建，但该 agent 执行会失败——UI 需标注。 */
  available: boolean;
}

export const paperclipIssueSchema = z
  .object({
    id: z.string().min(1),
    /** 人类可读编号（如 PAP-99）。 */
    identifier: z.string().nullish().catch(null),
    title: z.string().optional().catch(""),
    description: z.string().nullish().catch(null),
    status: paperclipIssueStatusSchema,
    priority: paperclipIssuePrioritySchema,
    assigneeAgentId: z.string().nullish().catch(null),
    projectId: z.string().nullish().catch(null),
    goalId: z.string().nullish().catch(null),
    parentId: z.string().nullish().catch(null),
    /** 阻塞本任务的 issue id。上游字段名不稳，两条都收。 */
    blockedByIssueIds: z.array(z.string()).optional(),
    blockedBy: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              id: z.string(),
              identifier: z.string().nullish(),
              title: z.string().nullish(),
            })
            .passthrough(),
        ]),
      )
      .optional(),
    /**
     * 列表接口通常不带 blockedBy，但会带当前阻塞摘要。
     * 形状不稳时丢掉，避免整条任务解析失败。
     */
    blockerAttention: z
      .object({
        directBlockerIssueId: z.string().nullish(),
        terminalBlockerIssueId: z.string().nullish(),
        sampleBlockerIdentifier: z.string().nullish(),
        terminalBlocker: z
          .union([
            z.string(),
            z
              .object({
                id: z.string(),
                identifier: z.string().nullish(),
                title: z.string().nullish(),
              })
              .passthrough(),
          ])
          .nullish(),
      })
      .passthrough()
      .nullish()
      .catch(null),
    createdAt: z.string().nullish().catch(null),
    updatedAt: z.string().nullish().catch(null),
  })
  .passthrough();
export type PaperclipIssue = z.infer<typeof paperclipIssueSchema>;

/** Paperclip 项目（任务的工作区载体；codebase.localFolder 为本地路径）。 */
export const paperclipProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().catch(""),
    codebase: z
      .object({
        localFolder: z.string().nullish().catch(null),
      })
      .nullish()
      .catch({}),
  })
  .passthrough();
export type PaperclipProject = z.infer<typeof paperclipProjectSchema>;

// ---------------------------------------------------------------------------
// 连接状态与事件
// ---------------------------------------------------------------------------

/**
 * 服务连接状态机：
 * - disconnected：未配置 / 探活失败 / 重连等待中
 * - connecting：探活与 companyId 解析进行中
 * - connected：REST 可用且 live-events WS 已建立（任务事件实时推送）
 * - polling：REST 可用但 WS 不可用（认证拒绝或路径不支持），降级为手动/轮询刷新
 */
export const paperclipConnectionStateSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "polling",
]);
export type PaperclipConnectionState = z.infer<typeof paperclipConnectionStateSchema>;

export interface PaperclipConnectionStateSnapshot {
  state: PaperclipConnectionState;
  /** 生效的 server 地址（用于 UI 展示）。 */
  serverUrl: string;
  /** 进入当前状态的时间（epoch ms）。 */
  changedAt: number;
  /** 最近一次失败原因（state 为 disconnected 时可能有值）。 */
  lastError?: string;
}

/** live-events 归一化后的 issue 事件（字段宽容：Paperclip 事件 payload 未稳定承诺）。 */
export interface PaperclipIssueEvent {
  /** 事件粗分类：issue 增删改。 */
  kind: "created" | "updated" | "deleted" | "unknown";
  issueId?: string;
  issue?: PaperclipIssue;
  /** heartbeat run 摘要（type 为 heartbeat.run.* 且 payload 能解析时）。 */
  run?: PaperclipRunSnapshot;
  /** 任务评论（comment 事件能解析出正文时）。 */
  comment?: PaperclipIssueComment;
  /** 原始事件 type 字符串（透传，便于排查）。 */
  rawType?: string;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// 本地 server 生命周期（ZCode 代为启停本机 Paperclip 进程）
// ---------------------------------------------------------------------------

/**
 * 本地 Paperclip server 进程状态（按健康探测合成，非进程句柄跟踪）：
 * - running：/api/health 探活成功
 * - stopped：探活失败且无进行中的启停动作
 * - starting / stopping：本宿主发起的启停动作进行中（多宿主下其他窗口可能看不到瞬时态）
 * - error：启动/停止命令失败或等待健康超时（detail 携带原因）
 */
export type PaperclipLocalServerState =
  | "unknown"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface PaperclipLocalServerStatus {
  state: PaperclipLocalServerState;
  /** 失败原因 / 平台策略提示（如未找到 npx）。 */
  detail?: string;
}

// ---------------------------------------------------------------------------
// 请求输入
// ---------------------------------------------------------------------------

export interface PaperclipCreateIssueInput {
  title: string;
  description?: string;
  priority?: PaperclipIssuePriority;
  /** 指派给哪个 agent（Paperclip 收到后自动入唤醒队列）。 */
  assigneeAgentId?: string;
  projectId?: string;
}

export interface PaperclipUpdateIssueInput {
  title?: string;
  description?: string;
  status?: PaperclipIssueStatus;
  priority?: PaperclipIssuePriority;
  /** PATCH 同时携带的评论（Paperclip 审批门禁要求决策评论同请求提交）。 */
  comment?: string;
}

export interface PaperclipIssueFilter {
  status?: PaperclipIssueStatus[];
  assigneeAgentId?: string;
}

export interface PaperclipTestConnectionResult {
  ok: boolean;
  /** 失败时的人类可读原因（含 HTTP 状态或网络错误摘要）。 */
  error?: string;
  /** 连接成功时的 server 版本/健康信息（尽力解析）。 */
  serverInfo?: {
    version?: string;
  };
}
