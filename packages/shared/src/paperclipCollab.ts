/**
 * 多 Agent 协同的纯投影：任务树、阻塞、等人处理的交互、心跳历史。
 * 不发请求。Paperclip 仍是事实源。
 */
import type { PaperclipIssue, PaperclipIssueStatus } from "./paperclip.js";
import type { PaperclipIssueComment, PaperclipRunSnapshot } from "./paperclipProgress.js";

const SETTLED: ReadonlySet<PaperclipIssueStatus> = new Set(["done", "cancelled"]);
const HUMAN_KINDS = new Set([
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "suggest_tasks",
]);
const RUN_HISTORY_LIMIT = 8;

export interface PaperclipIssueTreeNode {
  issue: PaperclipIssue;
  children: PaperclipIssueTreeNode[];
}

export interface PaperclipQuestionOption {
  id: string;
  label: string;
}

export interface PaperclipQuestion {
  id: string;
  prompt: string;
  selectionMode: "single" | "multi";
  options: PaperclipQuestionOption[];
}

/** 一条待人处理或已结束的线程交互（提问、确认、建议拆任务）。 */
export interface PaperclipInteraction {
  id: string;
  issueId: string | null;
  kind: string;
  status: string;
  title: string | null;
  summary: string | null;
  questions: PaperclipQuestion[];
  options: PaperclipQuestionOption[];
}

export interface PaperclipAgentWorkload {
  /** 正在执行，或已领取还在进行中的那一条。 */
  current: PaperclipIssue | null;
  /** 派给该 agent、尚未开始的任务。 */
  queue: PaperclipIssue[];
}

export function paperclipIssueSettled(status: string): boolean {
  return SETTLED.has(status as PaperclipIssueStatus);
}

/** 父任务下挂子任务。父节点不在本次列表里时，子任务自己当根。环被剪断。 */
export function groupPaperclipIssues(issues: readonly PaperclipIssue[]): PaperclipIssueTreeNode[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const childMap = new Map<string, PaperclipIssue[]>();
  const roots: PaperclipIssue[] = [];
  for (const issue of issues) {
    const parentId = issue.parentId;
    if (parentId && parentId !== issue.id && byId.has(parentId)) {
      const list = childMap.get(parentId) ?? [];
      list.push(issue);
      childMap.set(parentId, list);
    } else {
      roots.push(issue);
    }
  }
  const seen = new Set<string>();
  const build = (issue: PaperclipIssue): PaperclipIssueTreeNode => {
    seen.add(issue.id);
    const children = (childMap.get(issue.id) ?? []).flatMap((child) =>
      seen.has(child.id) ? [] : [build(child)],
    );
    return { issue, children };
  };
  const forest = roots.map((issue) => build(issue));
  // 环没有根（A 的父是 B，B 的父是 A）。从环上任一点展开，已访问的回边剪掉。
  for (const issue of issues) {
    if (!seen.has(issue.id)) forest.push(build(issue));
  }
  return forest;
}

export function filterPaperclipForest(
  nodes: readonly PaperclipIssueTreeNode[],
  predicate: (issue: PaperclipIssue) => boolean,
): PaperclipIssueTreeNode[] {
  const prune = (node: PaperclipIssueTreeNode): PaperclipIssueTreeNode | null => {
    const children = node.children.flatMap((child) => {
      const next = prune(child);
      return next ? [next] : [];
    });
    if (!predicate(node.issue) && children.length === 0) return null;
    return { issue: node.issue, children };
  };
  return nodes.flatMap((node) => {
    const next = prune(node);
    return next ? [next] : [];
  });
}

export function paperclipOpenDescendantCount(
  issueId: string,
  issues: readonly PaperclipIssue[],
): number {
  const childMap = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.parentId || issue.parentId === issue.id) continue;
    const list = childMap.get(issue.parentId) ?? [];
    list.push(issue.id);
    childMap.set(issue.parentId, list);
  }
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  let count = 0;
  const stack = [...(childMap.get(issueId) ?? [])];
  const seen = new Set<string>([issueId]);
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const issue = byId.get(id);
    if (issue && !paperclipIssueSettled(issue.status)) count += 1;
    for (const childId of childMap.get(id) ?? []) stack.push(childId);
  }
  return count;
}

export function paperclipChildProgress(
  issueId: string,
  issues: readonly PaperclipIssue[],
): { total: number; done: number } {
  const children = issues.filter((issue) => issue.parentId === issueId);
  const done = children.filter((issue) => paperclipIssueSettled(issue.status)).length;
  return { total: children.length, done };
}

export function paperclipBlockerIds(issue: PaperclipIssue): string[] {
  const ids = new Set<string>();
  for (const id of issue.blockedByIssueIds ?? []) {
    if (id) ids.add(id);
  }
  for (const entry of issue.blockedBy ?? []) {
    if (typeof entry === "string" && entry) ids.add(entry);
    else if (entry && typeof entry === "object" && entry.id) ids.add(entry.id);
  }
  const attention = issue.blockerAttention;
  if (attention) {
    if (attention.directBlockerIssueId) ids.add(attention.directBlockerIssueId);
    if (attention.terminalBlockerIssueId) ids.add(attention.terminalBlockerIssueId);
    const terminal = attention.terminalBlocker;
    if (typeof terminal === "string" && terminal) ids.add(terminal);
    else if (terminal && typeof terminal === "object" && terminal.id) ids.add(terminal.id);
  }
  ids.delete(issue.id);
  return [...ids];
}

