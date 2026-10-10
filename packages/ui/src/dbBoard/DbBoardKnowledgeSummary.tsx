/**
 * 「概览」tab：数据库概览汇总看板（总表/知识覆盖/业务域/已统计行数 + 常用业务表清单）。
 * 行数来自 dbBoard.getUsageSummary 的逐表 count（显式生成，服务端缓存）；
 * 行数 ≥1000 的知识表按行数降序取前 20，作为「使用比较频繁」的近似。
 * 独立占满一个 tab；知识库 tab 的导出仍会复用同一份缓存。
 */
import { RefreshCw, Zap } from "lucide-react";
import type { DbBoardUsageSummary } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

function formatRowCount(value: number): string {
  return value.toLocaleString();
}

export function DbBoardKnowledgeSummary({
  summary,
  computing,
  knowledgeReady,
  onGenerate,
  onRefresh,
}: {
  summary: DbBoardUsageSummary | null;
  computing: boolean;
  knowledgeReady: boolean;
  onGenerate: () => void;
  onRefresh: () => void;
}) {
  const { intl } = useZCodeIntl();

  if (!summary && !computing) {
    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-card-border bg-card px-6 py-10 text-center">
        <Zap className="size-6 text-foreground-subtle" />
        <p className="max-w-md text-ui-sm text-foreground-subtle">
          {knowledgeReady
            ? intl.formatMessage({ id: "dbboard.knowledge.summaryEmptyHint" })
            : intl.formatMessage({ id: "dbboard.knowledge.summaryNoKnowledge" })}
        </p>
        {knowledgeReady ? (
          <Button variant="outline" size="sm" onClick={onGenerate}>
            <Zap />
            {intl.formatMessage({ id: "dbboard.knowledge.summaryGenerate" })}
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-xl border border-card-border bg-card p-5">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "dbboard.knowledge.summaryTitle" })}
        </span>
        {summary ? (
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "dbboard.knowledge.summaryGeneratedAt" },
              { time: new Date(summary.generatedAt).toLocaleString() },
            )}
            {" · "}
            {intl.formatMessage({ id: "dbboard.knowledge.summarySourceCount" })}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={!knowledgeReady || computing}
          onClick={summary ? onRefresh : onGenerate}
        >
          {computing ? <Spinner className="size-3.5" /> : <RefreshCw />}
          {summary
            ? intl.formatMessage({ id: "dbboard.knowledge.summaryRefresh" })
            : intl.formatMessage({ id: "dbboard.knowledge.summaryGenerate" })}
        </Button>
      </div>

      {summary ? (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ["dbboard.knowledge.summaryTables", summary.tableCount],
                ["dbboard.knowledge.summaryKnowledge", summary.knowledgeTableCount],
                ["dbboard.knowledge.summaryDomains", summary.domainCount],
                ["dbboard.knowledge.summaryCounted", summary.countedTableCount],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex min-w-0 flex-col gap-1 rounded-lg bg-surface px-4 py-3">
                <span className="truncate text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: key })}
                </span>
                <span className="font-mono text-ui-xl font-medium tabular-nums text-foreground">
                  {formatRowCount(value)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <span className="shrink-0 text-ui-xs font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "dbboard.knowledge.summaryFrequent" })}
              <span className="ml-1.5 font-normal">
                {intl.formatMessage({ id: "dbboard.knowledge.summaryFrequentHint" })}
              </span>
            </span>
            {summary.frequentTables.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.knowledge.summaryFrequentEmpty" })}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
                {summary.frequentTables.map((table, index) => (
                  <div
                    key={table.table}
                    className="flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-surface-hover"
                  >
                    <span className="w-6 shrink-0 text-right font-mono text-ui-xs text-foreground-subtle">
                      {index + 1}
                    </span>
                    <span className="min-w-0 shrink-0 font-mono text-ui-sm text-foreground">
                      {table.table}
                    </span>
                    <Badge variant="outline" className="shrink-0">
                      {table.domain}
                    </Badge>
                    <span className="min-w-0 truncate text-ui-sm text-foreground-subtle" title={table.purpose}>
                      {table.purpose}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-ui-sm tabular-nums text-foreground">
                      {formatRowCount(table.rowCount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-ui-sm text-foreground-subtle">
          <Spinner className="size-4" />
          {intl.formatMessage({ id: "dbboard.knowledge.summaryComputing" })}
        </div>
      )}
    </section>
  );
}
