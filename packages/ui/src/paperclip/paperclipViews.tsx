/**
 * Paperclip 面板的展示子组件：agent 卡片与任务行。
 * 纯投影展示，不含数据获取（数据在 usePaperclip）。
 */
import { useEffect, useState } from "react";
import { Bot, Settings2, Sparkles, Trash2 } from "lucide-react";
import type { PaperclipAgent, PaperclipIssuePriority, PaperclipIssueStatus } from "@zcode/shared";
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
  agents: readonly PaperclipAgent[],
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

/**
 * 状态徽章：语义色 + 跟随文本色的状态圆点（不只靠颜色区分，可读性兜底）。
 * ZCode 自主执行身份（http adapter）的 paused 是刻意设置（暂停心跳、不被
 * Paperclip 驱动，见 spec「ZCode 自主执行模式」），按模式语义显示为「自主执行」，
 * 不沿用会误导的「已暂停」警告色。
 */
function PaperclipAgentStatusBadge({
  status,
  adapterType,
}: {
  status: string;
  adapterType: string;
}) {
  const { intl } = useZCodeIntl();
  const isZcodeAutonomous = adapterType === "http" && status === "paused";
  const presentation = isZcodeAutonomous
    ? { labelKey: "paperclip.agentStatus.zcodeAutonomous", className: "bg-info-subtle text-info" }
    : agentStatusPresentation(status);
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
  currentTitle,
  queueCount,
  onConfigure,
  onDelete,
}: {
  agent: PaperclipAgent;
  /** 正在做的任务标题。不传则不显示负载行。 */
  currentTitle?: string | null;
  queueCount?: number;
  onConfigure?: (agent: PaperclipAgent) => void;
  /** 删除 agent（破坏性操作，卡片内两步确认）。 */
  onDelete?: (agent: PaperclipAgent) => void;
}) {
  const { intl } = useZCodeIntl();
  const isDispatcher = agent.role === "ceo";
  const adapterType = agent.adapterType || "";
  // 两步确认：第一次点击变为"确认删除"文字按钮，4 秒无操作自动复位。
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4_000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);
  return (
    // 页面内容区无更外层圆角容器，卡片按容器层级从 rounded-xl 起（DESIGN.md Radius）。
    // dispatcher（主 Agent）用 info 描边强调，配合列表置顶排序。
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border bg-card p-3 transition-colors",
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
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {confirmingDelete ? (
            <>
              <Button
                variant="destructive"
                size="xs"
                onClick={() => onDelete?.(agent)}
                aria-label={intl.formatMessage({ id: "paperclip.agents.deleteConfirmYes" })}
              >
                {intl.formatMessage({ id: "paperclip.agents.deleteConfirmYes" })}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setConfirmingDelete(false)}
                aria-label={intl.formatMessage({ id: "paperclip.agents.deleteConfirmNo" })}
              >
                {intl.formatMessage({ id: "paperclip.agents.deleteConfirmNo" })}
              </Button>
            </>
          ) : (
            <>
              {onConfigure ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={intl.formatMessage({ id: "paperclip.agentConfig.open" })}
                  onClick={() => onConfigure(agent)}
                >
                  <Settings2 className="size-4" />
                </Button>
              ) : null}
              {onDelete ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-foreground-subtle hover:text-destructive"
                  aria-label={intl.formatMessage({ id: "paperclip.agents.delete" })}
                  title={
                    isDispatcher
                      ? intl.formatMessage({ id: "paperclip.agents.deleteDispatcherHint" })
                      : intl.formatMessage({ id: "paperclip.agents.delete" })
                  }
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </>
          )}
        </span>
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
        {agent.status ? (
          <PaperclipAgentStatusBadge
            status={agent.status}
            adapterType={agent.adapterType || ""}
          />
        ) : null}
      </div>
      {queueCount !== undefined ? (
        <div className="flex flex-col gap-0.5">
          <p className="truncate text-ui-sm text-foreground-subtle">
            {currentTitle
              ? intl.formatMessage({ id: "paperclip.agents.currentTask" }, { title: currentTitle })
              : intl.formatMessage({ id: "paperclip.agents.idleTask" })}
          </p>
          {queueCount > 0 ? (
            <p className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "paperclip.agents.queueCount" }, { count: queueCount })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
