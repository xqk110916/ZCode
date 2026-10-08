/**
 * Paperclip 面板断连引导视图：未连接时的占位（最近错误 + 启动本地服务/重试/去设置）。
 * 从 PaperclipPage 拆出（保持主文件行数在 lint 上限内）。
 */
import { CircleDashed, Loader2, Play, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PaperclipDisconnectedState({
  lastError,
  startingLocalServer,
  onStartLocalServer,
  onRetry,
  onOpenSettings,
}: {
  lastError?: string;
  startingLocalServer: boolean;
  onStartLocalServer: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <CircleDashed className="size-8 text-foreground-subtlest" />
      <div className="flex flex-col gap-1">
        <p className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "paperclip.notConnected.title" })}
        </p>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "paperclip.notConnected.description" })}
        </p>
        {lastError ? <p className="text-ui-base text-danger">{lastError}</p> : null}
      </div>
      <div className="flex gap-2">
        <Button disabled={startingLocalServer} onClick={onStartLocalServer}>
          {startingLocalServer ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {intl.formatMessage({
            id: startingLocalServer
              ? "paperclip.localServer.starting"
              : "paperclip.localServer.start",
          })}
        </Button>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {intl.formatMessage({ id: "paperclip.retry" })}
        </Button>
        <Button variant="outline" onClick={onOpenSettings}>
          <Settings2 className="size-4" />
          {intl.formatMessage({ id: "paperclip.openSettings" })}
        </Button>
      </div>
    </div>
  );
}