export function paperclipAgentWorkload(
  agentId: string,
  issues: readonly PaperclipIssue[],
  latestRunByIssueId: Readonly<Record<string, PaperclipRunSnapshot | undefined>>,
): PaperclipAgentWorkload {
  const assigned = issues.filter(
    (issue) => issue.assigneeAgentId === agentId && !paperclipIssueSettled(issue.status),
  );
  const running = assigned.find(
    (issue) => latestRunByIssueId[issue.id]?.status.toLowerCase() === "running",
  );
  const current =
    running ??
    assigned.find((issue) => issue.status === "in_progress") ??
    assigned.find((issue) => issue.status === "in_review") ??
    null;
  const queue = assigned.filter(
    (issue) => issue.id !== current?.id && (issue.status === "todo" || issue.status === "blocked"),
  );
  return { current, queue };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readQuestions(payload: Record<string, unknown> | null): PaperclipQuestion[] {
  const raw = payload?.questions ?? payload?.items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const id = readString(record.id) ?? readString(record.questionId);
    const prompt = readString(record.prompt) ?? readString(record.label) ?? readString(record.title);
    if (!id || !prompt) return [];
    const mode = readString(record.selectionMode) === "multi" ? "multi" : "single";
    const options = readOptions(record.options);
    return [{ id, prompt, selectionMode: mode, options }];
  });
}

function readOptions(raw: unknown): PaperclipQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [{ id: entry.trim(), label: entry.trim() }];
    const record = asRecord(entry);
    if (!record) return [];
    const id = readString(record.id) ?? readString(record.value);
    const label = readString(record.label) ?? readString(record.title) ?? id;
    if (!id || !label) return [];
    return [{ id, label }];
  });
}

export function parsePaperclipInteraction(raw: unknown): PaperclipInteraction | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = readString(record.id);
  if (!id) return null;
  const payload = asRecord(record.payload);
  const questions = readQuestions(payload);
  const options = questions.length > 0 ? [] : readOptions(payload?.options ?? payload?.items);
  return {
    id,
    issueId: readString(record.issueId),
    kind: readString(record.kind) ?? "unknown",
    status: readString(record.status) ?? "pending",
    title: readString(record.title),
    summary: readString(record.summary) ?? readString(payload?.summaryMarkdown),
    questions,
    options,
  };
}

export function normalizePaperclipInteractions(raw: unknown): PaperclipInteraction[] {
  const record = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : record
      ? [record.interactions, record.items, record.data, record.results].find(Array.isArray)
      : [];
  const parsed = (Array.isArray(list) ? list : []).flatMap((entry) => {
    const interaction = parsePaperclipInteraction(entry);
    return interaction ? [interaction] : [];
  });
  parsed.sort((a, b) => Number(isPaperclipInteractionPending(b)) - Number(isPaperclipInteractionPending(a)));
  return parsed;
}

const DECISION_KINDS = new Set([
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
  "suggest_tasks",
]);

export function isPaperclipInteractionPending(interaction: PaperclipInteraction): boolean {
  return interaction.status.toLowerCase() === "pending" && HUMAN_KINDS.has(interaction.kind);
}

/** 确认、勾选、建议拆任务。有这类待处理交互时，不再叠一层审查通过/打回。 */
export function isPaperclipDecisionInteraction(interaction: PaperclipInteraction): boolean {
  return isPaperclipInteractionPending(interaction) && DECISION_KINDS.has(interaction.kind);
}

export function paperclipIssueNeedsHuman(
  interactions: readonly PaperclipInteraction[] | undefined,
): boolean {
  return (interactions ?? []).some(isPaperclipInteractionPending);
}

/** 同 id 覆盖；新 id 插到最前。公司级列表和单任务 runs 都走这里。 */
export function upsertPaperclipRun(
  runs: readonly PaperclipRunSnapshot[],
  run: PaperclipRunSnapshot,
): PaperclipRunSnapshot[] {
  const without = runs.filter((item) => item.id !== run.id);
  return [run, ...without];
}

export function paperclipRunsForIssue(
  runs: readonly PaperclipRunSnapshot[],
  issueId: string,
): PaperclipRunSnapshot[] {
  return runs
    .filter((run) => run.issueId === issueId)
    .sort((a, b) => {
      const ta = Date.parse(a.startedAt ?? a.createdAt ?? "") || 0;
      const tb = Date.parse(b.startedAt ?? b.createdAt ?? "") || 0;
      return tb - ta;
    })
    .slice(0, RUN_HISTORY_LIMIT);
}

export function mergePaperclipComment(
  comments: readonly PaperclipIssueComment[],
  comment: PaperclipIssueComment,
): PaperclipIssueComment[] {
  return [comment, ...comments.filter((item) => item.id !== comment.id)].slice(0, 12);
}
