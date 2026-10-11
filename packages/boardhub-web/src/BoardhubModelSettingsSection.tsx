/**
 * BoardHub 模型设置分区：OpenAI 兼容端点（base URL / 模型 id / API key）。
 * URL 与模型 id 存 AppSettings（boardhubModelBaseUrl/Id），API key 存 ICredentialService
 * （key 见 packages/boardhub-server/src/boardhubModel.ts），供看板生成与知识蒸馏使用。
 */
import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Spinner } from "@/components/ui/spinner.js";

/** 与 boardhub-server 的 BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY 保持一致。 */
const BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY = "boardhub-model-api-key";

export function BoardhubModelSettingsSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const { settings, update } = useSettings();
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    if (settings === null) return;
    setBaseUrl(settings.boardhubModelBaseUrl ?? "");
    setModelId(settings.boardhubModelId ?? "");
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    void services.credentialService
      .load(BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY)
      .then((value) => {
        if (!disposed) {
          setApiKey(value ?? "");
          setApiKeyLoaded(true);
        }
      })
      .catch(() => {
        if (!disposed) setApiKeyLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [services.credentialService]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await update({
        // 空串表示清除（validation 层会把坏值/空值归一为 undefined）。
        boardhubModelBaseUrl: baseUrl.trim(),
        boardhubModelId: modelId.trim(),
      });
      const nextKey = apiKey.trim();
      if (nextKey) {
        await services.credentialService.save(BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY, nextKey);
      } else {
        await services.credentialService.delete(BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY);
      }
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, modelId, services.credentialService, update]);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-foreground-subtle" />
        <h2 className="text-ui-sm font-medium">
          {intl.formatMessage({ id: "boardhub.model.title" })}
        </h2>
      </div>
      <p className="text-ui-xs/relaxed text-foreground-subtle">
        {intl.formatMessage({ id: "boardhub.model.description" })}
      </p>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="boardhub-model-base-url">
            {intl.formatMessage({ id: "boardhub.model.baseUrl" })}
          </Label>
          <Input
            id="boardhub-model-base-url"
            placeholder="https://open.bigmodel.cn/api/paas/v4"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="boardhub-model-id">
            {intl.formatMessage({ id: "boardhub.model.modelId" })}
          </Label>
          <Input
            id="boardhub-model-id"
            placeholder="glm-4.7"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="boardhub-model-api-key">
            {intl.formatMessage({ id: "boardhub.model.apiKey" })}
          </Label>
          <Input
            id="boardhub-model-api-key"
            type="password"
            placeholder={apiKeyLoaded ? "" : "…"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? <Spinner className="size-3.5" /> : null}
          {intl.formatMessage({ id: "boardhub.model.save" })}
        </Button>
        {savedAt > 0 && !saving ? (
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "boardhub.model.saved" })}
          </span>
        ) : null}
      </div>
    </section>
  );
}
