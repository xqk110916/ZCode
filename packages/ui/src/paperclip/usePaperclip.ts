/**
 * usePaperclip —— Paperclip 面板的数据 hook。
 *
 * 任务与 agent 的服务端事实全部来自 IPaperclipService（host/server 进程内的
 * REST/WS 客户端）；本 hook 只做当次查询投影 + 事件驱动合并，unmount 即弃，
 * 不引入本地持久化（spec：Paperclip 是唯一事实源）。
 * 请求序号防迟到写入：面板刷新期间组件不会卸载，但慢响应可能晚于新请求返回，
 * 过期响应直接丢弃，避免旧列表覆盖新列表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type {
  PaperclipAdapterModel,
  PaperclipAgent,
  PaperclipConnectionStateSnapshot,
  PaperclipCreateIssueInput,
  PaperclipIssue,
  PaperclipIssueEvent,
  PaperclipIssueStatus,
  PaperclipLocalAdapterCandidate,
  PaperclipProject,
  PaperclipLocalServerStatus,
  PaperclipInteraction,
  PaperclipIssueComment,
  PaperclipRunSnapshot,
  PaperclipUpdateAgentInput,
} from "@zcode/shared";
import { usePaperclipActivity, type PaperclipIssueWriteToken } from "@/paperclip/usePaperclipActivity.js";
import { usePaperclipActions } from "@/paperclip/usePaperclipActions.js";

export interface UsePaperclipState {
  /** 服务是否可用（旧 host/测试 double 未注册时为 false，面板显示不可用态）。 */
  serviceAvailable: boolean;
  connection: PaperclipConnectionStateSnapshot | null;
  agents: PaperclipAgent[];
  /** 自动分派的 dispatcher（role==="ceo" 的第一个 agent；无则 null）。 */
  dispatcher: PaperclipAgent | null;
  issues: PaperclipIssue[];
  loadingIssues: boolean;
  /** 当次操作（创建/更新）失败的可读原因；成功后清空。 */
  actionError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  /** 启动本机 Paperclip server（幂等）；成功后自动刷新连接与列表。 */
  startLocalServer: () => Promise<PaperclipLocalServerStatus | null>;
  /** 停止本机 Paperclip server；完成后刷新面板回到断连引导态。 */
  stopLocalServer: () => Promise<PaperclipLocalServerStatus | null>;
  createIssue: (input: PaperclipCreateIssueInput) => Promise<boolean>;
  markDone: (issueId: string, comment?: string) => Promise<boolean>;
  /** 更新 agent 模型/effort；成功后合并进本地 agent 列表。 */
  updateAgent: (agentId: string, patch: PaperclipUpdateAgentInput) => Promise<boolean>;
  /** 确保 dispatcher（role=ceo）存在；成功后刷新 agent 列表并返回。 */
  ensureDispatcher: () => Promise<boolean>;
  /** 把主 Agent（调度负责人）切换到指定 agent；原主 Agent 回落普通成员。 */
  setDispatcher: (agentId: string) => Promise<boolean>;
  /** 创建 agent（「添加本地 agent」入口）；成功后并入本地列表。 */
  createAgent: (input: { name: string; adapterType: string; role?: string }) => Promise<boolean>;
  /** 删除 agent；成功后从本地列表移除（二次确认由 UI 承担）。 */
  deleteAgent: (agentId: string) => Promise<boolean>;
  /** 检测本机 CLI → local adapter 候选（懒加载缓存一次）。 */
  detectLocalAgentAdapters: () => Promise<PaperclipLocalAdapterCandidate[]>;
  /** 从本机 Claude Code 第三方网关发现真实模型清单（无配置返回空）。 */
  discoverClaudeModels: () => Promise<PaperclipAdapterModel[]>;
  /** Paperclip 项目列表（任务工作区载体；随 refresh 一并拉取）。 */
  projects: PaperclipProject[];
  /** 确保绑定指定本地路径的项目存在（「当前 ZCode 工作区」选项的实现）。 */
  ensureProjectForWorkspace: (input: { name: string; cwd: string }) => Promise<PaperclipProject | null>;
  /** 按 adapterType 拉可选模型（懒加载缓存）。 */
  loadAdapterModels: (adapterType: string) => Promise<PaperclipAdapterModel[]>;
  /** 每个任务最新一条心跳（进行中优先）。 */
  runsByIssueId: Readonly<Record<string, PaperclipRunSnapshot>>;
  /** 每个任务最近几条心跳，新的在前。 */
  runHistoryByIssueId: Readonly<Record<string, PaperclipRunSnapshot[]>>;
  /** 已拉取的评论，新的在前。展开任务或进度轮询时写入。 */
  commentsByIssueId: Readonly<Record<string, PaperclipIssueComment[]>>;
  /** 线程交互。有 pending 的提问/确认时，任务阶段是「等你」。 */
  interactionsByIssueId: Readonly<Record<string, PaperclipInteraction[]>>;
  /** 展开某条任务时补拉评论、交互和该任务自己的心跳。 */
  loadIssueThread: (issueId: string) => Promise<void>;
  /** 给人回复 agent。评论会唤醒 assignee。 */
  replyToIssue: (issueId: string, body: string) => Promise<boolean>;
  /** 状态交接：审查通过、打回。comment 与状态同一请求提交。 */
  transitionIssue: (
    issueId: string,
    status: PaperclipIssueStatus,
    comment?: string,
  ) => Promise<boolean>;
  acceptInteraction: (
    issueId: string,
    interactionId: string,
    body?: { selectedOptionIds?: string[] },
  ) => Promise<boolean>;
  rejectInteraction: (issueId: string, interactionId: string, reason?: string) => Promise<boolean>;
  respondInteraction: (
    issueId: string,
    interactionId: string,
    answers: ReadonlyArray<{ questionId: string; optionIds: string[] }>,
  ) => Promise<boolean>;
}

