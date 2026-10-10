/**
 * 知识库 tab：可折叠项目档案/构建 + 知识浏览占满剩余高度。
 * 数据库概览在独立「概览」tab；本 tab 仅在导出文档时经 onEnsureSummary 兜底补算汇总。
 * 本 tab 不提供写代码/调服务能力——深挖引导用户以常规 ZCode 任务打开该项目工作区。
 */
import { useState } from "react";
import type {
  DbBoardColumnMeta,
  DbBoardConnectionEntry,
  DbBoardTableMeta,
  DbBoardUsageSummary,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardKnowledgeBrowse } from "@/dbBoard/DbBoardKnowledgeBrowse.js";
import { DbBoardKnowledgeSetup } from "@/dbBoard/DbBoardKnowledgeSetup.js";
import type { UseDbBoardKnowledgeState } from "@/dbBoard/useDbBoardKnowledge.js";

export function DbBoardKnowledgeTab({
  state,
  connections,
  boardTables,
  onLoadColumns,
  onEnsureSummary,
}: {
  state: UseDbBoardKnowledgeState;
  connections: DbBoardConnectionEntry[];
  boardTables: readonly DbBoardTableMeta[];
  onLoadColumns: (schema: string, table: string) => Promise<DbBoardColumnMeta[]>;
  /** 导出文档时确保汇总已生成（缓存缺失则补算）；概览展示在独立「概览」tab。 */
  onEnsureSummary: (
    params?: { compute?: boolean; force?: boolean },
  ) => Promise<DbBoardUsageSummary | null>;
}) {
  const { intl } = useZCodeIntl();
  const [keyword, setKeyword] = useState("");
  const knowledge = state.knowledge;
  const effectiveRoot = state.profile?.projectRoot ?? "";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DbBoardKnowledgeSetup state={state} connections={connections} />

      {knowledge ? (
        <DbBoardKnowledgeBrowse
          knowledge={knowledge}
          keyword={keyword}
          onKeywordChange={setKeyword}
          projectRoot={effectiveRoot}
          onSaveCard={state.saveTableCard}
          onDeleteCard={state.deleteTableCard}
          tables={boardTables}
          onLoadColumns={onLoadColumns}
          onDistill={state.distillTableCard}
          onEnsureSummary={() => onEnsureSummary({ compute: true })}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-card-border bg-card px-6 text-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "dbboard.knowledge.empty" })}
        </div>
      )}

      {state.actionError ? (
        <div className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-ui-sm text-destructive">
          <div className="flex items-center justify-between gap-2">
            <span className="line-clamp-2 break-all">{state.actionError}</span>
            <Button variant="ghost" size="sm" onClick={state.clearActionError}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
