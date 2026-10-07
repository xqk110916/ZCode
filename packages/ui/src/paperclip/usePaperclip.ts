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
  PaperclipUpdateAgentInput,
} from "@zcode/shared";

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
  createIssue: (input: PaperclipCreateIssueInput) => Promise<boolean>;
  markDone: (issueId: string, comment?: string) => Promise<boolean>;
  /** 更新 agent 模型/effort；成功后合并进本地 agent 列表。 */
  updateAgent: (agentId: string, patch: PaperclipUpdateAgentInput) => Promise<boolean>;
  /** 确保 dispatcher（role=ceo）存在；成功后刷新 agent 列表并返回。 */
  ensureDispatcher: () => Promise<boolean>;
  /** 创建 agent（「添加本地 agent」入口）；成功后并入本地列表。 */
  createAgent: (input: { name: string; adapterType: string; role?: string }) => Promise<boolean>;
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
      setIssues(nextIssues);
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
  }, [paperclipService]);

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

  const createIssue = useCallback(
    async (input: PaperclipCreateIssueInput) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const created = await paperclipService.createIssue(input);
        mergeIssueEvent({ kind: "created", issue: created, receivedAt: Date.now() });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        return false;
      }
    },
    [paperclipService, mergeIssueEvent],
  );

  const markDone = useCallback(
    async (issueId: string, comment?: string) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const updated = await paperclipService.updateIssue(
          issueId,
          // Paperclip 审批门禁要求决策评论与状态变更同请求提交。
          comment === undefined ? { status: "done" satisfies PaperclipIssueStatus } : { status: "done" satisfies PaperclipIssueStatus, comment },
        );
        mergeIssueEvent({ kind: "updated", issue: updated, receivedAt: Date.now() });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        return false;
      }
    },
    [paperclipService, mergeIssueEvent],
  );

  const updateAgent = useCallback(
    async (agentId: string, patch: PaperclipUpdateAgentInput) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const updated = await paperclipService.updateAgent(agentId, patch);
        // PATCH 返回权威后置状态，直接替换本地行（服务端事实）。
        setAgents((current) =>
          current.map((agent) => (agent.id === updated.id ? updated : agent)),
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        return false;
      }
    },
    [paperclipService],
  );

  const ensureDispatcher = useCallback(async () => {
    if (!paperclipService) return false;
    setActionError(null);
    try {
      const dispatcher = await paperclipService.ensureDispatcherAgent();
      setAgents((current) =>
        current.some((agent) => agent.id === dispatcher.id)
          ? current.map((agent) => (agent.id === dispatcher.id ? dispatcher : agent))
          : [...current, dispatcher],
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(message);
      return false;
    }
  }, [paperclipService]);

  const createAgent = useCallback(
    async (input: { name: string; adapterType: string; role?: string }) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const created = await paperclipService.createAgent(input);
        setAgents((current) =>
          current.some((agent) => agent.id === created.id)
            ? current.map((agent) => (agent.id === created.id ? created : agent))
            : [...current, created],
        );
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        return false;
      }
    },
    [paperclipService],
  );

  const localAdaptersCacheRef = useRef<PaperclipLocalAdapterCandidate[] | null>(null);
  const detectLocalAgentAdapters = useCallback(async () => {
    if (localAdaptersCacheRef.current) return localAdaptersCacheRef.current;
    if (!paperclipService) return [];
    const candidates = await paperclipService.detectLocalAgentAdapters();
    localAdaptersCacheRef.current = candidates;
    return candidates;
  }, [paperclipService]);

  const discoverClaudeModels = useCallback(async () => {
    if (!paperclipService) return [];
    try {
      return await paperclipService.discoverClaudeModels();
    } catch {
      return [];
    }
  }, [paperclipService]);

  const ensureProjectForWorkspace = useCallback(
    async (input: { name: string; cwd: string }) => {
      if (!paperclipService) return null;
      setActionError(null);
      try {
        const project = await paperclipService.ensureProjectForWorkspace(input);
        setProjects((current) =>
          current.some((entry) => entry.id === project.id)
            ? current.map((entry) => (entry.id === project.id ? project : entry))
            : [...current, project],
        );
        return project;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setActionError(message);
        return null;
      }
    },
    [paperclipService],
  );

  const adapterModelsCacheRef = useRef(new Map<string, PaperclipAdapterModel[]>());
  const adapterModelsInFlightRef = useRef(new Map<string, Promise<PaperclipAdapterModel[]>>());
  const loadAdapterModels = useCallback(
    async (adapterType: string) => {
      const cached = adapterModelsCacheRef.current.get(adapterType);
      if (cached) return cached;
      const inFlight = adapterModelsInFlightRef.current.get(adapterType);
      if (inFlight) return inFlight;
      if (!paperclipService) return [];
      const load = paperclipService
        .listAdapterModels(adapterType)
        .then((models) => {
          adapterModelsCacheRef.current.set(adapterType, models);
          return models;
        })
        .finally(() => {
          adapterModelsInFlightRef.current.delete(adapterType);
        });
      adapterModelsInFlightRef.current.set(adapterType, load);
      return load;
    },
    [paperclipService],
  );

  const dispatcher = useMemo(
    () => agents.find((agent) => agent.role === "ceo") ?? null,
    [agents],
  );

  return useMemo(
    () => ({
      serviceAvailable: paperclipService !== undefined,
      connection,
      agents,
      dispatcher,
      issues,
      loadingIssues,
      actionError,
      refreshing,
      refresh: loadAll,
      createIssue,
      markDone,
      updateAgent,
      ensureDispatcher,
      createAgent,
      detectLocalAgentAdapters,
      discoverClaudeModels,
      projects,
      ensureProjectForWorkspace,
      loadAdapterModels,
    }),
    [
      paperclipService,
      connection,
      agents,
      dispatcher,
      issues,
      loadingIssues,
      actionError,
      refreshing,
      loadAll,
      createIssue,
      markDone,
      updateAgent,
      ensureDispatcher,
      createAgent,
      detectLocalAgentAdapters,
      discoverClaudeModels,
      projects,
      ensureProjectForWorkspace,
      loadAdapterModels,
    ],
  );
}
