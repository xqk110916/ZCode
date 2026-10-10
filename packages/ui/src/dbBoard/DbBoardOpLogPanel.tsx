/**
 * 审计日志面板：看板增/改操作日志列表 + 变更列 diff + 回退（AlertDialog 确认）。
 * 全面板无删除数据入口；回退 insert 会明确提示"该行将被移除"。
 * 独立 tab 场景传 fillHeight 让列表占满剩余高度，headerExtra 可注入筛选控件。
 */
import { useState, type ReactNode } from "react";
import { History, RefreshCw, Undo2 } from "lucide-react";
import type { DbBoardOpLogEntry } from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildOpLogDiffRows,
  formatDateTime,
  formatPkLabel,
  opLogTargetLabel,
} from "@/dbBoard/dbBoardViews.js";

export function DbBoardOpLogPanel({
  entries,
  loading,
  onRefresh,
  onRollback,
  fillHeight = false,
  headerExtra,
}: {
  entries: readonly DbBoardOpLogEntry[];
  loading: boolean;
  onRefresh: () => void;
  onRollback: (logId: number) => Promise<boolean>;
  /** 独立 tab 模式：占满父容器剩余高度（内部滚动）。 */
  fillHeight?: boolean;
  /** 注入到标题行右侧的额外控件（如按表筛选）。 */
  headerExtra?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pendingRollback, setPendingRollback] = useState<DbBoardOpLogEntry | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-card-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <History className="size-4 text-foreground-subtle" />
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "dbboard.logs.title" })}
          </span>
          {loading ? <Spinner className="size-3.5" /> : null}
          {headerExtra}
        </div>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw />
          {intl.formatMessage({ id: "dbboard.logs.refresh" })}
        </Button>
      </header>
      <div
        className={
          fillHeight
            ? "min-h-0 flex-1 overflow-y-auto border-t border-border"
            : "max-h-80 overflow-y-auto border-t border-border"
        }
      >
        {entries.length === 0 ? (
          <p className="px-4 py-6 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "dbboard.logs.empty" })}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {entries.map((entry) => {
              const expanded = expandedId === entry.id;
              return (
                <div key={entry.id} className="px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setExpandedId(expanded ? null : entry.id)}
                    >
                      <Badge variant={entry.opType === "insert" ? "default" : "secondary"}>
                        {entry.opType}
                      </Badge>
                      <span className="min-w-0 truncate font-mono text-ui-sm text-foreground">
                        {opLogTargetLabel(entry)}
                      </span>
                      <span className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
                        {formatPkLabel(entry)}
                      </span>
                    </button>
                    {entry.status === "rolled_back" ? (
                      <Badge variant="outline">
                        {intl.formatMessage({ id: "dbboard.logs.rolledBack" })}
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingRollback(entry)}
                        title={intl.formatMessage({ id: "dbboard.logs.rollback" })}
                      >
                        <Undo2 />
                        {intl.formatMessage({ id: "dbboard.logs.rollback" })}
                      </Button>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-ui-xs text-foreground-subtle">
                    <span>#{entry.id}</span>
                    <span>{formatDateTime(entry.createdAt)}</span>
                    <span>{entry.operator}</span>
                    {entry.rollbackOf ? (
                      <span>
                        {intl.formatMessage({ id: "dbboard.logs.compensationOf" }, { id2: entry.rollbackOf })}
                      </span>
                    ) : null}
                  </div>
                  {expanded ? (
                    <div className="mt-2 overflow-x-auto rounded-lg bg-surface p-2">
                      <table className="w-full text-left text-ui-xs">
                        <thead>
                          <tr className="text-foreground-subtle">
                            <th className="px-2 py-1 font-medium">
                              {intl.formatMessage({ id: "dbboard.logs.column" })}
                            </th>
                            <th className="px-2 py-1 font-medium">
                              {intl.formatMessage({ id: "dbboard.logs.before" })}
                            </th>
                            <th className="px-2 py-1 font-medium">
                              {intl.formatMessage({ id: "dbboard.logs.after" })}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {buildOpLogDiffRows(entry).map((row) => (
                            <tr key={row.column} className="border-t border-border">
                              <td className="px-2 py-1 font-mono">{row.column}</td>
                              <td className="max-w-64 truncate px-2 py-1 font-mono text-foreground-subtle">
                                {row.beforeNull
                                  ? intl.formatMessage({ id: "dbboard.logs.null" })
                                  : row.before || "—"}
                              </td>
                              <td className="max-w-64 truncate px-2 py-1 font-mono">
                                {row.afterNull
                                  ? intl.formatMessage({ id: "dbboard.logs.null" })
                                  : row.after || "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={pendingRollback !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "dbboard.logs.rollbackConfirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRollback?.opType === "insert"
                ? intl.formatMessage({ id: "dbboard.logs.rollbackInsertDescription" })
                : intl.formatMessage({ id: "dbboard.logs.rollbackUpdateDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingRollback;
                if (!target) return;
                setPendingRollback(null);
                setRollingBack(true);
                void onRollback(target.id).finally(() => setRollingBack(false));
              }}
            >
              {rollingBack
                ? intl.formatMessage({ id: "dbboard.logs.rollingBack" })
                : intl.formatMessage({ id: "dbboard.logs.rollback" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