export function usePaperclip(): UsePaperclipState {
  const services = useServices();
  const paperclipService = services.paperclipService;

  const [connection, setConnection] = useState<PaperclipConnectionStateSnapshot | null>(null);
  const [agents, setAgents] = useState<PaperclipAgent[]>([]);
  const [projects, setProjects] = useState<PaperclipProject[]>([]);
  const [issues, setIssues] = useState<PaperclipIssue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const issuesRequestEpochRef = useRef(0);
  const issueWriteSeqRef = useRef(0);

  const commitIssues = useCallback((next: PaperclipIssue[], token: PaperclipIssueWriteToken) => {
    if (issuesRequestEpochRef.current !== token.epoch) return;
    if (issueWriteSeqRef.current !== token.seq) return;
    issueWriteSeqRef.current += 1;
    setIssues(next);
  }, []);

  const activityMode =
    connection?.state === "connected" || connection?.state === "polling" ? connection.state : "off";
  const activity = usePaperclipActivity({
    mode: activityMode,
    issues,
    onIssues: commitIssues,
    getIssueToken: () => ({
      epoch: issuesRequestEpochRef.current,
      seq: issueWriteSeqRef.current,
    }),
  });

  const mergeIssueEvent = useCallback((event: PaperclipIssueEvent) => {
    if (!event.issueId && !event.issue) return;
    setIssues((current) => {
      if (event.kind === "deleted" && event.issueId) {
        return current.filter((issue) => issue.id !== event.issueId);
      }
      if (!event.issue) return current;
      const next = event.issue;
      const index = current.findIndex((issue) => issue.id === next.id);
      if (index === -1) return [next, ...current];
      const copy = current.slice();
      copy[index] = next;
      return copy;
    });
    issueWriteSeqRef.current += 1;
  }, []);

  // 连接状态与任务事件订阅：服务实例不变则只订阅一次，cleanup 统一 dispose。
  useEffect(() => {
    if (!paperclipService) return;
    const stateDisposable = paperclipService.onDidChangeConnectionState((snapshot) => {
      setConnection(snapshot);
    });
    const eventDisposable = paperclipService.onDidReceiveIssueEvent((event) => {
      mergeIssueEvent(event);
    });
    return () => {
      stateDisposable.dispose();
      eventDisposable.dispose();
    };
  }, [paperclipService, mergeIssueEvent]);

  const loadAll = useCallback(async () => {
    if (!paperclipService) return;
    const epoch = issuesRequestEpochRef.current + 1;
    issuesRequestEpochRef.current = epoch;
    const seqAtStart = issueWriteSeqRef.current;
    setRefreshing(true);
    setLoadingIssues(true);
    try {
      const snapshot = await paperclipService.getConnectionState();
      if (issuesRequestEpochRef.current !== epoch) return;
      setConnection(snapshot);
      if (snapshot.state === "disconnected") {
        setAgents([]);
        setIssues([]);
        return;
      }
      const [nextAgents, nextIssues, nextProjects] = await Promise.all([
        paperclipService.listAgents(),
        paperclipService.listIssues(),
        paperclipService.listProjects().catch(() => [] as PaperclipProject[]),
      ]);
      if (issuesRequestEpochRef.current !== epoch) return;
      setAgents(nextAgents);
      commitIssues(nextIssues, { epoch, seq: seqAtStart });
      setProjects(nextProjects);
    } catch (error) {
      if (issuesRequestEpochRef.current !== epoch) return;
      logger.warn("paperclip panel refresh failed", { error });
    } finally {
      if (issuesRequestEpochRef.current === epoch) {
        setRefreshing(false);
        setLoadingIssues(false);
      }
    }
  }, [paperclipService, commitIssues]);

  // 面板挂载即拉一次（懒启动连接也在服务侧完成）。
  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // polling 降级态：无实时推送时 30s 轮询兜底（connected 态不轮询）。
  useEffect(() => {
    if (!paperclipService) return;
    if (connection?.state !== "polling") return;
    const timer = setInterval(() => {
      void loadAll();
    }, 30_000);
    return () => clearInterval(timer);
  }, [paperclipService, connection?.state, loadAll]);

  /** 启动本机 server：成功（running）后自动刷新面板；失败把 detail 落到操作错误提示。 */
  const startLocalServer = useCallback(async (): Promise<PaperclipLocalServerStatus | null> => {
    if (!paperclipService) return null;
    setActionError(null);
    const status = await paperclipService.startLocalServer();
    if (status.state === "running") {
      await loadAll();
    } else if (status.detail) {
      setActionError(status.detail);
    }
    return status;
  }, [paperclipService, loadAll]);

  /** 停止本机 server：成功（stopped）后刷新面板（自然回到断连引导态）。 */
  const stopLocalServer = useCallback(async (): Promise<PaperclipLocalServerStatus | null> => {
    if (!paperclipService) return null;
    setActionError(null);
    const status = await paperclipService.stopLocalServer();
    if (status.detail) {
      setActionError(status.detail);
    }
    await loadAll();
    return status;
  }, [paperclipService, loadAll]);


  const actions = usePaperclipActions({
    paperclipService,
    mergeIssueEvent,
    setActionError,
    setAgents,
    setProjects,
    loadIssueThread: activity.loadIssueThread,
  });

  const dispatcher = useMemo(
    () => agents.find((agent) => agent.role === "ceo") ?? null,
    [agents],
  );

  return {
    serviceAvailable: paperclipService !== undefined,
    connection,
    agents,
    dispatcher,
    issues,
    loadingIssues,
    actionError,
    refreshing,
    refresh: loadAll,
    startLocalServer,
    stopLocalServer,
    createIssue: actions.createIssue,
    markDone: actions.markDone,
    updateAgent: actions.updateAgent,
    ensureDispatcher: actions.ensureDispatcher,
    setDispatcher: actions.setDispatcher,
    createAgent: actions.createAgent,
    deleteAgent: actions.deleteAgent,
    detectLocalAgentAdapters: actions.detectLocalAgentAdapters,
    discoverClaudeModels: actions.discoverClaudeModels,
    projects,
    ensureProjectForWorkspace: actions.ensureProjectForWorkspace,
    loadAdapterModels: actions.loadAdapterModels,
    runsByIssueId: activity.runsByIssueId,
    runHistoryByIssueId: activity.runHistoryByIssueId,
    commentsByIssueId: activity.commentsByIssueId,
    interactionsByIssueId: activity.interactionsByIssueId,
    loadIssueThread: activity.loadIssueThread,
    replyToIssue: actions.replyToIssue,
    transitionIssue: actions.transitionIssue,
    acceptInteraction: actions.acceptInteraction,
    rejectInteraction: actions.rejectInteraction,
    respondInteraction: actions.respondInteraction,
  };
}
