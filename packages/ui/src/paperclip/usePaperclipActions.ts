/**
 * Paperclip 面板的写操作。查询和实时投影留在 usePaperclip / usePaperclipActivity。
 */
import { useCallback, useRef } from "react";
import type { IPaperclipService } from "@zcode/services";
import type {
  PaperclipAdapterModel,
  PaperclipAgent,
  PaperclipCreateIssueInput,
  PaperclipIssueEvent,
  PaperclipIssueStatus,
  PaperclipLocalAdapterCandidate,
  PaperclipProject,
  PaperclipUpdateAgentInput,
} from "@zcode/shared";

export function usePaperclipActions(input: {
  paperclipService: IPaperclipService | undefined;
  mergeIssueEvent: (event: PaperclipIssueEvent) => void;
  setActionError: (message: string | null) => void;
  setAgents: (update: (current: PaperclipAgent[]) => PaperclipAgent[]) => void;
  setProjects: (update: (current: PaperclipProject[]) => PaperclipProject[]) => void;
  loadIssueThread: (issueId: string) => Promise<void>;
}) {
  const { paperclipService, mergeIssueEvent, setActionError, setAgents, setProjects, loadIssueThread } =
    input;

  const createIssue = useCallback(
    async (createInput: PaperclipCreateIssueInput) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const created = await paperclipService.createIssue(createInput);
        mergeIssueEvent({ kind: "created", issue: created, receivedAt: Date.now() });
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, mergeIssueEvent, setActionError],
  );

  const transitionIssue = useCallback(
    async (issueId: string, status: PaperclipIssueStatus, comment?: string) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const updated = await paperclipService.updateIssue(
          issueId,
          // Paperclip 审批门禁要求决策评论与状态变更同请求提交。
          comment === undefined ? { status } : { status, comment },
        );
        mergeIssueEvent({ kind: "updated", issue: updated, receivedAt: Date.now() });
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, mergeIssueEvent, setActionError],
  );

  const markDone = useCallback(
    (issueId: string, comment?: string) => transitionIssue(issueId, "done", comment),
    [transitionIssue],
  );

  const replyToIssue = useCallback(
    async (issueId: string, body: string) => {
      if (!paperclipService) return false;
      const trimmed = body.trim();
      if (!trimmed) return false;
      setActionError(null);
      try {
        await paperclipService.postComment(issueId, trimmed);
        await loadIssueThread(issueId);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, loadIssueThread, setActionError],
  );

  const acceptInteraction = useCallback(
    async (issueId: string, interactionId: string, body?: { selectedOptionIds?: string[] }) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        await paperclipService.acceptIssueInteraction(issueId, interactionId, body);
        await loadIssueThread(issueId);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, loadIssueThread, setActionError],
  );

  const rejectInteraction = useCallback(
    async (issueId: string, interactionId: string, reason?: string) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        await paperclipService.rejectIssueInteraction(issueId, interactionId, reason);
        await loadIssueThread(issueId);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, loadIssueThread, setActionError],
  );

  const respondInteraction = useCallback(
    async (
      issueId: string,
      interactionId: string,
      answers: ReadonlyArray<{ questionId: string; optionIds: string[] }>,
    ) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        await paperclipService.respondIssueInteraction(issueId, interactionId, answers);
        await loadIssueThread(issueId);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, loadIssueThread, setActionError],
  );

  const updateAgent = useCallback(
    async (agentId: string, patch: PaperclipUpdateAgentInput) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const updated = await paperclipService.updateAgent(agentId, patch);
        setAgents((current) => current.map((agent) => (agent.id === updated.id ? updated : agent)));
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, setActionError, setAgents],
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
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [paperclipService, setActionError, setAgents]);

  /**
   * 切换主 Agent（调度负责人）：新 agent 置 ceo，原主 Agent 回落 general。
   * Paperclip 侧 ceo 唯一，一次 PATCH 后本地把其余 ceo 收成 general；失败时错误留在 actionError。
   */
  const setDispatcher = useCallback(
    async (agentId: string) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const next = await paperclipService.updateAgent(agentId, { role: "ceo" });
        setAgents((current) =>
          current.map((agent) =>
            agent.id === next.id ? next : agent.role === "ceo" ? { ...agent, role: "general" } : agent,
          ),
        );
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, setActionError, setAgents],
  );

  const createAgent = useCallback(
    async (agentInput: { name: string; adapterType: string; role?: string }) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        const created = await paperclipService.createAgent(agentInput);
        setAgents((current) =>
          current.some((agent) => agent.id === created.id)
            ? current.map((agent) => (agent.id === created.id ? created : agent))
            : [...current, created],
        );
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, setActionError, setAgents],
  );

  const deleteAgent = useCallback(
    async (agentId: string) => {
      if (!paperclipService) return false;
      setActionError(null);
      try {
        await paperclipService.deleteAgent(agentId);
        setAgents((current) => current.filter((agent) => agent.id !== agentId));
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [paperclipService, setActionError, setAgents],
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
    async (projectInput: { name: string; cwd: string }) => {
      if (!paperclipService) return null;
      setActionError(null);
      try {
        const project = await paperclipService.ensureProjectForWorkspace(projectInput);
        setProjects((current) =>
          current.some((entry) => entry.id === project.id)
            ? current.map((entry) => (entry.id === project.id ? project : entry))
            : [...current, project],
        );
        return project;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [paperclipService, setActionError, setProjects],
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

  return {
    createIssue,
    markDone,
    transitionIssue,
    replyToIssue,
    acceptInteraction,
    rejectInteraction,
    respondInteraction,
    updateAgent,
    ensureDispatcher,
    setDispatcher,
    createAgent,
    deleteAgent,
    detectLocalAgentAdapters,
    discoverClaudeModels,
    ensureProjectForWorkspace,
    loadAdapterModels,
  };
}
