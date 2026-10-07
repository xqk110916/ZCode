/**
 * Paperclip 面板的展示子组件：agent 卡片与任务行。
 * 纯投影展示，不含数据获取（数据在 usePaperclip）。
 */
import { useState } from "react";
import { Bot, ChevronDown, CircleCheck, Settings2, Sparkles } from "lucide-react";
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
import { resolveTheme } from "@/useTheme.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
// 模型自身图标集（paperclip 面板专用，勿与设置页 provider 厂商资产混用）：
// Claude 星芒 / Gemini 四角星 / Grok 环箭头为用户提供素材；ChatGPT 图标即 Codex
// 模型的图标；Kimi 新月为产品自身标（复用设置页资产）。
import claudeBrandIcon from "@/assets/paperclip-brand-icons/claude.png";
import geminiBrandIcon from "@/assets/paperclip-brand-icons/gemini.png";
import grokBrandIcon from "@/assets/paperclip-brand-icons/grok.png";
import chatgptBrandIcon from "@/assets/paperclip-brand-icons/chatgpt.png";
import kimiLogo from "@/assets/provider-icons/model-provider-moonshot-kimi.png";
import opencodeLight from "@/assets/provider-icons/model-provider-opencode-light.svg";
import opencodeDark from "@/assets/provider-icons/model-provider-opencode-dark.svg";

/** adapter → 模型自身图标（无映射的用 Bot 兜底）。 */
export function PaperclipAdapterBrandIcon({
  adapterType,
  className,
}: {
  adapterType: string;
  className?: string;
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const resolved = resolveTheme(theme);
  const base = adapterType.replace(/_local$/, "");
  const src =
    base === "claude"
      ? claudeBrandIcon
      : base === "gemini"
        ? geminiBrandIcon
        : base === "grok"
          ? grokBrandIcon
          : base === "codex"
            ? chatgptBrandIcon
            : base === "kimi"
              ? kimiLogo
              : base === "opencode"
                ? resolved === "dark"
                  ? opencodeDark
                  : opencodeLight
                : null;
  if (src === null) {
    return <Bot className={className} />;
  }
  // rounded-sm 让 claude/chatgpt 这类满幅方形 app 图标与容器圆角协调；透明图标不受影响。
  return <img src={src} alt="" aria-hidden className={cn("rounded-sm", className)} draggable={false} />;
}

/** adapter 展示名：local 形态去掉 _local 后缀（claude_local → claude）；其他形态保留全名以区分执行位置。 */
export function formatAdapterLabel(adapterType: string): string {
  return adapterType.replace(/_local$/, "");
}

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

/** Paperclip agent 状态：已知值走 i18n + 语义色 + 状态点；未知值原样弱展示。 */
function agentStatusPresentation(status: string): {
  labelKey: string | null;
  className: string;
} {
  switch (status) {
    case "active":
    case "running":
      return {
        labelKey: "paperclip.agentStatus.active",
        className: "bg-success-subtle text-success",
      };
    case "idle":
      return {
        labelKey: "paperclip.agentStatus.idle",
        className: "bg-surface-muted text-foreground-subtle",
      };
    case "paused":
      return {
        labelKey: "paperclip.agentStatus.paused",
        className: "bg-warning-subtle text-warning",
      };
    case "error":
      return {
        labelKey: "paperclip.agentStatus.error",
        className: "bg-danger-subtle text-danger",
      };
    default:
      return { labelKey: null, className: "bg-surface-muted text-foreground-subtle" };
  }
}

/** 状态徽章：语义色 + 跟随文本色的状态圆点（不只靠颜色区分，可读性兜底）。 */
function PaperclipAgentStatusBadge({ status }: { status: string }) {
  const { intl } = useZCodeIntl();
  const presentation = agentStatusPresentation(status);
  return (
    <Badge variant="secondary" className={cn("gap-1.5 text-ui-sm", presentation.className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {presentation.labelKey
        ? intl.formatMessage({ id: presentation.labelKey })
        : (status ?? "")}
    </Badge>
  );
}

export function PaperclipAgentCard({
  agent,
  onConfigure,
}: {
  agent: PaperclipAgent;
  onConfigure?: (agent: PaperclipAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const isDispatcher = agent.role === "ceo";
  const adapterType = agent.adapterType || "";
  return (
    // 页面内容区无更外层圆角容器，卡片按容器层级从 rounded-xl 起（DESIGN.md Radius）。
    // dispatcher（主 Agent）用 info 描边强调，配合列表置顶排序。
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-4 transition-colors",
        isDispatcher
          ? "border-info/40 hover:border-info/60"
          : "border-card-border hover:border-border-hover",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent">
          <PaperclipAdapterBrandIcon
            adapterType={adapterType}
            className="size-4 object-contain"
          />
        </span>
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
        {adapterType ? (
          <Badge variant="secondary" className="gap-1 text-ui-sm">
            <PaperclipAdapterBrandIcon adapterType={adapterType} className="size-3 object-contain" />
            {formatAdapterLabel(adapterType)}
          </Badge>
        ) : null}
        {agent.model ? (
          <Badge variant="outline" className="font-mono text-ui-sm">
            {agent.model}
          </Badge>
        ) : null}
        {agent.status ? <PaperclipAgentStatusBadge status={agent.status} /> : null}
      </div>
      <p className="text-ui-sm text-foreground-subtlest">
        {isDispatcher
          ? intl.formatMessage({ id: "paperclip.agents.roleDispatcherHint" })
          : intl.formatMessage({ id: "paperclip.agents.roleWorkerHint" })}
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
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(issue.description && issue.description.trim());
  return (
    <li className="flex flex-col rounded-xl border border-card-border bg-card transition-colors hover:border-border-hover">
      <div
        role={hasDetail ? "button" : undefined}
        tabIndex={hasDetail ? 0 : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={hasDetail ? () => setExpanded((value) => !value) : undefined}
        onKeyDown={
          hasDetail
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setExpanded((value) => !value);
                }
              }
            : undefined
        }
        className={cn(
          "flex flex-wrap items-center gap-3 px-4 py-3",
          hasDetail && "cursor-pointer",
        )}
      >
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
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => {
                // 行点击是展开详情；完成按钮独立动作，不随行触发。
                event.stopPropagation();
                onMarkDone();
              }}
            >
              <CircleCheck className="size-4" />
              {intl.formatMessage({ id: "paperclip.issues.markDone" })}
            </Button>
          ) : null}
          {hasDetail ? (
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-foreground-subtlest transition-transform",
                expanded && "rotate-180",
              )}
            />
          ) : null}
        </div>
      </div>
      {hasDetail && expanded ? (
        <div className="border-t border-border-subtle px-4 py-3">
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
            {issue.description}
          </p>
        </div>
      ) : null}
    </li>
  );
}
