/**
 * 数据浏览 tab：左侧表列表 + 右侧数据网格（分页/单列搜索/新增/编辑）。
 * 界面上不存在删除按钮（产品规则）；新增/编辑由元数据驱动的表单完成。
 * 审计日志已拆分为独立 tab（DbBoardLogsTab）。
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import type { DbBoardColumnMeta, DbBoardKnowledge, DbBoardTableMeta } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardEditDialog } from "@/dbBoard/DbBoardEditDialog.js";
import { DbBoardTableListSidebar } from "@/dbBoard/DbBoardTableListSidebar.js";
import { formatCellValue } from "@/dbBoard/dbBoardViews.js";
import type { UseDbBoardState } from "@/dbBoard/useDbBoard.js";

const SEARCH_ALL = "__all__";

function findTableMeta(
  tables: readonly DbBoardTableMeta[],
  schema: string,
  name: string,
): DbBoardTableMeta | undefined {
  return tables.find((table) => table.schema === schema && table.name === name);
}

export function DbBoardDataTab({
  state,
  operator,
  knowledge,
  rowCounts,
}: {
  state: UseDbBoardState;
  operator: string;
  /** 项目知识库（表列表卡片显示中文名/业务用途）。 */
  knowledge: DbBoardKnowledge | null;
  /** 使用情况汇总的全量行数；有值时表列表按行数倒序。 */
  rowCounts: Record<string, number> | null;
}) {
  const { intl } = useZCodeIntl();
  const [editMode, setEditMode] = useState<"insert" | "update" | null>(null);
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);

  const selectedMeta = state.selectedTable
    ? findTableMeta(state.tables, state.selectedTable.schema, state.selectedTable.name)
    : undefined;
  const columns: readonly DbBoardColumnMeta[] = state.queryResult?.columns ?? [];
  const rows = state.queryResult?.rows ?? [];
  const total = state.queryResult?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  const writable = Boolean(selectedMeta && !selectedMeta.queryOnly);

  // 跳页输入；翻页后回填当前页码
  const [pageJump, setPageJump] = useState(String(state.page));
  useEffect(() => {
    setPageJump(String(state.page));
  }, [state.page]);
  const jumpToPage = () => {
    const target = Number(pageJump);
    if (Number.isInteger(target) && target >= 1 && target <= totalPages) {
      state.setPage(target);
    } else {
      setPageJump(String(state.page));
    }
  };

  const pkOfRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const pk: Record<string, unknown> = {};
    for (const column of columns) {
      if (column.isPrimaryKey) {
        pk[column.name] = row[column.name] ?? null;
      }
    }
    return pk;
  };

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <DbBoardTableListSidebar
        tables={state.tables}
        loadingTables={state.loadingTables}
        tablesError={state.tablesError}
        selectedTable={state.selectedTable}
        knowledge={knowledge}
        rowCounts={rowCounts}
        onRefreshTables={state.refreshTables}
        onSelectTable={state.selectTable}
      />

      <div className="flex min-h-0 flex-col gap-3">
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

        {!state.selectedTable ? (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-card-border bg-card text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "dbboard.data.selectTableHint" })}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-ui-base font-medium text-foreground">
                {state.selectedTable.schema}.{state.selectedTable.name}
              </span>
              {selectedMeta?.queryOnly ? (
                <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "dbboard.data.queryOnlyBadge" })}
                </span>
              ) : null}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {columns.length > 0 ? (
                  <>
                    <Select
                      value={state.searchColumn ?? SEARCH_ALL}
                      onValueChange={(value) =>
                        state.applySearch(
                          value === SEARCH_ALL ? null : value,
                          state.searchValue,
                        )
                      }
                    >
                      <SelectTrigger size="sm" className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SEARCH_ALL}>
                          {intl.formatMessage({ id: "dbboard.data.allColumns" })}
                        </SelectItem>
                        {columns.map((column) => (
                          <SelectItem key={column.name} value={column.name}>
                            {column.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      size="sm"
                      value={state.searchValue}
                      onChange={(event) =>
                        state.applySearch(state.searchColumn, event.target.value)
                      }
                      placeholder={intl.formatMessage({ id: "dbboard.data.searchPlaceholder" })}
                      className="w-48 text-ui-base"
                    />
                  </>
                ) : null}
                <Select
                  value={String(state.pageSize)}
                  onValueChange={(value) => state.setPageSize(Number(value) || 50)}
                >
                  <SelectTrigger size="sm" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[20, 50, 100, 200].map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} / {intl.formatMessage({ id: "dbboard.data.page" })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => void state.refreshRows()}>
                  <RefreshCw />
                  {intl.formatMessage({ id: "dbboard.data.refresh" })}
                </Button>
                <Button
                  size="sm"
                  disabled={!writable}
                  title={
                    writable
                      ? undefined
                      : intl.formatMessage({ id: "dbboard.data.queryOnlyBadge" })
                  }
                  onClick={() => {
                    setEditRow(null);
                    setEditMode("insert");
                  }}
                >
                  <Plus />
                  {intl.formatMessage({ id: "dbboard.data.insert" })}
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-card-border bg-card">
              {state.loadingRows ? (
                <div className="flex h-full items-center justify-center gap-2 text-ui-sm text-foreground-subtle">
                  <Spinner className="size-4" />
                  {intl.formatMessage({ id: "dbboard.data.loadingRows" })}
                </div>
              ) : rows.length === 0 ? (
                <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "dbboard.data.noRows" })}
                </div>
              ) : (
                <table className="w-full text-left text-ui-sm">
                  <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_var(--color-border)]">
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column.name}
                          className="max-w-56 whitespace-nowrap px-3 py-2 font-medium text-foreground-subtle"
                          title={
                            column.comment
                              ? `${column.comment}（${column.name} · ${column.dataType}）`
                              : `${column.name} · ${column.dataType}`
                          }
                        >
                          <span className="font-mono">{column.name}</span>
                          {column.comment ? (
                            <span className="ml-1.5 font-sans text-ui-xs opacity-70">
                              {column.comment}
                            </span>
                          ) : null}
                        </th>
                      ))}
                      <th className="sticky right-0 bg-card px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className="border-t border-border hover:bg-surface-hover">
                        {columns.map((column) => (
                          <td
                            key={column.name}
                            className="max-w-56 truncate px-3 py-1.5 font-mono"
                            title={formatCellValue(row[column.name])}
                          >
                            {row[column.name] === null || row[column.name] === undefined ? (
                              <span className="text-foreground-subtle">NULL</span>
                            ) : (
                              formatCellValue(row[column.name])
                            )}
                          </td>
                        ))}
                        <td className="sticky right-0 border-t border-border bg-card px-2 py-1">
                          {writable ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-foreground-subtle hover:bg-transparent hover:text-foreground"
                              onClick={() => {
                                setEditRow(row);
                                setEditMode("update");
                              }}
                            >
                              {intl.formatMessage({ id: "dbboard.data.edit" })}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-ui-xs text-foreground-subtle">
              <span>
                {intl.formatMessage(
                  { id: "dbboard.data.totalRows" },
                  { total, page: state.page, pages: totalPages },
                )}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={state.page <= 1}
                  onClick={() => state.setPage(state.page - 1)}
                >
                  <ChevronLeft />
                </Button>
                <span className="flex items-center gap-1">
                  <Input
                    size="sm"
                    className="w-14 text-center text-ui-base"
                    value={pageJump}
                    inputMode="numeric"
                    onChange={(event) => setPageJump(event.target.value.replace(/\D/gu, ""))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        jumpToPage();
                      }
                    }}
                    aria-label={intl.formatMessage({ id: "dbboard.data.pageJump" })}
                  />
                  <span>/ {totalPages}</span>
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={state.page >= totalPages}
                  onClick={() => state.setPage(state.page + 1)}
                >
                  <ChevronRight />
                </Button>
                <Button variant="outline" size="sm" onClick={jumpToPage} disabled={!pageJump}>
                  {intl.formatMessage({ id: "dbboard.data.pageGo" })}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {state.selectedTable && editMode ? (
        <DbBoardEditDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditMode(null);
              setEditRow(null);
            }
          }}
          mode={editMode}
          columns={columns}
          row={editMode === "update" ? editRow : null}
          onSubmit={async (values) =>
            editMode === "insert"
              ? state.insertRow(values, operator)
              : state.updateRow(pkOfRow(editRow ?? {}), values, operator)
          }
        />
      ) : null}
    </div>
  );
}

