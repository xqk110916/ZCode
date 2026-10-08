/**
 * Paperclip 面板顶部连接状态条：连接状态徽章 + server 地址 + 停止服务/刷新/创建任务。
 * 停止服务为破坏性操作：红色描边（outline destructive）提示危险，点击直接执行。
 * 从 PaperclipPage 拆出（保持主文件行数在 lint 上限内）。
 */
import { CircleCheck, Loader2, Plus, RefreshCw, Square } from "lucide-react";
import type { PaperclipConnectionState } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

export function PaperclipConnectionBar({
  connectionState,
  serverUrl,
  refreshing,
  stoppingLocalServer,
  onStopLocalServer,
  onRefresh,
  onCreateTask,
}: {
  connectionState: PaperclipConnectionState;
  serverUrl: string;
  refreshing: boolean;
  stoppingLocalServer: boolean;
  onStopLocalServer: () => void;
  onRefresh: () => void;
  onCreateTask: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            "gap-1",
            connectionState === "connected" && "border-success/40 bg-success-subtle text-success",
            connectionState === "polling" && "border-warning/40 bg-warning-subtle text-warning",
            connectionState === "connecting" && "border-info/40 bg-info-subtle text-info",
          )}
        >
          {connectionState === "connected" ? (
            <CircleCheck className="size-3" />
          ) : (
            <Loader2 className="size-3 animate-spin" />
          )}
          {intl.formatMessage({
            id:
              connectionState === "connected"
                ? "paperclip.state.connected"
                : connectionState === "polling"
                  ? "paperclip.state.polling"
                  : "paperclip.state.connecting",
          })}
        </Badge>
        <span className="truncate text-ui-base text-foreground-subtle">{serverUrl}</span>
      </div>
      <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/60 text-destructive text-ui-sm hover:bg-destructive/10 hover:text-destructive"
          disabled={stoppingLocalServer}
          onClick={onStopLocalServer}
        >
          {stoppingLocalServer ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Square className="size-4" />
          )}
          {intl.formatMessage({
            id: stoppingLocalServer
              ? "paperclip.localServer.stopping"
              : "paperclip.localServer.stop",
          })}
        </Button>
        <Button variant="outline" size="sm" className="text-ui-sm" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          {intl.formatMessage({ id: "paperclip.refresh" })}
        </Button>
        <Button size="sm" className="text-ui-sm" onClick={onCreateTask}>
          <Plus className="size-4" />
          {intl.formatMessage({ id: "paperclip.createTask" })}
        </Button>
      </div>
    </div>
  );
}
