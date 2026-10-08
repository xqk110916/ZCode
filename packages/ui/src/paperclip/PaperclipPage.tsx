/**
 * PaperclipPage —— 外部 agent 编排任务面板（主视图，Plugin Store 同构）。
 *
 * 数据全部来自 usePaperclip（Paperclip 为任务事实源）；本组件只做投影与操作入口。
 * 未连接时显示引导（去设置配置 server 地址）；polling 降级态由状态条与轮询兜底。
 */
import { useMemo, useState } from "react";
import type { PaperclipAgent, PaperclipIssueStatus } from "@zcode/shared";
import { paperclipIssueNeedsHuman } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { usePaperclip } from "@/paperclip/usePaperclip.js";
import { PaperclipConnectionBar } from "@/paperclip/PaperclipConnectionBar.js";
import { PaperclipDisconnectedState } from "@/paperclip/PaperclipDisconnectedState.js";
import { agentDisplayName, statusLabelKey } from "@/paperclip/paperclipViews.js";
import { PaperclipAgentList } from "@/paperclip/PaperclipAgentList.js";
import {
  PaperclipIssueBoard,
  type PaperclipIssueFilter,
} from "@/paperclip/PaperclipIssueBoard.js";
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

const STATUS_FILTERS: PaperclipIssueFilter[] = [
  "all",
  "needs_you",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

/** 已完成/已取消不计入未完成数。树的排序在任务板里做。 */
const SETTLED_STATUSES: ReadonlySet<PaperclipIssueStatus> = new Set(["done", "cancelled"]);

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
  const [statusFilter, setStatusFilter] = useState<PaperclipIssueFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createState, setCreateState] =
    useState<PaperclipCreateDialogState>(EMPTY_CREATE_DIALOG_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [configAgent, setConfigAgent] = useState<PaperclipAgent | null>(null);
  const [ensuringDispatcher, setEnsuringDispatcher] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [startingLocalServer, setStartingLocalServer] = useState(false);
  const [stoppingLocalServer, setStoppingLocalServer] = useState(false);

  const handleStartLocalServer = async () => {
    setStartingLocalServer(true);
    try {
      const status = await paperclip.startLocalServer();
      if (status && status.state === "error" && status.detail) {
        toast(status.detail, { variant: "warning" });
      }
    } finally {
      setStartingLocalServer(false);
    }
  };

  const handleStopLocalServer = async () => {
    setStoppingLocalServer(true);
    try {
      const status = await paperclip.stopLocalServer();
      if (status && status.detail) {
        toast(status.detail, { variant: "warning" });
      } else {
        toast(intl.formatMessage({ id: "paperclip.localServer.stopped" }));
      }
    } finally {
      setStoppingLocalServer(false);
    }
  };

  const openIssueCount = useMemo(
    () => paperclip.issues.filter((issue) => !SETTLED_STATUSES.has(issue.status)).length,
    [paperclip.issues],
  );

  const executingCount = useMemo(
    () =>
      paperclip.issues.filter((issue) => {
        const run = paperclip.runsByIssueId[issue.id];
        return run?.status.toLowerCase() === "running";
      }).length,
    [paperclip.issues, paperclip.runsByIssueId],
  );

  const currentWorkspaceProjectId = useMemo(
    () =>
      paperclip.projects.find((project) => project.codebase?.localFolder === workspacePath)?.id ??
      null,
    [paperclip.projects, workspacePath],
  );

  /** 打开创建对话框：主 Agent 存在时默认直接指派给它（用户可改选自动分派/其他
   * agent/不指派）；当前工作区已注册为 Paperclip 项目时默认绑定它。 */
  function openCreateDialog() {
    setCreateState({
      ...EMPTY_CREATE_DIALOG_STATE,
      assigneeAgentId: paperclip.dispatcher ? paperclip.dispatcher.id : "",
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

  const needsYouCount = useMemo(
    () =>
      paperclip.issues.filter((issue) =>
        paperclipIssueNeedsHuman(paperclip.interactionsByIssueId[issue.id]),
      ).length,
    [paperclip.issues, paperclip.interactionsByIssueId],
  );

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
      <PaperclipDisconnectedState
        lastError={paperclip.connection?.lastError}
        startingLocalServer={startingLocalServer}
        onStartLocalServer={() => void handleStartLocalServer()}
        onRetry={() => void paperclip.refresh()}
        onOpenSettings={onOpenSettings}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PaperclipConnectionBar
        connectionState={connectionState}
        serverUrl={paperclip.connection?.serverUrl ?? ""}
        refreshing={paperclip.refreshing}
        stoppingLocalServer={stoppingLocalServer}
        onStopLocalServer={() => void handleStopLocalServer()}
        onRefresh={() => void paperclip.refresh()}
        onCreateTask={openCreateDialog}
      />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <PaperclipAgentList
        agents={paperclip.agents}
        issues={paperclip.issues}
        runsByIssueId={paperclip.runsByIssueId}
        loading={paperclip.loadingIssues}
        onAdd={() => setAddAgentOpen(true)}
        onConfigure={setConfigAgent}
        onDelete={(target) => {
          void paperclip.deleteAgent(target.id).then((ok) => {
            if (!ok) return;
            toast(
              intl.formatMessage({ id: "paperclip.agents.deleted" }, { name: agentDisplayName(target) }),
            );
          });
        }}
      />

      {/* 任务列表 */}
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-2">
          <h2 className="flex flex-wrap items-center gap-2 text-ui-base font-semibold text-foreground">
            {intl.formatMessage({ id: "paperclip.issues.title" })}
            <span className="font-mono text-ui-sm font-normal text-foreground-subtlest">
              {openIssueCount}
            </span>
            {executingCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-info-subtle px-2 py-0.5 text-ui-xs font-normal text-info">
                <span className="size-1.5 animate-pulse rounded-full bg-current" />
                {intl.formatMessage({ id: "paperclip.progress.liveCount" }, { count: executingCount })}
              </span>
            ) : null}
          </h2>
          <div className="flex flex-wrap gap-0.5 rounded-xl border border-border-subtle bg-surface-muted p-0.5">
            {STATUS_FILTERS.map((status) => {
              const count =
                status === "all"
                  ? paperclip.issues.length
                  : status === "needs_you"
                    ? needsYouCount
                    : (statusCounts.get(status) ?? 0);
              return (
                <button
                  key={status}
                  type="button"
                  data-testid={`paperclip-filter-${status}`}
                  onClick={() => setStatusFilter(status)}
                  className={cn(
                    "flex items-center gap-1 rounded-lg px-2 py-1 text-ui-sm text-foreground-subtle transition-colors hover:text-foreground",
                    statusFilter === status && "bg-popover text-foreground shadow-sm",
                  )}
                >
                  {intl.formatMessage({
                    id:
                      status === "all"
                        ? "paperclip.status.all"
                        : status === "needs_you"
                          ? "paperclip.filter.needsYou"
                          : statusLabelKey(status),
                  })}
                  <span className="text-ui-xs text-foreground-subtlest">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        {paperclip.actionError ? (
          <p className="text-ui-base text-danger">{paperclip.actionError}</p>
        ) : null}
        <PaperclipIssueBoard
          filter={statusFilter}
          loading={paperclip.loadingIssues}
          locale={locale}
          issues={paperclip.issues}
          agents={paperclip.agents}
          runsByIssueId={paperclip.runsByIssueId}
          runHistoryByIssueId={paperclip.runHistoryByIssueId}
          commentsByIssueId={paperclip.commentsByIssueId}
          interactionsByIssueId={paperclip.interactionsByIssueId}
          onOpen={(issueId) => void paperclip.loadIssueThread(issueId)}
          onMarkDone={(issueId) => void paperclip.markDone(issueId)}
          onAcceptReview={(issueId, comment) =>
            paperclip.transitionIssue(issueId, "done", comment || undefined)
          }
          onSendBack={(issueId, comment) =>
            paperclip.transitionIssue(issueId, "in_progress", comment || undefined)
          }
          onReply={(issueId, body) => paperclip.replyToIssue(issueId, body)}
          onAcceptInteraction={(issueId, interactionId, selectedOptionIds) =>
            paperclip.acceptInteraction(
              issueId,
              interactionId,
              selectedOptionIds.length > 0 ? { selectedOptionIds } : undefined,
            )
          }
          onRejectInteraction={(issueId, interactionId) =>
            paperclip.rejectInteraction(issueId, interactionId)
          }
          onRespondInteraction={(issueId, interactionId, answers) =>
            paperclip.respondInteraction(issueId, interactionId, answers)
          }
        />
      </section>
      </div>

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
        isDispatcher={configAgent?.id === paperclip.dispatcher?.id}
        onSetDispatcher={paperclip.setDispatcher}
        onSave={paperclip.updateAgent}
      />

      <PaperclipAddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        detectLocalAgentAdapters={paperclip.detectLocalAgentAdapters}
        existingAdapterTypes={
          new Set(
            paperclip.agents.flatMap((agent) =>
              agent.adapterType ? [agent.adapterType] : [],
            ),
          )
        }
        onCreate={async (input) => {
          // 团队还没有主 Agent 时，新增的第一个 agent 默认成为主 Agent（调度负责人）。
          const ok = await paperclip.createAgent({
            ...input,
            ...(paperclip.dispatcher ? {} : { role: "ceo" }),
          });
          if (ok) {
            toast(
              intl.formatMessage(
                { id: "paperclip.addAgent.created" },
                { name: input.name },
              ) + (paperclip.dispatcher ? "" : intl.formatMessage({ id: "paperclip.addAgent.becameDispatcher" })),
            );
          }
          return ok;
        }}
      />
    </div>
  );
}
