/**
 * 知识库构建区：开始/取消/刷新 + 阶段进度 + 构建摘要 + 删除。
 * compact：收起配置时只保留操作按钮；embedded：展开配置时去掉外层卡片。
 */
import { Play, RefreshCw, Square, Trash2 } from "lucide-react";
import type { DbBoardKnowledge, DbBoardKnowledgeBuildProgress } from "@zcode/services";
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
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/dbBoard/dbBoardViews.js";

function BuildStageLabel({ stage }: { stage: string }) {
  const { intl } = useZCodeIntl();
  const keyMap: Record<string, string> = {
    probe: "dbboard.knowledge.stage.probe",
    scan: "dbboard.knowledge.stage.scan",
    "db-comments": "dbboard.knowledge.stage.dbComments",
    nacos: "dbboard.knowledge.stage.nacos",
    distill: "dbboard.knowledge.stage.distill",
    persist: "dbboard.knowledge.stage.persist",
    done: "dbboard.knowledge.stage.done",
  };
  return <>{intl.formatMessage({ id: keyMap[stage] ?? "dbboard.knowledge.stage.scan" })}</>;
}

function BuildActions({
  hasProfile,
  building,
  knowledge,
  onStart,
  onCancel,
  onRefresh,
  onDelete,
}: {
  hasProfile: boolean;
  building: boolean;
  knowledge: DbBoardKnowledge | null;
  onStart: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  onDelete: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-center gap-1.5">
      {building ? (
        <Button variant="outline" size="sm" onClick={onCancel}>
          <Square />
          {intl.formatMessage({ id: "dbboard.knowledge.cancel" })}
        </Button>
      ) : (
        <Button size="sm" onClick={onStart} disabled={!hasProfile}>
          <Play />
          {intl.formatMessage({
            id: knowledge ? "dbboard.knowledge.rebuild" : "dbboard.knowledge.build",
          })}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onRefresh}>
        <RefreshCw />
        {intl.formatMessage({ id: "dbboard.logs.refresh" })}
      </Button>
      {knowledge ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm">
              <Trash2 />
              {intl.formatMessage({ id: "dbboard.knowledge.delete" })}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: "dbboard.knowledge.deleteTitle" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({ id: "dbboard.knowledge.deleteDescription" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete}>
                {intl.formatMessage({ id: "common.delete" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

export function DbBoardKnowledgeBuildSection({
  hasProfile,
  buildState,
  knowledge,
  onStart,
  onCancel,
  onRefresh,
  onDelete,
  embedded = false,
  compact = false,
}: {
  hasProfile: boolean;
  buildState: DbBoardKnowledgeBuildProgress | null;
  knowledge: DbBoardKnowledge | null;
  onStart: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  onDelete: () => void;
  embedded?: boolean;
  compact?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const building = buildState?.status === "running";
  const failureText =
    buildState?.error || (buildState?.status === "failed" ? buildState.detail : undefined);

  const actions = (
    <BuildActions
      hasProfile={hasProfile}
      building={building}
      knowledge={knowledge}
      onStart={onStart}
      onCancel={onCancel}
      onRefresh={onRefresh}
      onDelete={onDelete}
    />
  );

  if (compact) {
    return <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>;
  }

  return (
    <section className={embedded ? "flex flex-col gap-2" : "flex flex-col gap-2 rounded-xl border border-card-border bg-card p-4"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "dbboard.knowledge.buildTitle" })}
        </span>
        {actions}
      </div>
      {buildState && buildState.status !== "idle" ? (
        <div className="flex flex-col gap-1 rounded-lg bg-surface p-3 text-ui-sm">
          <div className="flex items-center gap-2">
            {building ? <Spinner className="size-3.5" /> : null}
            <span className="font-medium text-foreground">
              <BuildStageLabel stage={buildState.stage} />
            </span>
            <span
              className={
                buildState.status === "failed"
                  ? "text-ui-xs text-destructive"
                  : "text-ui-xs text-foreground-subtle"
              }
            >
              {buildState.status === "completed"
                ? intl.formatMessage({ id: "dbboard.knowledge.statusCompleted" })
                : buildState.status === "cancelled"
                  ? intl.formatMessage({ id: "dbboard.knowledge.statusCancelled" })
                  : buildState.status === "failed"
                    ? intl.formatMessage({ id: "dbboard.knowledge.statusFailed" })
                    : ""}
            </span>
          </div>
          {failureText ? (
            <p className="break-all text-ui-xs text-destructive">{failureText}</p>
          ) : (
            <p className="text-foreground-subtle">{buildState.detail}</p>
          )}
          {buildState.total > 0 ? (
            <progress className="h-1.5 w-full" value={buildState.done} max={buildState.total} />
          ) : null}
        </div>
      ) : null}
      {knowledge ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "dbboard.knowledge.summary" },
            {
              tables: knowledge.stats.tableCount,
              domains: knowledge.stats.domainCount,
              distilled: knowledge.stats.distilled,
            },
          )}
          <span> · {formatDateTime(knowledge.builtAt)}</span>
        </p>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "dbboard.knowledge.empty" })}
        </p>
      )}
    </section>
  );
}
