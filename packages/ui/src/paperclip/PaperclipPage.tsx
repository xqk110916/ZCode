/**
 * PaperclipPage —— 外部 agent 编排任务面板（主视图，Plugin Store 同构）。
 *
 * 数据全部来自 usePaperclip（Paperclip 为任务事实源）；本组件只做投影与操作入口。
 * 未连接时显示引导（去设置配置 server 地址）；polling 降级态由状态条与轮询兜底。
 */
import { useMemo, useState } from "react";
import { CircleCheck, CircleDashed, Loader2, Plus, RefreshCw, Settings2 } from "lucide-react";
import type { PaperclipIssueStatus } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { usePaperclip } from "@/paperclip/usePaperclip.js";
import {
  PaperclipAgentCard,
  PaperclipIssueRow,
  findAgentName,
  statusLabelKey,
} from "@/paperclip/paperclipViews.js";
import {
  EMPTY_CREATE_DIALOG_STATE,
  PaperclipCreateTaskDialog,
  type PaperclipCreateDialogState,
} from "@/paperclip/PaperclipCreateTaskDialog.js";

const STATUS_FILTERS: Array<PaperclipIssueStatus | "all"> = [
  "all",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export function PaperclipPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { intl, locale } = useZCodeIntl();
  const paperclip = usePaperclip();
  const [statusFilter, setStatusFilter] = useState<PaperclipIssueStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createState, setCreateState] = useState<PaperclipCreateDialogState>(
    EMPTY_CREATE_DIALOG_STATE,
  );
  const [submitting, setSubmitting] = useState(false);

  const visibleIssues = useMemo(
    () =>
      statusFilter === "all"
        ? paperclip.issues
        : paperclip.issues.filter((issue) => issue.status === statusFilter),
    [paperclip.issues, statusFilter],
  );

  const connected = paperclip.connection?.state === "connected";

  async function submitCreate() {
    if (!createState.title.trim() || submitting) return;
    setSubmitting(true);
    const ok = await paperclip.createIssue({
      title: createState.title.trim(),
      ...(createState.description.trim() === ""
        ? {}
        : { description: createState.description.trim() }),
      priority: createState.priority,
      ...(createState.assigneeAgentId === ""
        ? {}
        : { assigneeAgentId: createState.assigneeAgentId }),
    });
    setSubmitting(false);
    if (ok) {
      setCreateOpen(false);
      setCreateState(EMPTY_CREATE_DIALOG_STATE);
    }
  }

  if (!paperclip.serviceAvailable) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <p className="text-ui-lg text-foreground-subtle">
          {intl.formatMessage({ id: "paperclip.unavailable" })}
        </p>
      </div>
    );
  }

  if (paperclip.connection?.state === "disconnected" || paperclip.connection === null) {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <CircleDashed className="size-8 text-foreground-subtlest" />
        <div className="flex flex-col gap-1">
          <p className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "paperclip.notConnected.title" })}
          </p>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "paperclip.notConnected.description" })}
          </p>
          {paperclip.connection?.lastError ? (
            <p className="text-ui-base text-danger">{paperclip.connection.lastError}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void paperclip.refresh()}>
            <RefreshCw className="size-4" />
            {intl.formatMessage({ id: "paperclip.retry" })}
          </Button>
          <Button onClick={onOpenSettings}>
            <Settings2 className="size-4" />
            {intl.formatMessage({ id: "paperclip.openSettings" })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* 连接状态条 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "gap-1",
              connected
                ? "border-success/40 bg-success-subtle text-success"
                : "border-warning/40 bg-warning-subtle text-warning",
            )}
          >
            {connected ? (
              <CircleCheck className="size-3" />
            ) : (
              <Loader2 className="size-3 animate-spin" />
            )}
            {intl.formatMessage({
              id: connected ? "paperclip.state.connected" : "paperclip.state.polling",
            })}
          </Badge>
          <span className="truncate text-ui-base text-foreground-subtle">
            {paperclip.connection?.serverUrl}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={paperclip.refreshing}
            onClick={() => void paperclip.refresh()}
          >
            <RefreshCw className={cn("size-4", paperclip.refreshing && "animate-spin")} />
            {intl.formatMessage({ id: "paperclip.refresh" })}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {intl.formatMessage({ id: "paperclip.createTask" })}
          </Button>
        </div>
      </div>

      {/* Agent 列表 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "paperclip.agents.title" })}
        </h2>
        {paperclip.agents.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "paperclip.agents.empty" })}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {paperclip.agents.map((agent) => (
              <PaperclipAgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </section>

      {/* 任务列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "paperclip.issues.title" })}
          </h2>
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={cn(
                  "rounded-md px-2 py-1 text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover",
                  statusFilter === status && "bg-selected text-foreground",
                )}
              >
                {intl.formatMessage({
                  id: status === "all" ? "paperclip.status.all" : statusLabelKey(status),
                })}
              </button>
            ))}
          </div>
        </div>
        {paperclip.actionError ? (
          <p className="text-ui-base text-danger">{paperclip.actionError}</p>
        ) : null}
        {visibleIssues.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "paperclip.issues.empty" })}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleIssues.map((issue) => (
              <PaperclipIssueRow
                key={issue.id}
                issue={issue}
                locale={locale}
                agentName={findAgentName(paperclip.agents, issue.assigneeAgentId)}
                onMarkDone={() => void paperclip.markDone(issue.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <PaperclipCreateTaskDialog
        open={createOpen}
        agents={paperclip.agents}
        submitting={submitting}
        state={createState}
        onStateChange={setCreateState}
        onOpenChange={setCreateOpen}
        onSubmit={() => void submitCreate()}
      />
    </div>
  );
}
