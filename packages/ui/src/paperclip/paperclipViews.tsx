/**
 * Paperclip 面板的展示子组件：agent 卡片与任务行。
 * 纯投影展示，不含数据获取（数据在 usePaperclip）。
 */
import { Bot, CircleCheck } from "lucide-react";
import type { PaperclipAgent, PaperclipIssue, PaperclipIssuePriority, PaperclipIssueStatus } from "@zcode/shared";
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

export function PaperclipAgentCard({ agent }: { agent: PaperclipAgent }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface p-4">
      <div className="flex items-center gap-2">
        <Bot className="size-4 shrink-0 text-foreground-subtle" />
        <span className="truncate text-ui-base font-medium text-foreground">
          {agentDisplayName(agent)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
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
        {agent.status ? (
          <Badge variant="outline" className="text-ui-sm">
            {agent.status}
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
        <span className="truncate text-ui-base text-foreground">
          {issue.identifier ? `${issue.identifier} · ` : ""}
          {issue.title}
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
        <Badge variant="outline" className="text-ui-sm">
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
