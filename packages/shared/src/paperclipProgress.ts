/**
 * Paperclip 运行进度的纯投影。
 *
 * 任务状态机在 issue.status；真正“正在跑”的事实在 heartbeat run（queued/running）
 * 和 issue 评论里。这里把上游不稳的 JSON 收成 UI 能直接画的快照，不发请求。
 */
import type { PaperclipIssueStatus } from "./paperclip.js";

export interface PaperclipIssueComment {
  id: string;
  body: string;
  createdAt: string | null;
  authorKind: "agent" | "user" | "system" | "unknown";
  authorAgentId: string | null;
  authorName: string | null;
}

/** 一条 heartbeat run 的可展示摘要（字段随 Paperclip 版本浮动，解析侧宽容）。 */
export interface PaperclipRunSnapshot {
  id: string;
  issueId: string | null;
  agentId: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  error: string | null;
  /** 一句可读进度（nextAction / 短 triggerDetail / error），没有则为 null。 */
  detail: string | null;
}

export type PaperclipProgressPhase =
  | "todo"
  | "queued"
  | "running"
  | "waiting"
  | "review"
  | "blocked"
  | "failed"
  | "needs_you"
  | "done"
  | "cancelled";

export interface PaperclipIssueProgress {
  /** 四段轨道下标：0 待办、1 执行、2 审查、3 完成。已取消为 -1。 */
  stageIndex: number;
  phase: PaperclipProgressPhase;
  run: PaperclipRunSnapshot | null;
  latestComment: PaperclipIssueComment | null;
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "pending", "scheduled_retry"]);
const QUEUED_RUN_STATUSES = new Set(["queued", "pending", "scheduled_retry"]);
/** triggerDetail 里这些值只是唤醒来源，不是给用户看的进度说明。 */
const GENERIC_TRIGGER_DETAILS = new Set([
  "system",
  "assignment",
  "automation",
  "manual",
  "schedule",
  "heartbeat",
  "timer",
]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "interrupted", "error"]);
const COMMENT_FETCH_STATUSES = new Set(["in_progress", "in_review", "blocked"]);

export function isPaperclipRunActive(status: string): boolean {
  return ACTIVE_RUN_STATUSES.has(status.toLowerCase());
}

