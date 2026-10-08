/**
 * PaperclipPage —— 外部 agent 编排任务面板（主视图，Plugin Store 同构）。
 *
 * 数据全部来自 usePaperclip（Paperclip 为任务事实源）；本组件只做投影与操作入口。
 * 未连接时显示引导（去设置配置 server 地址）；polling 降级态由状态条与轮询兜底。
 */
import { useMemo, useState } from "react";
import type { PaperclipAgent, PaperclipIssue, PaperclipIssueStatus } from "@zcode/shared";
import { paperclipIssueNeedsHuman } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { usePaperclip } from "@/paperclip/usePaperclip.js";
import { usePaperclipAutoClaim } from "@/paperclip/usePaperclipAutoClaim.js";
import { usePaperclipCreateSubmit } from "@/paperclip/usePaperclipCreateSubmit.js";
import { PaperclipPendingBanner } from "@/paperclip/PaperclipPendingBanner.js";
import { PaperclipDialogs } from "@/paperclip/PaperclipDialogs.js";
import { PaperclipConnectionBar } from "@/paperclip/PaperclipConnectionBar.js";
import { PaperclipDisconnectedState } from "@/paperclip/PaperclipDisconnectedState.js";
import { agentDisplayName, statusLabelKey } from "@/paperclip/paperclipViews.js";
import { PaperclipAgentList } from "@/paperclip/PaperclipAgentList.js";
import {
  PaperclipIssueBoard,
  type PaperclipIssueFilter,
} from "@/paperclip/PaperclipIssueBoard.js";

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
  onExecuteInZCode,
  onAutoExecuteInZCode,
}: {
  onOpenSettings: () => void;
  /** 当前 ZCode 工作区绝对路径；创建任务可绑定为 Paperclip 项目工作区。 */
  workspacePath: string;
  /**
   * ZCode 自主执行的落地回调：认领成功后由外层创建本地 ZCode 任务
   * （prompt 由外层从 issue 标题/描述拼装）。
   */
  onExecuteInZCode: (issue: PaperclipIssue) => void;
  /**
   * 自动认领的后台落地回调：在 targetWorkspacePath（任务绑定项目的工作区，
   * null 时用活动工作区）创建预填任务，不切换视图、不抢活动标签。
   */
  onAutoExecuteInZCode: (issue: PaperclipIssue, targetWorkspacePath: string | null) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const paperclip = usePaperclip();
  const { settings, update: updateSettings } = useSettings();
  const [statusFilter, setStatusFilter] = useState<PaperclipIssueFilter>("all");
  const [configAgent, setConfigAgent] = useState<PaperclipAgent | null>(null);
  const [ensuringDispatcher, setEnsuringDispatcher] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [startingLocalServer, setStartingLocalServer] = useState(false);
  const [stoppingLocalServer, setStoppingLocalServer] = useState(false);
  // 创建任务编排（提交/默认值/toast）见 usePaperclipCreateSubmit。
  const {
    submitting,
    createOpen,
    setCreateOpen,
    createState,
    setCreateState,
    openCreateDialog,
    submitCreate,
  } = usePaperclipCreateSubmit({
    workspacePath,
    dispatcher: paperclip.dispatcher,
    projects: paperclip.projects,
    createIssue: paperclip.createIssue,
    ensureProjectForWorkspace: paperclip.ensureProjectForWorkspace,
  });

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
      paperclip.issues.filter(
        (issue) => paperclip.runsByIssueId[issue.id]?.status.toLowerCase() === "running",
      ).length,
    [paperclip.issues, paperclip.runsByIssueId],
  );

  const currentWorkspaceProjectId = useMemo(
    () =>
      paperclip.projects.find((project) => project.codebase?.localFolder === workspacePath)?.id ??
      null,
    [paperclip.projects, workspacePath],
  );

  // 打开创建对话框：默认指派主 Agent、绑定当前工作区项目（编排见 usePaperclipCreateSubmit）。
  const openCreateTask = () =>
    openCreateDialog({
      dispatcherId: paperclip.dispatcher?.id ?? null,
      currentWorkspaceProjectId,
    });

  const statusCounts = useMemo(() => {
    const counts = new Map<PaperclipIssueStatus, number>();
    for (const issue of paperclip.issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return counts;
  }, [paperclip.issues]);

  /** 「等你」= 有待处理的提问/确认交互，或待 ZCode 执行的未结任务（都是等你出手）。 */
  const needsYouCount = useMemo(
    () =>
      paperclip.issues.filter(
        (issue) =>
          paperclipIssueNeedsHuman(paperclip.interactionsByIssueId[issue.id]) ||
          (paperclip.zcodeAgent !== null &&
            issue.assigneeAgentId === paperclip.zcodeAgent.id &&
            !SETTLED_STATUSES.has(issue.status)),
      ).length,
    [paperclip.issues, paperclip.interactionsByIssueId, paperclip.zcodeAgent],
  );

  /** 认领并带到本地执行（任务行按钮与顶部横幅共用）。 */
  function executeIssueInZCode(issueId: string) {
    const issue = paperclip.issues.find((entry) => entry.id === issueId);
    if (!issue) return;
    void paperclip.executeInZCode(issue, (claimed) => {
      onExecuteInZCode(claimed);
      toast(intl.formatMessage({ id: "paperclip.toast.claimedByZCode" }));
    });
  }

  // 自动认领（差分 + sessionStorage 防重，实现见 usePaperclipAutoClaim）。
  const { pendingCount: zcodePendingCount } = usePaperclipAutoClaim({
    enabled: settings?.paperclipAutoClaim === true,
    issues: paperclip.issues,
    zcodeAgent: paperclip.zcodeAgent,
    projects: paperclip.projects,
    executeInZCode: paperclip.executeInZCode,
    onAutoExecute: onAutoExecuteInZCode,
  });

  const connectionState = paperclip.connection?.state ?? "connecting";

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
        onCreateTask={openCreateTask}
      />

      {/* 待 ZCode 执行横幅（含自动认领开关与「执行下一个」）。 */}
      {zcodePendingCount > 0 ? (
        <PaperclipPendingBanner
          count={zcodePendingCount}
          autoClaim={settings?.paperclipAutoClaim === true}
          onAutoClaimChange={(checked) => {
            void updateSettings({ paperclipAutoClaim: checked });
          }}
          onViewPending={() => setStatusFilter("needs_you")}
          onExecuteNext={() => {
            const next = paperclip.issues.find(
              (issue) =>
                issue.assigneeAgentId === paperclip.zcodeAgent?.id &&
                !SETTLED_STATUSES.has(issue.status),
            );
            if (next) executeIssueInZCode(next.id);
          }}
        />
      ) : null}

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
          zcodeAgentId={paperclip.zcodeAgent?.id ?? null}
          onExecuteInZCode={executeIssueInZCode}
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

      <PaperclipDialogs
        paperclip={paperclip}
        workspacePath={workspacePath}
        currentWorkspaceProjectId={currentWorkspaceProjectId}
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        createState={createState}
        setCreateState={setCreateState}
        submitting={submitting}
        submitCreate={() => void submitCreate()}
        ensuringDispatcher={ensuringDispatcher}
        setEnsuringDispatcher={setEnsuringDispatcher}
        configAgent={configAgent}
        setConfigAgent={setConfigAgent}
        addAgentOpen={addAgentOpen}
        setAddAgentOpen={setAddAgentOpen}
      />
    </div>
  );
}
