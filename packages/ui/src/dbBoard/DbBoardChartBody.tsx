/**
 * 探索看板图表渲染：按 chart.type 渲染 kpi / table / bar / line / pie。
 * 维度/度量列优先用生成侧给出的 columnHints，缺失时按结果列自动推断。
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import type { DbBoardChartSpec, DbBoardSqlResult } from "@zcode/services";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SERIES_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;

const CHART_MARGIN = { top: 8, right: 16, left: 8 } as const;
const MAX_TABLE_ROWS = 50;

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveChartColumns(chart: DbBoardChartSpec, result: DbBoardSqlResult) {
  const columnNames = result.columns.map((column) => column.name);
  const sampleRow = result.rows[0] ?? {};
  const numericColumns = columnNames.filter((name) => toNumber(sampleRow[name]) !== null);
  const hintDimension = chart.columnHints?.dimension;
  const dimension =
    (hintDimension && columnNames.includes(hintDimension) ? hintDimension : undefined) ??
    columnNames.find((name) => !numericColumns.includes(name)) ??
    columnNames[0] ??
    "";
  const hintMeasures = chart.columnHints?.measures?.filter((name) => columnNames.includes(name));
  const measures =
    hintMeasures && hintMeasures.length > 0
      ? hintMeasures
      : numericColumns.filter((name) => name !== dimension).slice(0, 4);
  return { dimension, measures: measures.length > 0 ? measures : columnNames.slice(0, 1) };
}

function DbBoardKpiView({
  chart,
  result,
}: {
  chart: DbBoardChartSpec;
  result: DbBoardSqlResult;
}) {
  const { intl } = useZCodeIntl();
  const { dimension, measures } = useMemo(
    () => resolveChartColumns(chart, result),
    [chart, result],
  );
  const measure = measures[0] ?? result.columns[0]?.name ?? "";
  const row = result.rows[0];
  const value = row ? toNumber(row[measure]) ?? row[measure] : null;
  const label = row && dimension ? String(row[dimension] ?? "") : measure;
  if (row === undefined || value === null || value === undefined) {
    return (
      <div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.chart.noData" })}
      </div>
    );
  }
  return (
    <div className="flex h-32 flex-col items-center justify-center gap-1">
      <span className="font-mono text-ui-xl font-semibold tabular-nums text-foreground">
        {typeof value === "number" ? value.toLocaleString() : String(value)}
      </span>
      <span className="min-w-0 truncate text-ui-sm text-foreground-subtle">{label}</span>
    </div>
  );
}

function DbBoardTableView({ result }: { result: DbBoardSqlResult }) {
  const { intl } = useZCodeIntl();
  const columns = result.columns;
  const rows = result.rows.slice(0, MAX_TABLE_ROWS);
  if (rows.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.chart.noData" })}
      </div>
    );
  }
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-border">
      <table className="w-full text-left text-ui-sm">
        <thead className="sticky top-0 bg-surface">
          <tr>
            {columns.map((column) => (
              <th
                key={column.name}
                className="max-w-48 truncate px-3 py-2 font-medium text-foreground-subtle"
              >
                {column.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border">
              {columns.map((column) => (
                <td key={column.name} className="max-w-48 truncate px-3 py-1.5 font-mono">
                  {formatCell(row[column.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > rows.length ? (
        <div className="border-t border-border px-3 py-1.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "dbboard.chart.rowsTruncated" },
            { shown: rows.length, total: result.rows.length },
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DbBoardAxisChartView({
  chart,
  result,
  kind,
}: {
  chart: DbBoardChartSpec;
  result: DbBoardSqlResult;
  kind: "bar" | "line";
}) {
  const { intl } = useZCodeIntl();
  const { dimension, measures } = useMemo(
    () => resolveChartColumns(chart, result),
    [chart, result],
  );
  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    measures.forEach((measure, index) => {
      config[measure] = {
        label: measure,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
      };
    });
    return config;
  }, [measures]);

  const data = useMemo(
    () =>
      result.rows.map((row) => {
        const entry: Record<string, string | number> = {
          __label: String(row[dimension] ?? ""),
        };
        for (const measure of measures) {
          entry[measure] = toNumber(row[measure]) ?? 0;
        }
        return entry;
      }),
    [result.rows, dimension, measures],
  );

  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.chart.noData" })}
      </div>
    );
  }

  return (
    <ChartContainer config={chartConfig} className="h-56 w-full">
      {kind === "bar" ? (
        <BarChart accessibilityLayer data={data} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="__label" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={48} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          {measures.map((measure) => (
            <Bar key={measure} dataKey={measure} fill={`var(--color-${measure})`} maxBarSize={28} />
          ))}
        </BarChart>
      ) : (
        <LineChart accessibilityLayer data={data} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="__label" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={48} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          {measures.map((measure) => (
            <Line
              key={measure}
              type="monotone"
              dataKey={measure}
              stroke={`var(--color-${measure})`}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}

function DbBoardPieView({ chart, result }: { chart: DbBoardChartSpec; result: DbBoardSqlResult }) {
  const { intl } = useZCodeIntl();
  const { dimension, measures } = useMemo(
    () => resolveChartColumns(chart, result),
    [chart, result],
  );
  const measure = measures[0] ?? result.columns[0]?.name ?? "";
  const data = useMemo(
    () =>
      result.rows
        .map((row, index) => ({
          name: String(row[dimension] ?? ""),
          value: toNumber(row[measure]) ?? 0,
          fill: SERIES_COLORS[index % SERIES_COLORS.length],
        }))
        .filter((item) => item.value > 0)
        .slice(0, 12),
    [result.rows, dimension, measure],
  );
  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.chart.noData" })}
      </div>
    );
  }
  const chartConfig = { [measure]: { label: measure } } satisfies ChartConfig;
  return (
    <ChartContainer config={chartConfig} className="h-56 w-full">
      <PieChart accessibilityLayer margin={CHART_MARGIN}>
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={40} outerRadius={72} />
      </PieChart>
    </ChartContainer>
  );
}

export function DbBoardChartBody({
  chart,
  result,
}: {
  chart: DbBoardChartSpec;
  result: DbBoardSqlResult | null;
}) {
  if (!result) {
    return null;
  }
  switch (chart.type) {
    case "kpi":
      return <DbBoardKpiView chart={chart} result={result} />;
    case "table":
      return <DbBoardTableView result={result} />;
    case "pie":
      return <DbBoardPieView chart={chart} result={result} />;
    case "line":
      return <DbBoardAxisChartView chart={chart} result={result} kind="line" />;
    case "bar":
    default:
      return <DbBoardAxisChartView chart={chart} result={result} kind="bar" />;
  }
}
