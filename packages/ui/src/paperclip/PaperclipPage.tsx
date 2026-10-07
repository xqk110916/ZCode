/**
 * PaperclipPage —— 外部 agent 编排任务面板（主视图，Plugin Store 同构）。
 *
 * 数据全部来自 usePaperclip（Paperclip 为任务事实源）；本组件只做投影与操作入口。
 * 未连接时显示引导（去设置配置 server 地址）；polling 降级态由状态条与轮询兜底。
 */
import { useMemo, useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  UserRoundPlus,
} from "lucide-react";
import type { PaperclipAgent, PaperclipIssue, PaperclipIssueStatus } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { usePaperclip } from "@/paperclip/usePaperclip.js";
import {
  agentDisplayName,
  PaperclipAgentCard,
  PaperclipIssueRow,
  findAgentName,
  statusLabelKey,
} from "@/paperclip/paperclipViews.js";
import { PaperclipAgentConfigDialog } from "@/paperclip/PaperclipAgentConfigDialog.js";
import { PaperclipAddAgentDialog } from "@/paperclip/PaperclipAddAgentDialog.js";
import {
  buildDispatchDescription,
  EMPTY_CREATE_DIALOG_STATE,
  PAPERCLIP_CURRENT_WORKSPACE_PROJECT,
  PAPERCLIP_DISPATCH_ASSIGNEE,
  PaperclipCreateTaskDialog,
  type PaperclipCreateDialogState,
} from "@/paperclip/PaperclipCreateTaskDialog.js";