export function isPaperclipRunFailed(status: string): boolean {
  return FAILED_RUN_STATUSES.has(status.toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readError(record: Record<string, unknown>): string | null {
  const direct = readString(record.error);
  if (direct) return direct;
  const nested = asRecord(record.error);
  const nestedMessage = nested ? readString(nested.message) : null;
  if (nestedMessage) return nestedMessage;
  return readString(record.errorMessage);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 兼容裸数组与 { runs/comments/data/... } 信封。 */
export function unwrapPaperclipList(raw: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export function parsePaperclipRun(raw: unknown): PaperclipRunSnapshot | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = readString(record.id);
  if (!id) return null;
  // issue 行也有 id + status。没有 run 专有字段时不当成心跳。
  const context = asRecord(record.contextSnapshot);
  const looksLikeRun = Boolean(
    context ||
      readString(record.startedAt) ||
      readString(record.invocationSource) ||
      readString(record.nextAction) ||
      readString(record.triggerDetail),
  );
  if (!looksLikeRun && readString(record.title)) return null;
  if (!looksLikeRun && !readString(record.status)) return null;
  const issueId =
    readString(record.issueId) ??
    (context ? readString(context.issueId) : null) ??
    readString(record.nativeIssueId);
  const error = readError(record);
  const nextAction = readString(record.nextAction);
  const triggerDetail = readString(record.triggerDetail);
  const usefulTrigger =
    triggerDetail &&
    triggerDetail.length <= 180 &&
    !GENERIC_TRIGGER_DETAILS.has(triggerDetail.toLowerCase())
      ? triggerDetail
      : null;
  const detailSource = error ?? nextAction ?? usefulTrigger;
  return {
    id,
    issueId,
    agentId: readString(record.agentId),
    status: readString(record.status) ?? "unknown",
    startedAt: readString(record.startedAt),
    finishedAt: readString(record.finishedAt),
    createdAt: readString(record.createdAt),
    error,
    detail: detailSource ? clip(detailSource, 240) : null,
  };
}

export function parsePaperclipRunList(raw: unknown): PaperclipRunSnapshot[] {
  return unwrapPaperclipList(raw, ["runs", "heartbeatRuns", "items", "data", "results"]).flatMap(
    (entry) => {
      const run = parsePaperclipRun(entry);
      return run ? [run] : [];
    },
  );
}

export function parsePaperclipComment(raw: unknown): PaperclipIssueComment | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = readString(record.id) ?? readString(record.commentId);
  const body = readString(record.body) ?? readString(record.content) ?? readString(record.text);
  if (!id || !body) return null;
  const author = asRecord(record.author);
  const authorAgentId =
    readString(record.authorAgentId) ??
    readString(record.createdByAgentId) ??
    readString(record.agentId);
  const authorUserId = readString(record.authorUserId) ?? readString(record.createdByUserId) ?? readString(record.userId);
  const authorType = (readString(record.authorType) ?? readString(record.authorKind) ?? "").toLowerCase();
  const authorKind: PaperclipIssueComment["authorKind"] = authorAgentId
    ? "agent"
    : authorUserId
      ? "user"
      : authorType.includes("system")
        ? "system"
        : "unknown";
  return {
    id,
    body: clip(body, 8000),
    createdAt: readString(record.createdAt) ?? readString(record.created_at),
    authorKind,
    authorAgentId,
    authorName: readString(record.authorName) ?? (author ? readString(author.name) : null),
  };
}

/** 评论按时间倒序，只留最近 12 条（面板进度不回放整条线程）。 */
export function normalizePaperclipComments(raw: unknown): PaperclipIssueComment[] {
  const parsed = unwrapPaperclipList(raw, ["comments", "items", "data", "results"]).flatMap(
    (entry) => {
      const comment = parsePaperclipComment(entry);
      return comment ? [comment] : [];
    },
  );
  parsed.sort((a, b) => {
    const ta = Date.parse(a.createdAt ?? "") || 0;
    const tb = Date.parse(b.createdAt ?? "") || 0;
    return tb - ta;
  });
  return parsed.slice(0, 12);
}

/**
 * live-events payload 形状不稳：run 可能嵌在 run/heartbeatRun，也可能就是 payload 本身。
 * 认不出就返回 null，调用方仍可按 issueId 去拉列表。
 */
export function readPaperclipLiveExtras(payload: unknown): {
  run: PaperclipRunSnapshot | null;
  comment: PaperclipIssueComment | null;
} {
  const record = asRecord(payload);
  if (!record) return { run: null, comment: null };
  const nestedRun = record.run ?? record.heartbeatRun ?? record.heartbeat_run;
  const parsedRun = parsePaperclipRun(nestedRun) ?? parsePaperclipRun(record);
  const payloadIssueId = readString(record.issueId);
  const run =
    parsedRun && !parsedRun.issueId && payloadIssueId
      ? { ...parsedRun, issueId: payloadIssueId }
      : parsedRun;
  const nestedComment = record.comment ?? record.issueComment;
  const comment =
    parsePaperclipComment(nestedComment) ??
    (readString(record.body) ? parsePaperclipComment(record) : null);
  return { run, comment };
}

/** live 列表覆盖同 id 的历史行；issueId 以有值为准，避免 summary 行把关联冲掉。 */
export function mergePaperclipRuns(
  live: readonly PaperclipRunSnapshot[],
  recent: readonly PaperclipRunSnapshot[],
): PaperclipRunSnapshot[] {
  const byId = new Map<string, PaperclipRunSnapshot>();
  for (const run of recent) byId.set(run.id, run);
  for (const run of live) {
    const previous = byId.get(run.id);
    byId.set(
      run.id,
      previous
        ? {
            ...previous,
            ...run,
            issueId: run.issueId ?? previous.issueId,
            agentId: run.agentId ?? previous.agentId,
            error: run.error ?? previous.error,
            detail: run.detail ?? previous.detail,
          }
        : run,
    );
  }
  return [...byId.values()];
}

function runRank(run: PaperclipRunSnapshot): number {
  const time = Date.parse(run.startedAt ?? run.createdAt ?? "") || 0;
  return (isPaperclipRunActive(run.status) ? 1e15 : 0) + time;
}

/** 同一任务只留一条：进行中的优先，否则取最近一条。 */
export function latestPaperclipRunForIssue(
  runs: readonly PaperclipRunSnapshot[],
  issueId: string,
): PaperclipRunSnapshot | null {
  let best: PaperclipRunSnapshot | null = null;
  for (const run of runs) {
    if (run.issueId !== issueId) continue;
    if (!best || runRank(run) > runRank(best)) best = run;
  }
  return best;
}

const MAX_COMMENT_FETCHES = 8;

/** 只给正在动的任务拉评论，避免每轮把全部历史 issue 的线程打下来。 */
export function selectPaperclipCommentIssueIds(
  issues: readonly { id: string; status: string; updatedAt?: string | null; createdAt?: string | null }[],
  runs: readonly PaperclipRunSnapshot[],
): string[] {
  const ranked = [...issues].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? a.createdAt ?? "") || 0;
    const tb = Date.parse(b.updatedAt ?? b.createdAt ?? "") || 0;
    return tb - ta;
  });
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id) || ids.length >= MAX_COMMENT_FETCHES) return;
    seen.add(id);
    ids.push(id);
  };
  for (const run of runs) {
    if (isPaperclipRunActive(run.status)) push(run.issueId);
  }
  for (const issue of ranked) {
    if (COMMENT_FETCH_STATUSES.has(issue.status)) push(issue.id);
  }
  return ids;
}

