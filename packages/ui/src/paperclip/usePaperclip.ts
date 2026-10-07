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
  PaperclipAgent,
  PaperclipConnectionStateSnapshot,
  PaperclipCreateIssueInput,
  PaperclipIssue,
  PaperclipIssueEvent,
  PaperclipIssueStatus,
} from "@zcode/shared";

export interface UsePaperclipState {
  /** 服务是否可用（旧 host/测试 double 未注册时为 false，面板显示不可用态）。 */
  serviceAvailable: boolean;
  connection: PaperclipConnectionStateSnapshot | null;
  agents: PaperclipAgent[];
  issues: PaperclipIssue[];
  loadingIssues: boolean;
  /** 当次操作（创建/更新）失败的可读原因；成功后清空。 */
  actionError: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  createIssue: (input: PaperclipCreateIssueInput) => Promise<boolean>;
  markDone: (issueId: string, comment?: string) => Promise<boolean>;
}

export function usePaperclip(): UsePaperclipState {
  const services = useServices();
  const paperclipService = services.paperclipService;

  const [connection, setConnection] = useState<PaperclipConnectionStateSnapshot | null>(null);
  const [agents, setAgents] = useState<PaperclipAgent[]>([]);
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
      const [nextAgents, nextIssues] = await Promise.all([
        paperclipService.listAgents(),
        paperclipService.listIssues(),
      ]);
      if (issuesRequestEpochRef.current !== epoch) return;
      setAgents(nextAgents);
      setIssues(nextIssues);
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

  return useMemo(
    () => ({
      serviceAvailable: paperclipService !== undefined,
      connection,
      agents,
      issues,
      loadingIssues,
      actionError,
      refreshing,
      refresh: loadAll,
      createIssue,
      markDone,
    }),
    [
      paperclipService,
      connection,
      agents,
      issues,
      loadingIssues,
      actionError,
      refreshing,
      loadAll,
      createIssue,
      markDone,
    ],
  );
}
