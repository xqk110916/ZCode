/**
 * 一条 Paperclip 任务：四段进度轨 + 当前心跳/最新评论。
 * 展开后是描述和最近的执行记录，不必打开 Paperclip 自己的页面。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, Zap } from "lucide-react";
import type {
  PaperclipAgent,
  PaperclipInteraction,
  PaperclipIssue,
  PaperclipIssueComment,
  PaperclipIssuePriority,
  PaperclipProgressPhase,
  PaperclipRunSnapshot,
} from "@zcode/shared";
import {
  derivePaperclipIssueProgress,
  formatPaperclipElapsed,
  isPaperclipDecisionInteraction,
  paperclipIssueNeedsHuman,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { PaperclipIssueDetail } from "@/paperclip/PaperclipIssueDetail.js";
import {
  agentDisplayName,
  findAgentName,
  formatTimestamp,
  priorityLabelKey,
} from "@/paperclip/paperclipViews.js";

const STAGE_LABELS = [
  "paperclip.progress.stageTodo",
  "paperclip.progress.stageRun",
  "paperclip.progress.stageReview",
  "paperclip.progress.stageDone",
] as const;

const PHASE_MESSAGE: Record<PaperclipProgressPhase, string> = {
  todo: "paperclip.progress.todo",
  queued: "paperclip.progress.queued",
  running: "paperclip.progress.running",
  waiting: "paperclip.progress.waiting",
  review: "paperclip.progress.review",
  blocked: "paperclip.progress.blocked",
  failed: "paperclip.progress.failed",
  needs_you: "paperclip.progress.needsYou",
  done: "paperclip.progress.done",
  cancelled: "paperclip.progress.cancelled",
};

function priorityBadgeClass(priority: PaperclipIssuePriority): string {
  switch (priority) {
    case "urgent":
      return "bg-danger-subtle text-danger";
    case "high":
      return "bg-warning-subtle text-warning";
    case "medium":
      return "bg-info-subtle text-info";
    default:
      return "bg-surface-muted text-foreground-subtle";
  }
}

function accentClass(phase: PaperclipProgressPhase): string {
  switch (phase) {
    case "running":
    case "queued":
    case "waiting":
      return "bg-info";
    case "review":
    case "needs_you":
      return "bg-warning";
    case "blocked":
    case "failed":
      return "bg-danger";
    case "done":
      return "bg-success";
    default:
      return "bg-border";
  }
}

function segmentClass(index: number, stageIndex: number, phase: PaperclipProgressPhase): string {
  if (stageIndex < 0) return "bg-surface-muted";
  if (phase === "done") return "bg-success";
  if (index < stageIndex) return "bg-success/80";
  if (index > stageIndex) return "bg-surface-muted";
  if (phase === "running" || phase === "queued") return "bg-info animate-pulse";
  if (phase === "waiting") return "bg-info/70";
  if (phase === "review" || phase === "needs_you") return "bg-warning";
  if (phase === "blocked" || phase === "failed") return "bg-danger";
  return "bg-foreground/25";
}

function commentSnippet(body: string): string {
  const line = body.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function PaperclipIssueRow({
  issue,
  locale,
  assignee,
  agents,
  run,
  runs,
  comments,
  interactions,
  childProgress,
  openDescendants,
  blockerLabels,
  onMarkDone,
  onOpen,
  onReply,
  onAcceptReview,
  onSendBack,
  onAcceptInteraction,
  onRejectInteraction,
  onRespondInteraction,
  onExecuteInZCode,
  zcodeAgentOwned,
}: {
  issue: PaperclipIssue;
  locale: string;
  assignee: PaperclipAgent | null;
  agents: readonly PaperclipAgent[];
  run: PaperclipRunSnapshot | null;
  runs: readonly PaperclipRunSnapshot[];
  comments: readonly PaperclipIssueComment[];
  interactions: readonly PaperclipInteraction[];
  childProgress: { total: number; done: number };
  openDescendants: number;
  blockerLabels: readonly string[];
  onMarkDone: () => void;
  onOpen: () => void;
  onReply: (body: string) => Promise<boolean>;
  onAcceptReview: (comment: string) => Promise<boolean>;
  onSendBack: (comment: string) => Promise<boolean>;
  onAcceptInteraction: (interactionId: string, selectedOptionIds: string[]) => Promise<boolean>;
  onRejectInteraction: (interactionId: string) => Promise<boolean>;
  onRespondInteraction: (
    interactionId: string,
    answers: ReadonlyArray<{ questionId: string; optionIds: string[] }>,
  ) => Promise<boolean>;
  /** 指派给 ZCode（http agent）的任务显示「在 ZCode 中执行」；缺省不渲染。 */
  onExecuteInZCode?: () => void;
  /** 本任务指派给 ZCode（http agent）：blocked 按模式语义显示为「待 ZCode 执行」。 */
  zcodeAgentOwned?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (expanded) onOpenRef.current();
  }, [expanded]);

  const needsHuman = paperclipIssueNeedsHuman(interactions);
  const pendingDecision = interactions.some(isPaperclipDecisionInteraction);
  const canComplete = openDescendants === 0;
  const progress = derivePaperclipIssueProgress({
    status: issue.status,
    run,
    comments,
    needsHuman,
  });
  const ticking = progress.phase === "running" || progress.phase === "queued";
  const now = useNow(ticking);
  const elapsed = ticking
    ? formatPaperclipElapsed(run?.startedAt ?? run?.createdAt, now, locale)
    : "";
  // ZCode 自主执行的任务由 Paperclip 账本规则标 blocked（paused agent 的未结任务
  // 自动挂起），语义是"等 ZCode 处理"而非"受阻"——按中性"待执行"呈现。
  const zcodePending =
    progress.phase === "blocked" && issue.assigneeAgentId !== null && zcodeAgentOwned;
  const phaseLabel = zcodePending
    ? intl.formatMessage({ id: "paperclip.progress.zcodePending" })
    : intl.formatMessage({ id: PHASE_MESSAGE[progress.phase] });
  const agentName =
    (assignee ? agentDisplayName(assignee) : null) ??
    (run?.agentId ? findAgentName(agents, run.agentId) : null);
  const snippet = progress.latestComment
    ? commentSnippet(progress.latestComment.body)
    : (run?.detail ?? "");
  const showError =
    progress.phase === "failed" &&
    Boolean(run?.error) &&
    run?.error !== snippet;
  const updated = formatTimestamp(issue.updatedAt ?? issue.createdAt, locale);

  return (
    // 根元素用 div：本组件只被 IssueBranch 包在 <li> 内渲染（树形列表的 li 承载
    // 「行 + 子树 ul」），若自身也是 li 会形成 li 嵌套 li 的非法 HTML。
    <div
      data-testid="paperclip-issue-row"
      className="relative overflow-hidden rounded-xl border border-card-border bg-card transition-colors hover:border-border-hover"
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-0.5",
          zcodePending ? "bg-foreground/25" : accentClass(progress.phase),
        )}
        aria-hidden
      />
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        }}
        className="flex cursor-pointer flex-col gap-2 py-3 pr-3 pl-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          {issue.identifier ? (
            <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest">
              {issue.identifier}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{issue.title}</span>
          <Badge variant="secondary" className={cn("text-ui-xs", priorityBadgeClass(issue.priority))}>
            {intl.formatMessage({ id: priorityLabelKey(issue.priority) })}
          </Badge>
          {updated ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">{updated}</span>
          ) : null}
          {childProgress.total > 0 ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "paperclip.issues.children" },
                { done: childProgress.done, total: childProgress.total },
              )}
            </span>
          ) : null}
          {openDescendants > 0 ? (
            <span className="shrink-0 text-ui-xs text-warning">
              {intl.formatMessage({ id: "paperclip.issues.openChildren" }, { count: openDescendants })}
            </span>
          ) : null}
          {issue.status !== "done" && issue.status !== "cancelled" && issue.status !== "in_review" && !pendingDecision ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-ui-sm"
              disabled={!canComplete}
              title={canComplete ? undefined : intl.formatMessage({ id: "paperclip.issues.cannotComplete" })}
              onClick={(event) => {
                event.stopPropagation();
                if (canComplete) onMarkDone();
              }}
            >
              <CircleCheck className="size-4" />
              {intl.formatMessage({ id: "paperclip.issues.markDone" })}
            </Button>
          ) : null}
          {onExecuteInZCode && issue.status !== "done" && issue.status !== "cancelled" ? (
            <Button
              variant="outline"
              size="sm"
              className="text-ui-sm"
              title={intl.formatMessage({ id: "paperclip.issues.executeInZCodeHint" })}
              onClick={(event) => {
                event.stopPropagation();
                onExecuteInZCode();
              }}
            >
              <Zap className="size-4" />
              {intl.formatMessage({ id: "paperclip.issues.executeInZCode" })}
            </Button>
          ) : null}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-foreground-subtlest transition-transform",
              expanded && "rotate-180",
            )}
          />
        </div>
        <div
          className="flex h-1.5 gap-1"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={progress.stageIndex < 0 ? 0 : progress.stageIndex + 1}
          aria-valuetext={phaseLabel}
        >
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={cn(
                "h-full flex-1 rounded-full",
                zcodePending
                  ? segmentClass(index, progress.stageIndex, "waiting")
                  : segmentClass(index, progress.stageIndex, progress.phase),
              )}
            />
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1">
          {STAGE_LABELS.map((id, index) => (
            <span
              key={id}
              className={cn(
                "truncate text-center text-ui-xs",
                progress.stageIndex < 0 || index > progress.stageIndex
                  ? "text-foreground-subtlest"
                  : index === progress.stageIndex
                    ? "text-foreground"
                    : "text-foreground-subtle",
              )}
            >
              {intl.formatMessage({ id })}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="truncate text-ui-sm text-foreground-subtle">
            <span className={cn(ticking && "text-info")}>{phaseLabel}</span>
            {agentName ? <span className="text-foreground-subtlest"> · {agentName}</span> : null}
            {elapsed ? (
              <span className="text-foreground-subtlest">
                {" · "}
                {intl.formatMessage({ id: "paperclip.progress.elapsed" }, { duration: elapsed })}
              </span>
            ) : null}
          </p>
          {snippet ? (
            <p className="truncate text-ui-sm text-foreground">{snippet}</p>
          ) : null}
          {showError ? <p className="truncate text-ui-sm text-danger">{run?.error}</p> : null}
          {blockerLabels.length > 0 ? (
            <p className="truncate text-ui-xs text-warning">
              {intl.formatMessage(
                { id: "paperclip.issues.blockedBy" },
                { labels: blockerLabels.join(", ") },
              )}
            </p>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <PaperclipIssueDetail
          issue={issue}
          locale={locale}
          agents={agents}
          comments={comments}
          runs={runs}
          interactions={interactions}
          canComplete={canComplete}
          onReply={onReply}
          onAcceptReview={onAcceptReview}
          onSendBack={onSendBack}
          onAcceptInteraction={onAcceptInteraction}
          onRejectInteraction={onRejectInteraction}
          onRespondInteraction={onRespondInteraction}
        />
      ) : null}
    </div>
  );
}