export function paperclipHasLiveWork(
  issues: readonly { status: string }[],
  runs: readonly PaperclipRunSnapshot[],
): boolean {
  if (runs.some((run) => isPaperclipRunActive(run.status))) return true;
  return issues.some(
    (issue) => issue.status === "in_progress" || issue.status === "in_review" || issue.status === "blocked",
  );
}

export function derivePaperclipIssueProgress(input: {
  status: PaperclipIssueStatus;
  run: PaperclipRunSnapshot | null;
  comments: readonly PaperclipIssueComment[];
  /** 有待人处理的线程交互（提问、确认、验收）。 */
  needsHuman?: boolean;
}): PaperclipIssueProgress {
  const latestComment = input.comments[0] ?? null;
  const run = input.run;
  const active = run ? isPaperclipRunActive(run.status) : false;
  const queued = run ? QUEUED_RUN_STATUSES.has(run.status.toLowerCase()) : false;
  const failed = run ? isPaperclipRunFailed(run.status) : false;
  const withHuman = (progress: PaperclipIssueProgress): PaperclipIssueProgress =>
    input.needsHuman && progress.phase !== "done" && progress.phase !== "cancelled"
      ? { ...progress, phase: "needs_you" }
      : progress;
  if (input.status === "cancelled") {
    return { stageIndex: -1, phase: "cancelled", run, latestComment };
  }
  if (input.status === "done") {
    return { stageIndex: 3, phase: "done", run, latestComment };
  }
  if (input.status === "blocked") {
    return withHuman({ stageIndex: 1, phase: "blocked", run, latestComment });
  }
  if (input.status === "in_review") {
    return withHuman({ stageIndex: 2, phase: active ? "running" : "review", run, latestComment });
  }
  if (input.status === "in_progress" || active) {
    // 心跳已经在跑时，即使 issue 状态还停在 todo，进度条也进到「执行」。
    const stageIndex = input.status === "todo" && queued ? 0 : 1;
    if (queued) return withHuman({ stageIndex, phase: "queued", run, latestComment });
    if (active) return withHuman({ stageIndex: 1, phase: "running", run, latestComment });
    if (failed && input.status === "in_progress") {
      return withHuman({ stageIndex: 1, phase: "failed", run, latestComment });
    }
    if (input.status === "in_progress") {
      return withHuman({ stageIndex: 1, phase: "waiting", run, latestComment });
    }
  }
  return withHuman({ stageIndex: 0, phase: "todo", run, latestComment });
}

/** 心跳已跑了多久。locale 以 zh 开头用中文单位，其余用紧凑英文。 */
export function formatPaperclipElapsed(
  fromIso: string | null | undefined,
  nowMs: number,
  locale: string,
): string {
  if (!fromIso) return "";
  const start = Date.parse(fromIso);
  if (Number.isNaN(start)) return "";
  const total = Math.max(0, Math.floor((nowMs - start) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const zh = locale.toLowerCase().startsWith("zh");
  if (hours > 0) return zh ? `${hours} 小时 ${minutes} 分` : `${hours}h ${minutes}m`;
  if (minutes > 0) return zh ? `${minutes} 分 ${seconds} 秒` : `${minutes}m ${seconds}s`;
  return zh ? `${seconds} 秒` : `${seconds}s`;
}
