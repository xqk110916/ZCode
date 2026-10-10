/**
 * useDbBoardDashboards —— 数据库看板「探索看板」tab 的数据 hook。
 *
 * 看板定义事实在服务端（custom-resources KV）；运行态（每图的最近成功数据、
 * 失败标注、刷新时间、生成/修订进度）放在模块级 persistent state——切 tab / 切主视图
 * （组件卸载）不丢失，进行中的生成请求照常推进并在回来后可见；不落盘（刷新页面重置）。
 * 失败保留上次成功数据并标注（需求文档 AC-5），单图可重试。
 */
import { useCallback, useEffect } from "react";
import { usePersistentState } from "@/dbBoard/dbBoardPersistentState.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type {
  DbBoardDashboardSpec,
  DbBoardDashboardSummary,
  DbBoardSqlResult,
} from "@zcode/services";

export interface DbBoardChartRunState {
  running: boolean;
  result: DbBoardSqlResult | null;
  error: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
}

export interface UseDbBoardDashboardsState {
  serviceAvailable: boolean;
  dashboards: DbBoardDashboardSummary[];
  loadDashboards: () => Promise<void>;
  currentSpec: DbBoardDashboardSpec | null;
  openDashboard: (id: string) => Promise<void>;
  newDashboard: () => void;
  generating: boolean;
  generateError: string | null;
  modelInfo: { providerId: string; modelId: string } | null;
  generate: (question: string) => Promise<void>;
  revise: (note: string) => Promise<void>;
  chartRuns: Readonly<Record<string, DbBoardChartRunState>>;
  refreshChart: (chartId: string) => Promise<void>;
  refreshAllCharts: () => Promise<void>;
  explaining: boolean;
  explanation: { chartId: string; text: string } | null;
  explainChart: (chartId: string) => Promise<void>;
  saveCurrent: () => Promise<boolean>;
  deleteDashboard: (id: string) => Promise<boolean>;
  saved: boolean;
}

