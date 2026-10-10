/**
 * 探索看板 tab：左侧我的看板列表 + 右侧问答/修订/图表网格。
 * 输入是问题句（不是图表类型）——推荐问法占位提示对齐需求文档 7.2。
 */
import { useMemo, useState } from "react";
import { Plus, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Input } from "@/components/ui/input.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardChartCard } from "@/dbBoard/DbBoardChartCard.js";
import { formatDateTime } from "@/dbBoard/dbBoardViews.js";
import type { UseDbBoardDashboardsState } from "@/dbBoard/useDbBoardDashboards.js";

export function DbBoardKnowledgeBadge({ active }: { active: boolean }) {
  const { intl } = useZCodeIntl();
  if (!active) {
    return null;
  }
  return (
    <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
      {intl.formatMessage({ id: "dbboard.knowledge.injectedBadge" })}
    </span>
  );
}

export function DbBoardExplorerTab({
  state,
  knowledgeReady = false,
}: {
  state: UseDbBoardDashboardsState;
  knowledgeReady?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [question, setQuestion] = useState("");
  const [revisionNote, setRevisionNote] = useState("");

  const questionPlaceholder = useMemo(
    () =>
      intl.formatMessage({
        id: "dbboard.explorer.questionPlaceholder",
      }),
    [intl],
  );

  const handleGenerate = () => {
    const trimmed = question.trim();
    if (!trimmed || state.generating) return;
    void state.generate(trimmed);
  };

  const handleRevise = () => {
    const trimmed = revisionNote.trim();
    if (!trimmed || state.generating || !state.currentSpec) return;
    setRevisionNote("");
    void state.revise(trimmed);
  };

  return (
    <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-2">
        <Button variant="outline" size="sm" onClick={state.newDashboard}>
          <Plus />
          {intl.formatMessage({ id: "dbboard.explorer.newDashboard" })}
        </Button>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-xl border border-card-border bg-card p-1.5">
          {state.dashboards.length === 0 ? (
            <p className="px-2 py-3 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "dbboard.explorer.noDashboards" })}
            </p>
          ) : (
            state.dashboards.map((dashboard) => (
              <div
                key={dashboard.id}
                className={cn(
                  "group flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-surface-hover",
                  state.currentSpec?.id === dashboard.id && "bg-selected",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => void state.openDashboard(dashboard.id)}
                >
                  <span
                    className={
                      state.currentSpec?.id === dashboard.id
                        ? "block truncate text-ui-sm font-medium text-foreground"
                        : "block truncate text-ui-sm text-foreground-subtle"
                    }
                  >
                    {dashboard.title}
                  </span>
                  <span className="block truncate text-ui-xs text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "dbboard.explorer.dashboardMeta" },
                      { charts: dashboard.chartCount, time: formatDateTime(dashboard.updatedAt) },
                    )}
                  </span>
                </button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="opacity-0 group-hover:opacity-100">
                      <Trash2 />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {intl.formatMessage({ id: "dbboard.explorer.deleteTitle" })}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {intl.formatMessage({ id: "dbboard.explorer.deleteDescription" })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {intl.formatMessage({ id: "common.cancel" })}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => void state.deleteDashboard(dashboard.id)}
                      >
                        {intl.formatMessage({ id: "common.delete" })}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        {!state.currentSpec ? (
          <div className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4">
            <div className="flex items-center gap-2">
              <label className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "dbboard.explorer.askAQuestion" })}
              </label>
              <DbBoardKnowledgeBadge active={knowledgeReady} />
            </div>
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={questionPlaceholder}
              rows={3}
              className="text-ui-base"
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  handleGenerate();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "dbboard.explorer.questionHint" })}
              </span>
              <Button onClick={handleGenerate} disabled={!question.trim() || state.generating}>
                {state.generating ? <Spinner className="size-4" /> : <Sparkles />}
                {intl.formatMessage({
                  id: state.generating ? "dbboard.explorer.generating" : "dbboard.explorer.generate",
                })}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-card-border bg-card p-4">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ui-base font-semibold text-foreground">
                  {state.currentSpec.title}
                </span>
                <span className="truncate text-ui-xs text-foreground-subtle">
                  {state.currentSpec.question}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {state.modelInfo ? (
                  <span className="font-mono text-ui-xs text-foreground-subtle">
                    {state.modelInfo.providerId}/{state.modelInfo.modelId}
                  </span>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void state.refreshAllCharts()}
                  disabled={state.generating}
                >
                  <RefreshCw />
                  {intl.formatMessage({ id: "dbboard.explorer.refreshAll" })}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void state.saveCurrent()}>
                  <Save />
                  {state.saved
                    ? intl.formatMessage({ id: "dbboard.explorer.saved" })
                    : intl.formatMessage({ id: "dbboard.explorer.save" })}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Input
                value={revisionNote}
                onChange={(event) => setRevisionNote(event.target.value)}
                placeholder={intl.formatMessage({ id: "dbboard.explorer.revisionPlaceholder" })}
                className="text-ui-base"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    handleRevise();
                  }
                }}
              />
              <Button
                variant="outline"
                onClick={handleRevise}
                disabled={!revisionNote.trim() || state.generating}
              >
                {state.generating ? <Spinner className="size-4" /> : null}
                {intl.formatMessage({ id: "dbboard.explorer.revise" })}
              </Button>
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              {state.currentSpec.charts.map((chart) => (
                <DbBoardChartCard
                  key={chart.id}
                  chart={chart}
                  run={state.chartRuns[chart.id]}
                  explanation={state.explanation?.chartId === chart.id ? state.explanation.text : null}
                  explaining={state.explaining}
                  onRefresh={() => void state.refreshChart(chart.id)}
                  onExplain={() => void state.explainChart(chart.id)}
                />
              ))}
            </div>
          </>
        )}

        {state.generateError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-sm text-destructive">
            {state.generateError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
