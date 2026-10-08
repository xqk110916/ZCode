/**
 * Paperclip 设置分区：server 地址 + 可选 Bearer token + 本地服务启停。
 * URL 存 AppSettings（经 useSettings 走 settingService）；token 存 ICredentialService
 * （加密 credentials.json，key 见 PAPERCLIP_TOKEN_CREDENTIAL_KEY），不进 settings。
 * 保存后下一次面板调用即用新配置重建连接（服务侧懒解析，无需热切换）。
 */
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleDashed, Loader2, Play, Square } from "lucide-react";
import {
  DEFAULT_PAPERCLIP_SERVER_URL,
  type PaperclipLocalServerStatus,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { cn } from "@/components/lib/utils.js";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; version?: string }
  | { kind: "failed"; error: string };

export function PaperclipSettingsSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const { settings, update } = useSettings();
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });
  const [localServer, setLocalServer] = useState<PaperclipLocalServerStatus | null>(null);
  const [localServerBusy, setLocalServerBusy] = useState(false);

  useEffect(() => {
    if (settings === null) return;
    setServerUrl(settings.paperclipServerUrl ?? "");
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    void services.credentialService
      .load("paperclip-api-token")
      .then((value) => {
        if (!disposed) {
          setToken(value ?? "");
          setTokenLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) setTokenLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [services.credentialService]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setTestState({ kind: "idle" });
    try {
      await update({
        // 空串表示清除覆盖、回落 env/默认值。
        paperclipServerUrl: serverUrl.trim(),
      });
      const nextToken = token.trim();
      if (nextToken) {
        await services.credentialService.save("paperclip-api-token", nextToken);
      } else {
        await services.credentialService.delete("paperclip-api-token");
      }
    } finally {
      setSaving(false);
    }
  }, [serverUrl, token, update, services.credentialService]);

  const handleTest = useCallback(async () => {
    const paperclipService = services.paperclipService;
    if (!paperclipService) return;
    setTestState({ kind: "testing" });
    const result = await paperclipService.testConnection(
      serverUrl.trim() || DEFAULT_PAPERCLIP_SERVER_URL,
      token.trim() || undefined,
    );
    setTestState(
      result.ok
        ? { kind: "ok", version: result.serverInfo?.version }
        : { kind: "failed", error: result.error ?? "unknown error" },
    );
  }, [serverUrl, token, services.paperclipService]);

  const refreshLocalServer = useCallback(async () => {
    const paperclipService = services.paperclipService;
    if (!paperclipService) return;
    try {
      setLocalServer(await paperclipService.getLocalServerStatus());
    } catch {
      setLocalServer(null);
    }
  }, [services.paperclipService]);

  useEffect(() => {
    void refreshLocalServer();
  }, [refreshLocalServer]);

  const handleLocalServerAction = useCallback(
    async (action: "start" | "stop") => {
      const paperclipService = services.paperclipService;
      if (!paperclipService) return;
      setLocalServerBusy(true);
      try {
        const status =
          action === "start"
            ? await paperclipService.startLocalServer()
            : await paperclipService.stopLocalServer();
        setLocalServer(status);
      } finally {
        setLocalServerBusy(false);
      }
    },
    [services.paperclipService],
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.paperclip.description" })}
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="paperclip-server-url">
          {intl.formatMessage({ id: "settings.paperclip.serverUrl" })}
        </Label>
        <Input
          id="paperclip-server-url"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder={DEFAULT_PAPERCLIP_SERVER_URL}
          spellCheck={false}
        />
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.paperclip.serverUrlHint" })}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="paperclip-token">
          {intl.formatMessage({ id: "settings.paperclip.token" })}
        </Label>
        <Input
          id="paperclip-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={intl.formatMessage({ id: "settings.paperclip.tokenPlaceholder" })}
          spellCheck={false}
          autoComplete="off"
        />
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.paperclip.tokenHint" })}
        </p>
      </div>
      {testState.kind !== "idle" ? (
        <div
          className={cn(
            "flex items-center gap-2 text-ui-base",
            testState.kind === "ok"
              ? "text-success"
              : testState.kind === "failed"
                ? "text-danger"
                : "text-foreground-subtle",
          )}
        >
          {testState.kind === "testing" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : testState.kind === "ok" ? (
            <CircleCheck className="size-4" />
          ) : (
            <CircleDashed className="size-4" />
          )}
          {testState.kind === "ok"
            ? intl.formatMessage(
                { id: "settings.paperclip.testOk" },
                { version: testState.version ?? "-" },
              )
            : testState.kind === "failed"
              ? intl.formatMessage({ id: "settings.paperclip.testFailed" }, { error: testState.error })
              : intl.formatMessage({ id: "settings.paperclip.testing" })}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 rounded-xl border border-card-border bg-card p-4">
        <Label>{intl.formatMessage({ id: "settings.paperclip.localServer.title" })}</Label>
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const state = localServerBusy
              ? "busy"
              : localServer === null
                ? "unknown"
                : localServer.state;
            if (state === "busy" || state === "starting" || state === "stopping") {
              return (
                <span className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                  <Loader2 className="size-4 animate-spin" />
                  {intl.formatMessage({ id: "settings.paperclip.localServer.busy" })}
                </span>
              );
            }
            if (state === "running") {
              return (
                <span className="flex items-center gap-2 text-ui-base text-success">
                  <CircleCheck className="size-4" />
                  {intl.formatMessage({ id: "settings.paperclip.localServer.running" })}
                </span>
              );
            }
            return (
              <span className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <CircleDashed className="size-4" />
                {intl.formatMessage({ id: "settings.paperclip.localServer.stopped" })}
              </span>
            );
          })()}
          <span className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={localServerBusy || localServer?.state === "running"}
              onClick={() => void handleLocalServerAction("start")}
            >
              <Play className="size-4" />
              {intl.formatMessage({ id: "settings.paperclip.localServer.start" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={localServerBusy || localServer?.state !== "running"}
              onClick={() => void handleLocalServerAction("stop")}
            >
              <Square className="size-4" />
              {intl.formatMessage({ id: "settings.paperclip.localServer.stop" })}
            </Button>
          </span>
        </div>
        {localServer?.state === "error" && localServer.detail ? (
          <p className="text-ui-sm text-danger">{localServer.detail}</p>
        ) : (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.paperclip.localServer.hint" })}
          </p>
        )}
      </div>
      {/* 自动认领：新任务出现即认领并后台建任务；开关即时生效（无需保存按钮）。 */}
      <div className="flex flex-col gap-1">
        <label className="flex cursor-pointer items-center justify-between gap-3">
          <span className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "settings.paperclip.autoClaim" })}
          </span>
          <Switch
            checked={settings?.paperclipAutoClaim === true}
            onCheckedChange={(checked) => {
              void update({ paperclipAutoClaim: checked });
            }}
          />
        </label>
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.paperclip.autoClaimHint" })}
        </p>
      </div>
      <SettingsFormActions>
        <Button
          variant="outline"
          disabled={testState.kind === "testing" || !tokenLoaded}
          onClick={() => void handleTest()}
        >
          {testState.kind === "testing" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {intl.formatMessage({ id: "settings.paperclip.test" })}
        </Button>
        <Button disabled={saving || !tokenLoaded} onClick={() => void handleSave()}>
          {intl.formatMessage({ id: "common.save" })}
        </Button>
      </SettingsFormActions>
    </div>
  );
}
