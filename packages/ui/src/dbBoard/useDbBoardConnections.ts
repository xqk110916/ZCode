/**
 * useDbBoardConnections —— 数据库看板的连接与工作区绑定管理 hook。
 *
 * 从 useDbBoard 拆出的连接域：状态快照（携带 workspaceKey 时服务端幂等拉齐绑定连接）、
 * 连接清单对账（含 15s 周期对账，防断连/重启窗口的滞留矛盾态）、绑定/激活/保存/删除。
 * actionError 与数据域共享（经 onActionError 回调上抛），保持单一错误横幅语义。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DbBoardConnectionConfig,
  DbBoardConnectionEntry,
  DbBoardConnectionSnapshot,
  DbBoardTestConnectionResult,
} from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface UseDbBoardConnectionsState {
  connection: DbBoardConnectionSnapshot | null;
  refreshConnection: () => Promise<void>;
  connections: DbBoardConnectionEntry[];
  loadConnections: () => Promise<void>;
  setActiveConnection: (id: string) => Promise<boolean>;
  /** 工作区绑定（null = 解绑；严格模式下未绑定工作区不可用）。 */
  setBinding: (connectionId: string | null) => Promise<boolean>;
  deleteConnection: (id: string) => Promise<boolean>;
  saveConnection: (
    entry: DbBoardConnectionEntry,
    password?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  testConnection: (
    config: DbBoardConnectionConfig,
    password?: string,
    connectionId?: string,
  ) => Promise<DbBoardTestConnectionResult>;
}

export function useDbBoardConnections(params: {
  workspaceKey?: string;
  onActionError: (message: string) => void;
}): UseDbBoardConnectionsState {
  const services = useServices();
  const dbBoardService = services.dbBoardService;
  const workspaceKey = params.workspaceKey?.trim() || null;
  const onActionError = params.onActionError;

  const [connection, setConnection] = useState<DbBoardConnectionSnapshot | null>(null);
  const [connections, setConnections] = useState<DbBoardConnectionEntry[]>([]);
  /** 连接清单最新值（供 refreshConnection 对账，避免闭包读到旧列表）。 */
  const connectionsRef = useRef<DbBoardConnectionEntry[]>([]);

  const refreshConnection = useCallback(async () => {
    if (!dbBoardService) return;
    try {
      const snapshot = await dbBoardService.getConnectionState(workspaceKey ?? undefined);
      setConnection(snapshot);
      // 断连/服务重启窗口期 listConnections 可能失败一次且挂载 effect 不会重发，
      // 之后成功的快照会与滞留的空清单并存（页头同时出现「尚未配置连接」与「已连接」）。
      // 每次快照成功后对账：服务端已有激活连接而本地清单缺失时补拉清单。
      const activeId = snapshot.activeConnectionId ?? null;
      const listCovers = activeId
        ? connectionsRef.current.some((entry) => entry.id === activeId)
        : connectionsRef.current.length > 0;
      if ((activeId ?? snapshot.config) && !listCovers) {
        void loadConnectionsRef.current?.();
      }
    } catch (error) {
      logger.warn("dbBoard getConnectionState failed", { error });
    }
  }, [dbBoardService, workspaceKey]);

  const loadConnections = useCallback(async () => {
    if (!dbBoardService) return;
    try {
      const list = await dbBoardService.listConnections();
      connectionsRef.current = list;
      setConnections(list);
    } catch (error) {
      logger.warn("dbBoard listConnections failed", { error });
    }
  }, [dbBoardService]);

  // refreshConnection 对账时补拉清单，经 ref 解引用避免回调相互依赖。
  const loadConnectionsRef = useRef<(() => Promise<void>) | null>(null);
  loadConnectionsRef.current = loadConnections;

  useEffect(() => {
    void refreshConnection();
    void loadConnections();
  }, [refreshConnection, loadConnections]);

  // 低频对账：服务重启/断连恢复后，挂载期失败的调用不会自动重发；快照对账 + 补拉清单
  // 让页头连接选择器、状态徽标与错误横幅在面板打开期间最终一致（getConnectionState 为内存态，开销可忽略）。
  useEffect(() => {
    const timer = setInterval(() => void refreshConnection(), 15_000);
    return () => clearInterval(timer);
  }, [refreshConnection]);

  const setActiveConnection = useCallback(
    async (id: string) => {
      if (!dbBoardService) return false;
      try {
        await dbBoardService.setActiveConnection(id);
        await refreshConnection();
        return true;
      } catch (error) {
        onActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, onActionError, refreshConnection],
  );

  const setBinding = useCallback(
    async (connectionId: string | null): Promise<boolean> => {
      if (!dbBoardService || !workspaceKey) return false;
      try {
        await dbBoardService.setBinding({ workspaceKey, connectionId });
        await Promise.all([loadConnections(), refreshConnection()]);
        return true;
      } catch (error) {
        onActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, workspaceKey, loadConnections, refreshConnection, onActionError],
  );

  const deleteConnection = useCallback(
    async (id: string) => {
      if (!dbBoardService) return false;
      try {
        await dbBoardService.deleteConnection(id);
        await Promise.all([loadConnections(), refreshConnection()]);
        return true;
      } catch (error) {
        onActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, loadConnections, refreshConnection, onActionError],
  );

  const saveConnection = useCallback(
    async (entry: DbBoardConnectionEntry, password?: string) => {
      if (!dbBoardService) return { ok: false, error: "service unavailable" };
      try {
        await dbBoardService.saveConnection(entry, password);
        await Promise.all([loadConnections(), refreshConnection()]);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    [dbBoardService, loadConnections, refreshConnection],
  );

  const testConnection = useCallback(
    async (config: DbBoardConnectionConfig, password?: string, connectionId?: string) => {
      if (!dbBoardService) {
        return { ok: false, error: "service unavailable" };
      }
      return dbBoardService.testConnection(config, password, connectionId);
    },
    [dbBoardService],
  );

  return {
    connection,
    refreshConnection,
    connections,
    loadConnections,
    setActiveConnection,
    setBinding,
    deleteConnection,
    saveConnection,
    testConnection,
  };
}