export function useDbBoardDashboards(params: { workspaceKey?: string } = {}): UseDbBoardDashboardsState {
  const workspaceKey = params.workspaceKey?.trim() || null;
  const services = useServices();
  const dbBoardService = services.dbBoardService;

  const scope = `${workspaceKey ?? "default"}:dashboards`;
  const [dashboards, setDashboards] = usePersistentState<DbBoardDashboardSummary[]>(
    `${scope}:list`,
    [],
  );
  const [currentSpec, setCurrentSpec] = usePersistentState<DbBoardDashboardSpec | null>(
    `${scope}:spec`,
    null,
  );
  const [generating, setGenerating] = usePersistentState<boolean>(`${scope}:generating`, false);
  const [generateError, setGenerateError] = usePersistentState<string | null>(
    `${scope}:error`,
    null,
  );
  const [modelInfo, setModelInfo] = usePersistentState<{
    providerId: string;
    modelId: string;
  } | null>(`${scope}:model`, null);
  const [chartRuns, setChartRuns] = usePersistentState<Record<string, DbBoardChartRunState>>(
    `${scope}:chartRuns`,
    {},
  );
  const [explaining, setExplaining] = usePersistentState<boolean>(`${scope}:explaining`, false);
  const [explanation, setExplanation] = usePersistentState<{
    chartId: string;
    text: string;
  } | null>(`${scope}:explanation`, null);
  const [saved, setSaved] = usePersistentState<boolean>(`${scope}:saved`, false);

  const [runSeq, setRunSeq] = usePersistentState<number>(`${scope}:runSeq`, 0);

  const serviceAvailable = Boolean(dbBoardService);

  const loadDashboards = useCallback(async () => {
    if (!dbBoardService) return;
    try {
      setDashboards(await dbBoardService.listDashboards());
    } catch (error) {
      logger.warn("dbBoard listDashboards failed", { error });
    }
  }, [dbBoardService]);

  useEffect(() => {
    void loadDashboards();
  }, [loadDashboards]);

  const runChart = useCallback(
    async (spec: DbBoardDashboardSpec, chartId: string) => {
      if (!dbBoardService) return;
      const chart = spec.charts.find((item) => item.id === chartId);
      if (!chart) return;
      const seq = runSeq;
      setChartRuns((prev) => ({
        ...prev,
        [chartId]: {
          running: true,
          result: prev[chartId]?.result ?? null,
          error: null,
          lastSuccessAt: prev[chartId]?.lastSuccessAt ?? null,
          lastAttemptAt: new Date().toISOString(),
        },
      }));
      try {
        const result = await dbBoardService.runDashboardSql(chart.sql, workspaceKey ?? undefined);
        if (seq !== runSeq) return;
        setChartRuns((prev) => ({
          ...prev,
          [chartId]: {
            running: false,
            result,
            error: null,
            lastSuccessAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
          },
        }));
      } catch (error) {
        if (seq !== runSeq) return;
        // 失败保留上次成功数据，只标注错误（不静默清空）。
        setChartRuns((prev) => ({
          ...prev,
          [chartId]: {
            running: false,
            result: prev[chartId]?.result ?? null,
            error: error instanceof Error ? error.message : String(error),
            lastSuccessAt: prev[chartId]?.lastSuccessAt ?? null,
            lastAttemptAt: new Date().toISOString(),
          },
        }));
      }
    },
    [dbBoardService, workspaceKey],
  );

  const runAllCharts = useCallback(
    async (spec: DbBoardDashboardSpec) => {
      setRunSeq((prev) => prev + 1);
      setChartRuns(
        Object.fromEntries(
          spec.charts.map((chart) => [
            chart.id,
            {
              running: true,
              result: null,
              error: null,
              lastSuccessAt: null,
              lastAttemptAt: new Date().toISOString(),
            },
          ]),
        ),
      );
      await Promise.all(spec.charts.map((chart) => runChart(spec, chart.id)));
    },
    [runChart],
  );

  const openDashboard = useCallback(
    async (id: string) => {
      if (!dbBoardService) return;
      try {
        const spec = await dbBoardService.getDashboard(id);
        if (spec) {
          setCurrentSpec(spec);
          setSaved(true);
          setGenerateError(null);
          await runAllCharts(spec);
        }
      } catch (error) {
        setGenerateError(error instanceof Error ? error.message : String(error));
      }
    },
    [dbBoardService, workspaceKey, runAllCharts],
  );

  const newDashboard = useCallback(() => {
    setRunSeq((prev) => prev + 1);
    setCurrentSpec(null);
    setChartRuns({});
    setGenerateError(null);
    setExplanation(null);
    setSaved(false);
  }, []);

  const generateInternal = useCallback(
    async (question: string, revisionNote?: string) => {
      if (!dbBoardService) return;
      setGenerating(true);
      setGenerateError(null);
      try {
        const result = await dbBoardService.generateDashboard({
          ...(workspaceKey ? { workspaceKey } : {}),
          question,
          ...(revisionNote && currentSpec ? { previousSpec: currentSpec, revisionNote } : {}),
        });
        setCurrentSpec(result.spec);
        setModelInfo(result.modelInfo ?? null);
        setSaved(false);
        setExplanation(null);
        await runAllCharts(result.spec);
      } catch (error) {
        setGenerateError(error instanceof Error ? error.message : String(error));
      } finally {
        setGenerating(false);
      }
    },
    [dbBoardService, workspaceKey, currentSpec, runAllCharts],
  );

  const generate = useCallback(
    async (question: string) => {
      await generateInternal(question);
    },
    [generateInternal],
  );

  const revise = useCallback(
    async (note: string) => {
      if (!currentSpec) return;
      await generateInternal(currentSpec.question, note);
    },
    [currentSpec, generateInternal],
  );

  const refreshChart = useCallback(
    async (chartId: string) => {
      if (!currentSpec) return;
      await runChart(currentSpec, chartId);
    },
    [currentSpec, runChart],
  );

  const refreshAllCharts = useCallback(async () => {
    if (!currentSpec) return;
    await runAllCharts(currentSpec);
  }, [currentSpec, runAllCharts]);

  const explainChart = useCallback(
    async (chartId: string) => {
      if (!dbBoardService || !currentSpec) return;
      const chart = currentSpec.charts.find((item) => item.id === chartId);
      if (!chart) return;
      setExplaining(true);
      try {
        const result = await dbBoardService.explainQuery({
          ...(workspaceKey ? { workspaceKey } : {}),
          sql: chart.sql,
          chartTitle: chart.title,
          question: currentSpec.question,
        });
        setExplanation({ chartId, text: result.explanation });
      } catch (error) {
        setExplanation({
          chartId,
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setExplaining(false);
      }
    },
    [dbBoardService, workspaceKey, currentSpec],
  );

  const saveCurrent = useCallback(async () => {
    if (!dbBoardService || !currentSpec) return false;
    try {
      const next = await dbBoardService.saveDashboard(currentSpec);
      setCurrentSpec(next);
      setSaved(true);
      await loadDashboards();
      return true;
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [dbBoardService, currentSpec, loadDashboards]);

  const deleteDashboard = useCallback(
    async (id: string) => {
      if (!dbBoardService) return false;
      try {
        await dbBoardService.deleteDashboardDefinition(id);
        if (currentSpec?.id === id) {
          newDashboard();
        }
        await loadDashboards();
        return true;
      } catch (error) {
        setGenerateError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [dbBoardService, workspaceKey, currentSpec?.id, loadDashboards, newDashboard],
  );

  return {
    serviceAvailable,
    dashboards,
    loadDashboards,
    currentSpec,
    openDashboard,
    newDashboard,
    generating,
    generateError,
    modelInfo,
    generate,
    revise,
    chartRuns,
    refreshChart,
    refreshAllCharts,
    explaining,
    explanation,
    explainChart,
    saveCurrent,
    deleteDashboard,
    saved,
  };
}
