/**
 * 数据浏览 tab 的表列表侧栏：筛选 + 强制刷新 +（加载/错误/空态/列表）。
 * 加载失败内联展示并可重试——不进用户动作错误横幅（断连窗口的瞬时失败会与服务恢复后的状态矛盾）。
 */
import { useMemo, useState } from "react";
import { Database, RefreshCw, Search } from "lucide-react";
import type { DbBoardKnowledge, DbBoardTableMeta } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DbBoardSelectedTable } from "@/dbBoard/useDbBoard.js";
import { sortTablesByRowCount } from "@/dbBoard/dbBoardViews.js";

export function DbBoardTableListSidebar({
  tables,
  loadingTables,
  tablesError,
  selectedTable,
  knowledge,
  rowCounts,
  onRefreshTables,
  onSelectTable,
}: {
  tables: readonly DbBoardTableMeta[];
  loadingTables: boolean;
  tablesError: string | null;
  selectedTable: DbBoardSelectedTable | null;
  knowledge: DbBoardKnowledge | null;
  /** 使用情况汇总的全量行数（小写表名 → 行数）；有值时表列表按行数倒序。 */
  rowCounts: Record<string, number> | null;
  onRefreshTables: () => Promise<void>;
  onSelectTable: (table: DbBoardSelectedTable | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [tableFilter, setTableFilter] = useState("");

  const visibleTables = useMemo(() => {
    const keyword = tableFilter.trim().toLowerCase();
    const filtered = keyword
      ? tables.filter((table) =>
          `${table.schema}.${table.name}`.toLowerCase().includes(keyword),
        )
      : tables;
    // 生成过数据库概览后按行数倒序（未统计的表靠后保持字母序）。
    return sortTablesByRowCount(filtered, rowCounts);
  }, [tables, tableFilter, rowCounts]);

  return (
    <aside className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
            <Input
              size="sm"
              value={tableFilter}
              onChange={(event) => setTableFilter(event.target.value)}
              placeholder={intl.formatMessage({ id: "dbboard.data.filterTables" })}
              className="pl-7 text-ui-base"
            />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void onRefreshTables()}
            disabled={loadingTables}
            title={intl.formatMessage({ id: "dbboard.data.refreshTables" })}
          >
            {loadingTables ? <Spinner className="size-3.5" /> : <RefreshCw />}
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
          {loadingTables ? (
            <div className="flex items-center justify-center gap-2 py-6 text-ui-sm text-foreground-subtle">
              <Spinner className="size-3.5" />
              {intl.formatMessage({ id: "dbboard.data.loadingTables" })}
            </div>
          ) : tablesError ? (
            <div className="flex flex-col gap-1.5 px-2 py-3 text-ui-xs text-foreground-subtle">
              <span className="break-all text-destructive">{tablesError}</span>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => void onRefreshTables()}
              >
                {intl.formatMessage({ id: "dbboard.data.refresh" })}
              </Button>
            </div>
          ) : visibleTables.length === 0 ? (
            <p className="px-2 py-3 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "dbboard.data.noTables" })}
            </p>
          ) : (
            visibleTables.map((table) => (
              <DbBoardTableListItem
                key={`${table.schema}.${table.name}`}
                table={table}
                active={
                  selectedTable?.schema === table.schema && selectedTable?.name === table.name
                }
                displayName={
                  knowledge?.tables[table.name.toLowerCase()]?.purpose?.trim() ||
                  table.comment?.trim() ||
                  ""
                }
                onSelect={onSelectTable}
              />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function DbBoardTableListItem({
  table,
  active,
  displayName,
  onSelect,
}: {
  table: DbBoardTableMeta;
  active: boolean;
  /** 知识卡用途或数据库表注释（中文名）；都没有时为空。 */
  displayName: string;
  onSelect: (table: DbBoardSelectedTable | null) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 flex-col rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover",
        active && "bg-selected",
      )}
      title={`${table.schema}.${table.name} · ${table.columnCount}${
        table.queryOnly ? ` · ${intl.formatMessage({ id: "dbboard.data.queryOnly" })}` : ""
      }`}
      onClick={() => onSelect({ schema: table.schema, name: table.name })}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Database className="size-3.5 shrink-0 text-foreground-subtle" />
        <span
          className={
            active ? "truncate text-ui-sm font-medium text-foreground" : "truncate text-ui-sm text-foreground"
          }
        >
          {table.name}
        </span>
      </span>
      <span className="truncate pl-5 text-ui-xs text-foreground-subtle" title={displayName || undefined}>
        {displayName || `${table.schema} · ${table.columnCount}`}
      </span>
    </button>
  );
}
