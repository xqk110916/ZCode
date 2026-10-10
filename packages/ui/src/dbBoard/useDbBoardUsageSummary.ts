/**
 * useDbBoardUsageSummary —— 知识库汇总看板的数据 hook。
 *
 * 打开面板只读服务端缓存（不自动逐表计数）；生成/刷新由汇总看板按钮显式触发
 * （compute/force），导出文档时经 loadUsageSummary({compute:true}) 兜底补算。
 */
import { useCallback, useEffect, useState } from "react";
import type { DbBoardUsageSummary } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface UseDbBoardUsageSummaryState {
  usageSummary: DbBoardUsageSummary | null;
  usageSummaryComputing: boolean;
  loadUsageSummary: (params?: {
    compute?: boolean;
    force?: boolean;
  }) => Promise<DbBoardUsageSummary | null>;
}

export function useDbBoardUsageSummary(params: { workspaceKey?: string } = {}): UseDbBoardUsageSummaryState {
  const services = useServices();
  const dbBoardService = services.dbBoardService;
  const workspaceKey = params.workspaceKey?.trim() || null;
  const [usageSummary, setUsageSummary] = useState<DbBoardUsageSummary | null>(null);
  const [usageSummaryComputing, setUsageSummaryComputing] = useState(false);

  const loadUsageSummary = useCallback(
    async (params: { compute?: boolean; force?: boolean } = {}) => {
      if (!dbBoardService) return null;
      const computing = Boolean(params.compute || params.force);
      if (computing) setUsageSummaryComputing(true);
      try {
        const next = await dbBoardService.getUsageSummary({
          ...params,
          ...(workspaceKey ? { workspaceKey } : {}),
        });
        setUsageSummary(next);
        return next;
      } catch (error) {
        logger.warn("dbBoard getUsageSummary failed", { error });
        return null;
      } finally {
        if (computing) setUsageSummaryComputing(false);
      }
    },
    [dbBoardService, workspaceKey],
  );

  useEffect(() => {
    void loadUsageSummary();
  }, [loadUsageSummary]);

  return { usageSummary, usageSummaryComputing, loadUsageSummary };
}
