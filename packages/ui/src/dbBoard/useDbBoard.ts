/**
 * useDbBoard —— 数据库看板「数据浏览」tab 的数据 hook。
 *
 * 事实全部来自 IDbBoardService（连接配置/元数据/行数据/审计日志）；
 * 本 hook 只做当次查询投影，unmount 即弃，无本地持久化。
 * 请求序号防迟到写入（与 usePaperclip 同口径）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useDbBoardConnections } from "@/dbBoard/useDbBoardConnections.js";
import { useDbBoardUsageSummary } from "@/dbBoard/useDbBoardUsageSummary.js";
import type { UseDbBoardUsageSummaryState } from "@/dbBoard/useDbBoardUsageSummary.js";
import type {
  DbBoardColumnMeta,
  DbBoardConnectionConfig,
  DbBoardConnectionEntry,
  DbBoardConnectionSnapshot,
  DbBoardOpLogResult,
  DbBoardQueryResult,
  DbBoardTableMeta,
  DbBoardTestConnectionResult,
} from "@zcode/services";

export interface DbBoardSelectedTable {
  schema: string;
  name: string;
}

export interface UseDbBoardState {
  serviceAvailable: boolean;
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
  tables: DbBoardTableMeta[];
  loadingTables: boolean;
  /** 表清单加载失败的可读原因（成功后清除）；与用户动作失败的 actionError 分离。 */
  tablesError: string | null;
  /** 知识库汇总看板（独立 hook：见 useDbBoardUsageSummary）。 */
  usage: UseDbBoardUsageSummaryState;
  /** 强制回源刷新表清单（服务端有进程内缓存，平时打开面板不重复查库）。 */
  refreshTables: () => Promise<void>;
  /** 拉取表列元数据（知识卡新增选表自动带出等场景）。 */
  getTableColumns: (schema: string, table: string) => Promise<DbBoardColumnMeta[]>;
  selectedTable: DbBoardSelectedTable | null;
  selectTable: (table: DbBoardSelectedTable | null) => void;
  queryResult: DbBoardQueryResult | null;
  loadingRows: boolean;
  page: number;
  setPage: (page: number) => void;
  pageSize: number;
  setPageSize: (size: number) => void;
  searchColumn: string | null;
  searchValue: string;
  applySearch: (column: string | null, value: string) => void;
  refreshRows: () => Promise<void>;
  insertRow: (values: Record<string, unknown>, operator: string) => Promise<boolean>;
  updateRow: (
    pk: Record<string, unknown>,
    values: Record<string, unknown>,
    operator: string,
  ) => Promise<boolean>;
  opLogs: DbBoardOpLogResult | null;
  loadingOpLogs: boolean;
  opLogFilter: DbBoardSelectedTable | null;
  setOpLogFilter: (filter: DbBoardSelectedTable | null) => void;
  refreshOpLogs: () => Promise<void>;
  rollback: (logId: number, operator: string) => Promise<boolean>;
  /** 当次操作失败的可读原因；成功后清空。 */
  actionError: string | null;
  clearActionError: () => void;
}

