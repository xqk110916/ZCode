/**
 * 探索看板单张图卡片：标题/刷新时间/失败标注 + 图表主体 + 查询抽屉（SQL/复制/导出/解释）。
 * 查询抽屉常驻可展开——「数字必须能被打开」（需求文档 3.2）。
 */
import { useCallback, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Download, RefreshCw, Sparkles } from "lucide-react";
import type { DbBoardChartSpec, DbBoardSqlResult } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardChartBody } from "@/dbBoard/DbBoardChartBody.js";
import { formatClockTime, formatCellValue } from "@/dbBoard/dbBoardViews.js";
import type { DbBoardChartRunState } from "@/dbBoard/useDbBoardDashboards.js";

function csvEscape(value: unknown): string {
  const text = formatCellValue(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/gu, '""')}"`;
  }
  return text;
}

function downloadChartCsv(chart: DbBoardChartSpec, result: DbBoardSqlResult): void {
  const header = result.columns.map((column) => csvEscape(column.name)).join(",");
  const lines = result.rows.map((row) =>
    result.columns.map((column) => csvEscape(row[column.name])).join(","),
  );
  // BOM 保证 Excel 识别 UTF-8 中文。
  const blob = new Blob(["\uFEFF".concat([header, ...lines].join("\r\n"))], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${chart.title || "chart"}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function DbBoardChartCard({
  chart,
  run,
  explanation,
  explaining,
  onRefresh,
  onExplain,
}: {
  chart: DbBoardChartSpec;
  run: DbBoardChartRunState | undefined;
  explanation: string | null;
  explaining: boolean;
  onRefresh: () => void;
  onExplain: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [queryOpen, setQueryOpen] = useState(false);
  const result = run?.result ?? null;

  const handleCopySql = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(chart.sql);
      toast(intl.formatMessage({ id: "dbboard.chart.sqlCopied" }), { variant: "info" });
    } catch {
      toast(intl.formatMessage({ id: "dbboard.chart.copyFailed" }), { variant: "warning" });
    }
  }, [chart.sql, intl]);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-card-border bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-ui-base font-medium text-foreground">{chart.title}</span>
          {chart.description ? (
            <span className="line-clamp-2 text-ui-xs text-foreground-subtle">
              {chart.description}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {run?.running ? <Spinner className="size-3.5" /> : null}
          {run?.error ? (
            <Badge variant="destructive">
              {intl.formatMessage({ id: "dbboard.chart.failed" })}
            </Badge>
          ) : run?.lastSuccessAt ? (
            <span className="whitespace-nowrap text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: "dbboard.chart.refreshedAt" },
                { time: formatClockTime(run.lastSuccessAt) },
              )}
            </span>
          ) : null}
        </div>
      </div>

      {run?.error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          <div className="break-all">{run.error}</div>
          {result ? (
            <div className="mt-1 text-foreground-subtle">
              {intl.formatMessage({ id: "dbboard.chart.showingLastSuccess" })}
            </div>
          ) : null}
        </div>
      ) : null}

      <DbBoardChartBody chart={chart} result={result} />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={run?.running}>
          <RefreshCw />
          {intl.formatMessage({ id: "dbboard.chart.refresh" })}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setQueryOpen((open) => !open)}>
          {queryOpen ? <ChevronUp /> : <ChevronDown />}
          {intl.formatMessage({ id: "dbboard.chart.viewQuery" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => result && downloadChartCsv(chart, result)}
          disabled={!result || result.rows.length === 0}
        >
          <Download />
          CSV
        </Button>
        <Button variant="ghost" size="sm" onClick={onExplain} disabled={explaining}>
          <Sparkles />
          {intl.formatMessage({ id: "dbboard.chart.explain" })}
        </Button>
      </div>

      {queryOpen ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ui-xs font-medium text-foreground-subtle">SQL</span>
            <Button variant="ghost" size="sm" onClick={handleCopySql}>
              <Copy />
              {intl.formatMessage({ id: "dbboard.chart.copySql" })}
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-xs text-foreground">
            {chart.sql}
          </pre>
          {explanation ? (
            <div className="border-t border-border pt-2">
              <span className="text-ui-xs font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.chart.explanation" })}
              </span>
              <p className="mt-1 whitespace-pre-wrap text-ui-xs text-foreground">{explanation}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
