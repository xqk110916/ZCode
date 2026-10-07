/**
 * Paperclip 面板的展示子组件：agent 卡片与任务行。
 * 纯投影展示，不含数据获取（数据在 usePaperclip）。
 */
import { Bot, CircleCheck, Settings2, Sparkles } from "lucide-react";
import type {
  PaperclipAgent,
  PaperclipIssue,
  PaperclipIssuePriority,
  PaperclipIssueStatus,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export function statusLabelKey(status: PaperclipIssueStatus): string {
  return `paperclip.status.${status}`;
}

export function priorityLabelKey(priority: PaperclipIssuePriority): string {
  return `paperclip.priority.${priority}`;
}

export function agentDisplayName(agent: PaperclipAgent): string {
  if (agent.name) return agent.name;
  return agent.adapterType || agent.id;
}

export function findAgentName(
  agents: PaperclipAgent[],
  assigneeAgentId: string | null | undefined,
): string | null {
  if (!assigneeAgentId) return null;
  const agent = agents.find((candidate) => candidate.id === assigneeAgentId);
  return agent ? agentDisplayName(agent) : null;
}

export function formatTimestamp(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

function statusBadgeClass(status: PaperclipIssueStatus): string {
  switch (status) {
    case "in_progress":
      return "bg-info-subtle text-info";
    case "in_review":
      return "bg-warning-subtle text-warning";
    case "done":
      return "bg-success-subtle text-success";
    case "blocked":
      return "bg-danger-subtle text-danger";
    case "cancelled":
      return "bg-surface-muted text-foreground-subtlest";
    default:
      return "bg-surface-muted text-foreground-subtle";
  }
}

/** 优先级用语义色区分强度：紧急=危险、高=警告、中=信息、低=弱化。 */
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

/** Paperclip agent 状态（active/paused 等）：已知值走 i18n 与语义色，未知值原样弱展示。 */
function agentStatusPresentation(status: string): {
  labelKey: string | null;
  className: string;
} {
  switch (status) {
    case "active":
      return {
        labelKey: "paperclip.agentStatus.active",
        className: "bg-success-subtle text-success",
      };
    case "paused":
      return {
        labelKey: "paperclip.agentStatus.paused",
        className: "bg-warning-subtle text-warning",
      };
    default:
      return { labelKey: null, className: "bg-surface-muted text-foreground-subtle" };
  }
}

export function PaperclipAgentCard({
  agent,
  onConfigure,
}: {
  agent: PaperclipAgent;
  onConfigure?: (agent: PaperclipAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const status = agent.status ? agentStatusPresentation(agent.status) : null;
  const isDispatcher = agent.role === "ceo";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-4">
      <div className="flex items-center gap-2">
        <Bot className="size-4 shrink-0 text-foreground-subtle" />
        <span className="truncate text-ui-base font-medium text-foreground">
          {agentDisplayName(agent)}
        </span>
        {agent.title ? (
          <span className="truncate text-ui-sm text-foreground-subtle">{agent.title}</span>
        ) : null}
        {onConfigure ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0"
            aria-label={intl.formatMessage({ id: "paperclip.agentConfig.open" })}
            onClick={() => onConfigure(agent)}
          >
            <Settings2 className="size-4" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {isDispatcher ? (
          <Badge
            variant="secondary"
            className="gap-1 bg-info-subtle text-info text-ui-sm"
          >
            <Sparkles className="size-3" />
            {intl.formatMessage({ id: "paperclip.agents.dispatcher" })}
          </Badge>
        ) : null}
        {agent.adapterType ? (
          <Badge variant="secondary" className="text-ui-sm">
            {agent.adapterType}
          </Badge>
        ) : null}
        {agent.model ? (
          <Badge variant="outline" className="text-ui-sm">
            {agent.model}
          </Badge>
        ) : null}
        {status ? (
          <Badge variant="secondary" className={cn("text-ui-sm", status.className)}>
            {status.labelKey ? intl.formatMessage({ id: status.labelKey }) : (agent.status ?? "")}
          </Badge>
        ) : null}
      </div>
      <p className="text-ui-sm text-foreground-subtlest">
        {intl.formatMessage({ id: "paperclip.agents.managedExternally" })}
      </p>
    </div>
  );
}

export function PaperclipIssueRow({
  issue,
  locale,
  agentName,
  onMarkDone,
}: {
  issue: PaperclipIssue;
  locale: string;
  agentName: string | null;
  onMarkDone: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-3">
      <Badge variant="secondary" className={cn("shrink-0", statusBadgeClass(issue.status))}>
        {intl.formatMessage({ id: statusLabelKey(issue.status) })}
      </Badge>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          {issue.identifier ? (
            <span className="shrink-0 font-mono text-ui-sm text-foreground-subtle">
              {issue.identifier}
            </span>
          ) : null}
          <span className="truncate text-ui-base text-foreground">{issue.title}</span>
        </span>
        <span className="truncate text-ui-sm text-foreground-subtlest">
          {[
            agentName ?? intl.formatMessage({ id: "paperclip.issues.unassigned" }),
            formatTimestamp(issue.updatedAt ?? issue.createdAt, locale),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="secondary" className={cn("text-ui-sm", priorityBadgeClass(issue.priority))}>
          {intl.formatMessage({ id: priorityLabelKey(issue.priority) })}
        </Badge>
        {issue.status !== "done" && issue.status !== "cancelled" ? (
          <Button variant="ghost" size="sm" onClick={onMarkDone}>
            <CircleCheck className="size-4" />
            {intl.formatMessage({ id: "paperclip.issues.markDone" })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