export function useDbBoard(params: { workspaceKey?: string } = {}): UseDbBoardState {
  const services = useServices();
  const dbBoardService = services.dbBoardService;
  const workspaceKey = params.workspaceKey?.trim() || null;

  const [actionError, setActionError] = useState<string | null>(null);
  const connectionsState = useDbBoardConnections({
    workspaceKey: params.workspaceKey,
    onActionError: (message) => setActionError(message),
  });
  const [tables, setTables] = useState<DbBoardTableMeta[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  /** 表清单加载失败的可读原因（瞬时失败自恢复后清除；与用户动作失败的 actionError 分离）。 */
  const [tablesError, setTablesError] = useState<string | null>(null);
  const usage = useDbBoardUsageSummary({ workspaceKey: params.workspaceKey });
  const [selectedTable, setSelectedTable] = useState<DbBoardSelectedTable | null>(null);
  const [queryResult, setQueryResult] = useState<DbBoardQueryResult | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(50);
  const [searchColumn, setSearchColumn] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [opLogs, setOpLogs] = useState<DbBoardOpLogResult | null>(null);
  const [loadingOpLogs, setLoadingOpLogs] = useState(false);
  const [opLogFilter, setOpLogFilter] = useState<DbBoardSelectedTable | null>(null);

  const rowsRequestSeq = useRef(0);
  const logsRequestSeq = useRef(0);

  const serviceAvailable = Boolean(dbBoardService);

  const loadTables = useCallback(
    async (options2?: { force?: boolean; select?: DbBoardSelectedTable | null }) => {
      if (!dbBoardService) return;
      setLoadingTables(true);
      try {
        const nextTables = await dbBoardService.listTables(
          options2?.force ?? false,
          workspaceKey ?? undefined,
        );
        setTables(nextTables);
        setTablesError(null);
        if (options2?.select !== undefined) {
          setSelectedTable(options2.select);
        }
      } catch (error) {
        // 加载失败不进 actionError（那是用户动作失败的横幅）；断连/重启窗口的瞬时失败
        // 曾以「尚未配置数据库连接」滞留在红色横幅里，与服务恢复后的状态互相矛盾。
        setTablesError(error instanceof Error ? error.message : String(error));
        logger.warn("dbBoard listTables failed", { error });
      } finally {
        setLoadingTables(false);
      }
    },
    [dbBoardService, workspaceKey],
  );

  const refreshTables = useCallback(async () => {
    await loadTables({ force: true });
  }, [loadTables]);

  const getTableColumns = useCallback(
    async (schema: string, table: string) => {
      if (!dbBoardService) {
        throw new Error("service unavailable");
      }
      return dbBoardService.getTableColumns(schema, table, workspaceKey ?? undefined);
    },
    [dbBoardService, workspaceKey],
  );

  // 连接就绪后加载表清单（含保存连接后的自动刷新）。
  const connection = connectionsState.connection;
  useEffect(() => {
    if (connection?.state === "connected" && tables.length === 0 && !loadingTables) {
      void loadTables();
    }
  }, [connection?.state, tables.length, loadingTables, loadTables]);

  const refreshRows = useCallback(async () => {
    if (!dbBoardService || !selectedTable) {
      setQueryResult(null);
      return;
    }
    const seq = ++rowsRequestSeq.current;
    setLoadingRows(true);
    try {
      const result = await dbBoardService.queryRows({
        ...(workspaceKey ? { workspaceKey } : {}),
        schema: selectedTable.schema,
        table: selectedTable.name,
        page,
        pageSize,
        ...(searchColumn && searchValue.trim()
          ? { searchColumn: searchColumn, searchValue: searchValue.trim() }
          : {}),
      });
      if (seq !== rowsRequestSeq.current) return;
      setQueryResult(result);
      setActionError(null);
    } catch (error) {
      if (seq !== rowsRequestSeq.current) return;
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === rowsRequestSeq.current) {
        setLoadingRows(false);
      }
    }
  }, [dbBoardService, selectedTable, page, pageSize, searchColumn, searchValue, workspaceKey]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const selectTable = useCallback((table: DbBoardSelectedTable | null) => {
    setSelectedTable(table);
    setPageState(1);
    setSearchColumn(null);
    setSearchValue("");
    setQueryResult(null);
  }, []);

  const setPage = useCallback((nextPage: number) => {
    setPageState(Math.max(1, nextPage));
  }, []);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPageState(1);
  }, []);

  const applySearch = useCallback((column: string | null, value: string) => {
    setSearchColumn(column);
    setSearchValue(value);
    setPageState(1);
  }, []);

  const refreshOpLogs = useCallback(async () => {
    if (!dbBoardService) return;
    const seq = ++logsRequestSeq.current;
    setLoadingOpLogs(true);
    try {
      const result = await dbBoardService.listOpLogs({
        ...(workspaceKey ? { workspaceKey } : {}),
        ...(opLogFilter
          ? { schema: opLogFilter.schema, table: opLogFilter.name }
          : {}),
        page: 1,
        pageSize: 50,
      });
      if (seq !== logsRequestSeq.current) return;
      setOpLogs(result);
    } catch (error) {
      if (seq !== logsRequestSeq.current) return;
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === logsRequestSeq.current) {
        setLoadingOpLogs(false);
      }
    }
  }, [dbBoardService, opLogFilter, workspaceKey]);

  useEffect(() => {
    void refreshOpLogs();
  }, [refreshOpLogs]);

  const insertRow = useCallback(
    async (values: Record<string, unknown>, operator: string) => {
      if (!dbBoardService || !selectedTable) return false;
      try {
        await dbBoardService.insertRow({
          ...(workspaceKey ? { workspaceKey } : {}),
          schema: selectedTable.schema,
          table: selectedTable.name,
          values,
          operator,
        });
        setActionError(null);
        await Promise.all([refreshRows(), refreshOpLogs()]);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, selectedTable, refreshRows, refreshOpLogs, workspaceKey],
  );

  const updateRow = useCallback(
    async (pk: Record<string, unknown>, values: Record<string, unknown>, operator: string) => {
      if (!dbBoardService || !selectedTable) return false;
      try {
        await dbBoardService.updateRow({
          ...(workspaceKey ? { workspaceKey } : {}),
          schema: selectedTable.schema,
          table: selectedTable.name,
          pk,
          values,
          operator,
        });
        setActionError(null);
        await Promise.all([refreshRows(), refreshOpLogs()]);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, selectedTable, refreshRows, refreshOpLogs, workspaceKey],
  );

  const rollback = useCallback(
    async (logId: number, operator: string) => {
      if (!dbBoardService) return false;
      try {
        await dbBoardService.rollback({ logId, operator });
        setActionError(null);
        await Promise.all([refreshOpLogs(), refreshRows(), loadTables()]);
        return true;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, refreshOpLogs, refreshRows, loadTables],
  );

  return {
    serviceAvailable,
    ...connectionsState,    connection,
    tables,
    loadingTables,
    tablesError,
    usage,
    refreshTables,
    getTableColumns,
    selectedTable,
    selectTable,
    queryResult,
    loadingRows,
    page,
    setPage,
    pageSize,
    setPageSize,
    searchColumn,
    searchValue,
    applySearch,
    refreshRows,
    insertRow,
    updateRow,
    opLogs,
    loadingOpLogs,
    opLogFilter,
    setOpLogFilter,
    refreshOpLogs,
    rollback,
    actionError,
    clearActionError: () => setActionError(null),
  };
}
