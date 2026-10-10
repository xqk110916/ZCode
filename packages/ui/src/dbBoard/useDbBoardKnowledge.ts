/**
 * useDbBoardKnowledge —— 知识库 tab 的数据 hook。
 *
 * 事实：profile/知识本体在服务端文件（~/.zcode/v2/db-board-knowledge.json）；
 * 构建进度经 onBuildProgress 事件订阅（RPC Event），hook 内做当次投影。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DbBoardKnowledge,
  DbBoardKnowledgeBuildProgress,
  DbBoardKnowledgeProbeResult,
  DbBoardKnowledgeProfile,
  DbBoardKnowledgeTableCard,
} from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface UseDbBoardKnowledgeState {
  serviceAvailable: boolean;
  profile: DbBoardKnowledgeProfile | null;
  probe: DbBoardKnowledgeProbeResult | null;
  probing: boolean;
  runProbe: (root: string) => Promise<DbBoardKnowledgeProbeResult | null>;
  saveProfile: (
    profile: DbBoardKnowledgeProfile,
    nacosPassword?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  buildState: DbBoardKnowledgeBuildProgress | null;
  startBuild: () => Promise<void>;
  cancelBuild: () => Promise<void>;
  knowledge: DbBoardKnowledge | null;
  refreshKnowledge: () => Promise<void>;
  saveTableCard: (card: DbBoardKnowledgeTableCard) => Promise<boolean>;
  deleteTableCard: (table: string) => Promise<boolean>;
  /** 手动单表蒸馏（不落盘，返回草稿卡；失败抛错由调用方展示）。 */
  distillTableCard: (schema: string, table: string) => Promise<DbBoardKnowledgeTableCard>;
  deleteKnowledge: () => Promise<void>;
  /** 当次操作失败的可读原因；成功后清空。 */
  actionError: string | null;
  clearActionError: () => void;
}

export function useDbBoardKnowledge(): UseDbBoardKnowledgeState {
  const services = useServices();
  const knowledgeService = services.dbBoardKnowledgeService;

  const [profile, setProfile] = useState<DbBoardKnowledgeProfile | null>(null);
  const [probe, setProbe] = useState<DbBoardKnowledgeProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [buildState, setBuildState] = useState<DbBoardKnowledgeBuildProgress | null>(null);
  const [knowledge, setKnowledge] = useState<DbBoardKnowledge | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  const serviceAvailable = Boolean(knowledgeService);

  const refreshKnowledge = useCallback(async () => {
    if (!knowledgeService) return;
    const seq = ++refreshSeq.current;
    try {
      const next = await knowledgeService.getKnowledge();
      if (seq === refreshSeq.current) {
        setKnowledge(next);
      }
    } catch (error) {
      logger.warn("dbBoardKnowledge getKnowledge failed", { error });
    }
  }, [knowledgeService]);

  useEffect(() => {
    if (!knowledgeService) {
      return;
    }
    void knowledgeService.getProfile().then(setProfile).catch(() => undefined);
    void knowledgeService.getBuildState().then(setBuildState).catch(() => undefined);
    void refreshKnowledge();
    // 构建进度事件订阅（终态时顺带刷新知识本体）
    const disposable = knowledgeService.onBuildProgress((event) => {
      setBuildState(event);
      if (event.status !== "running" && event.status !== "idle") {
        void refreshKnowledge();
      }
    });
    return () => {
      disposable.dispose();
    };
  }, [knowledgeService, refreshKnowledge]);

  const runProbe = useCallback(
    async (root: string) => {
      if (!knowledgeService || !root.trim()) {
        return null;
      }
      setProbing(true);
      try {
        const result = await knowledgeService.probeProject(root.trim());
        setProbe(result);
        return result;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setProbing(false);
      }
    },
    [knowledgeService],
  );

  const saveProfile = useCallback(
    async (nextProfile: DbBoardKnowledgeProfile, nacosPassword?: string) => {
      if (!knowledgeService) {
        return { ok: false, error: "service unavailable" };
      }
      try {
        await knowledgeService.saveProfile(nextProfile, nacosPassword);
        setProfile(await knowledgeService.getProfile());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [knowledgeService],
  );

  const startBuild = useCallback(async () => {
    if (!knowledgeService) {
      return;
    }
    setActionError(null);
    try {
      await knowledgeService.startBuild();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [knowledgeService]);

  const cancelBuild = useCallback(async () => {
    if (!knowledgeService) {
      return;
    }
    await knowledgeService.cancelBuild().catch(() => undefined);
  }, [knowledgeService]);

  const deleteKnowledge = useCallback(async () => {
    if (!knowledgeService) {
      return;
    }
    try {
      await knowledgeService.deleteKnowledge();
      await refreshKnowledge();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [knowledgeService, refreshKnowledge]);

  const saveTableCard = useCallback(
    async (card: DbBoardKnowledgeTableCard) => {
      if (!knowledgeService) {
        return false;
      }
      try {
        await knowledgeService.saveTableCard(card);
        await refreshKnowledge();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [knowledgeService, refreshKnowledge],
  );

  const deleteTableCard = useCallback(
    async (table: string) => {
      if (!knowledgeService) {
        return false;
      }
      try {
        await knowledgeService.deleteTableCard(table);
        await refreshKnowledge();
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [knowledgeService, refreshKnowledge],
  );

  const distillTableCard = useCallback(
    async (schema: string, table: string) => {
      if (!knowledgeService) {
        throw new Error("service unavailable");
      }
      return knowledgeService.distillTableCard({ schema, table });
    },
    [knowledgeService],
  );

  return {
    serviceAvailable,
    profile,
    probe,
    probing,
    runProbe,
    saveProfile,
    buildState,
    startBuild,
    cancelBuild,
    knowledge,
    refreshKnowledge,
    saveTableCard,
    deleteTableCard,
    distillTableCard,
    deleteKnowledge,
    actionError,
    clearActionError: () => setActionError(null),
  };
}