const STATUS_FILTERS: Array<PaperclipIssueStatus | "all"> = [
  "all",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

/** 已完成/已取消沉底排序，其余按更新时间倒序（无时间戳的排最后）。 */
const SETTLED_STATUSES: ReadonlySet<PaperclipIssueStatus> = new Set(["done", "cancelled"]);

function issueSortTimestamp(issue: PaperclipIssue): number {
  const parsed = Date.parse(issue.updatedAt ?? issue.createdAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function PaperclipPage({
  onOpenSettings,
  workspacePath,
}: {
  onOpenSettings: () => void;
  /** 当前 ZCode 工作区绝对路径；创建任务可绑定为 Paperclip 项目工作区。 */
  workspacePath: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const paperclip = usePaperclip();
  const [statusFilter, setStatusFilter] = useState<PaperclipIssueStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createState, setCreateState] =
    useState<PaperclipCreateDialogState>(EMPTY_CREATE_DIALOG_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [configAgent, setConfigAgent] = useState<PaperclipAgent | null>(null);
  const [ensuringDispatcher, setEnsuringDispatcher] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  const openIssueCount = useMemo(
    () => paperclip.issues.filter((issue) => !SETTLED_STATUSES.has(issue.status)).length,
    [paperclip.issues],
  );

  const currentWorkspaceProjectId = useMemo(
    () =>
      paperclip.projects.find((project) => project.codebase?.localFolder === workspacePath)?.id ??
      null,
    [paperclip.projects, workspacePath],
  );

  /** 打开创建对话框：dispatcher 存在时默认「主 Agent 自动分派」；当前工作区已注册为
   * Paperclip 项目时默认绑定它（贴合"在这个仓库干活"的直觉）。 */
  function openCreateDialog() {
    setCreateState({
      ...EMPTY_CREATE_DIALOG_STATE,
      assigneeAgentId: paperclip.dispatcher ? PAPERCLIP_DISPATCH_ASSIGNEE : "",
      projectId: currentWorkspaceProjectId ?? "",
    });
    setCreateOpen(true);
  }

  const statusCounts = useMemo(() => {
    const counts = new Map<PaperclipIssueStatus, number>();
    for (const issue of paperclip.issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return counts;
  }, [paperclip.issues]);

  const visibleIssues = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? paperclip.issues
        : paperclip.issues.filter((issue) => issue.status === statusFilter);
    return [...filtered].sort((a, b) => {
      const settledDelta =
        Number(SETTLED_STATUSES.has(a.status)) - Number(SETTLED_STATUSES.has(b.status));
      if (settledDelta !== 0) return settledDelta;
      return issueSortTimestamp(b) - issueSortTimestamp(a);
    });
  }, [paperclip.issues, statusFilter]);

  const connectionState = paperclip.connection?.state ?? "connecting";

  async function submitCreate() {
    if (!createState.title.trim() || submitting) return;
    // 「当前工作区」且尚未注册时，先确保 Paperclip 项目存在（local_path 工作区）。
    let projectId = createState.projectId;
    if (projectId === PAPERCLIP_CURRENT_WORKSPACE_PROJECT && workspacePath) {
      const project = await paperclip.ensureProjectForWorkspace({
        // 项目名取工作区目录名（Paperclip 项目重名可共存，按 cwd 幂等匹配）。
        name: workspacePath.split("/").filter(Boolean).pop() ?? workspacePath,
        cwd: workspacePath,
      });
      if (!project) {
        // ensureProjectForWorkspace 已把原因写进 actionError；中止提交。
        return;
      }
      projectId = project.id;
    }
    setSubmitting(true);
    const dispatcher = paperclip.dispatcher;
    const autoDispatch =
      createState.assigneeAgentId === PAPERCLIP_DISPATCH_ASSIGNEE && dispatcher !== null;
    const ok = await paperclip.createIssue({
      title: createState.title.trim(),
      // 自动分派：指令模板随描述一起提交（对话框中有提示，用户可见可预期）。
      ...(autoDispatch
        ? { description: buildDispatchDescription(createState.description) }
        : createState.description.trim() === ""
          ? {}
          : { description: createState.description.trim() }),
      priority: createState.priority,
      ...(projectId === "" ? {} : { projectId }),
      ...(autoDispatch
        ? { assigneeAgentId: dispatcher.id }
        : createState.assigneeAgentId === "" ||
            createState.assigneeAgentId === PAPERCLIP_DISPATCH_ASSIGNEE
          ? {}
          : { assigneeAgentId: createState.assigneeAgentId }),
    });
    setSubmitting(false);
    if (ok) {
      setCreateOpen(false);
      setCreateState(EMPTY_CREATE_DIALOG_STATE);
      // 创建成功的轻反馈：自动分派时说明交给谁调度，手动指派时说明唤醒谁。
      toast(
        autoDispatch
          ? intl.formatMessage(
              { id: "paperclip.toast.createdAuto" },
              { name: agentDisplayName(dispatcher) },
            )
          : intl.formatMessage({ id: "paperclip.toast.created" }),
      );
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
              connectionState === "connected" && "border-success/40 bg-success-subtle text-success",
              connectionState === "polling" && "border-warning/40 bg-warning-subtle text-warning",
              connectionState === "connecting" && "border-info/40 bg-info-subtle text-info",
            )}
          >
            {connectionState === "connected" ? (
              <CircleCheck className="size-3" />
            ) : (
              <Loader2 className="size-3 animate-spin" />
            )}
            {intl.formatMessage({
              id:
                connectionState === "connected"
                  ? "paperclip.state.connected"
                  : connectionState === "polling"
                    ? "paperclip.state.polling"
                    : "paperclip.state.connecting",
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
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="size-4" />
            {intl.formatMessage({ id: "paperclip.createTask" })}
          </Button>
        </div>
      </div>

      {/* Agent 列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "paperclip.agents.title" })}
            <span className="font-mono text-ui-sm font-normal text-foreground-subtlest">
              {paperclip.agents.length}
            </span>
          </h2>
          <Button variant="outline" size="sm" onClick={() => setAddAgentOpen(true)}>
            <UserRoundPlus className="size-4" />
            {intl.formatMessage({ id: "paperclip.addAgent.open" })}
          </Button>
        </div>
        {paperclip.agents.length === 0 ? (
          paperclip.loadingIssues ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy>
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="h-[104px] animate-pulse rounded-lg bg-surface-muted" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "paperclip.agents.emptyNew" })}
              </p>
              <Button variant="outline" size="sm" onClick={() => setAddAgentOpen(true)}>
                <UserRoundPlus className="size-4" />
                {intl.formatMessage({ id: "paperclip.addAgent.open" })}
              </Button>
            </div>
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...paperclip.agents]
              .sort(
                // 主 Agent（dispatcher）置顶，其余保持服务端顺序。
                (a, b) => Number(b.role === "ceo") - Number(a.role === "ceo"),
              )
              .map((agent) => (
                <PaperclipAgentCard
                  key={agent.id}
                  agent={agent}
                  onConfigure={setConfigAgent}
                />
              ))}
          </div>
        )}
      </section>

      {/* 任务列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "paperclip.issues.title" })}
            <span className="font-mono text-ui-sm font-normal text-foreground-subtlest">
              {openIssueCount}
            </span>
          </h2>
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((status) => {
              const count =
                status === "all" ? paperclip.issues.length : (statusCounts.get(status) ?? 0);
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-ui-base text-foreground-subtle transition-colors hover:bg-surface-hover",
                    statusFilter === status && "bg-selected text-foreground",
                  )}
                >
                  {intl.formatMessage({
                    id: status === "all" ? "paperclip.status.all" : statusLabelKey(status),
                  })}
                  <span className="text-ui-sm text-foreground-subtlest">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        {paperclip.actionError ? (
          <p className="text-ui-base text-danger">{paperclip.actionError}</p>
        ) : null}
        {visibleIssues.length === 0 ? (
          paperclip.loadingIssues ? (
            <ul className="flex flex-col gap-2" aria-busy>
              {Array.from({ length: 3 }, (_, index) => (
                <li key={index} className="h-[52px] animate-pulse rounded-lg bg-surface-muted" />
              ))}
            </ul>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id:
                  statusFilter === "all"
                    ? "paperclip.issues.empty"
                    : "paperclip.issues.emptyFiltered",
              })}
            </p>
          )
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
        dispatcher={paperclip.dispatcher}
        projects={paperclip.projects}
        workspacePath={workspacePath}
        currentWorkspaceProjectId={currentWorkspaceProjectId}
        submitting={submitting}
        ensuringDispatcher={ensuringDispatcher}
        state={createState}
        onStateChange={setCreateState}
        onOpenChange={setCreateOpen}
        onSubmit={() => void submitCreate()}
        onEnsureDispatcher={() => {
          setEnsuringDispatcher(true);
          void paperclip.ensureDispatcher().finally(() => setEnsuringDispatcher(false));
        }}
      />

      <PaperclipAgentConfigDialog
        agent={configAgent}
        open={configAgent !== null}
        onOpenChange={(open) => {
          if (!open) setConfigAgent(null);
        }}
        loadAdapterModels={paperclip.loadAdapterModels}
        discoverClaudeModels={paperclip.discoverClaudeModels}
        onSave={paperclip.updateAgent}
      />

      <PaperclipAddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        detectLocalAgentAdapters={paperclip.detectLocalAgentAdapters}
        onCreate={async (input) => {
          const ok = await paperclip.createAgent(input);
          if (ok) {
            toast(intl.formatMessage({ id: "paperclip.addAgent.created" }, { name: input.name }));
          }
          return ok;
        }}
      />
    </div>
  );
}
