/**
 * Paperclip 设置分区：server 地址 + 可选 Bearer token。
 * URL 存 AppSettings（经 useSettings 走 settingService）；token 存 ICredentialService
 * （加密 credentials.json，key 见 PAPERCLIP_TOKEN_CREDENTIAL_KEY），不进 settings。
 * 保存后下一次面板调用即用新配置重建连接（服务侧懒解析，无需热切换）。
 */
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleDashed, Loader2 } from "lucide-react";
import { DEFAULT_PAPERCLIP_SERVER_URL } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
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
