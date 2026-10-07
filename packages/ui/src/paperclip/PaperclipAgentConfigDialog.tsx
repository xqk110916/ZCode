/**
 * Paperclip agent 配置弹窗：切换模型与推理力度。
 * 模型列表按该 agent 的 adapterType 懒加载；保存走 updateAgent（PATCH merge），
 * 失败（如 effort 不被该模型支持返回 422）在弹窗内如实展示。
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  PAPERCLIP_EFFORTS,
  type PaperclipAdapterModel,
  type PaperclipAgent,
  type PaperclipEffort,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { agentDisplayName } from "@/paperclip/paperclipViews.js";

export function PaperclipAgentConfigDialog({
  agent,
  open,
  onOpenChange,
  loadAdapterModels,
  onSave,
}: {
  agent: PaperclipAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadAdapterModels: (adapterType: string) => Promise<PaperclipAdapterModel[]>;
  onSave: (agentId: string, patch: { model?: string; effort?: PaperclipEffort }) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [models, setModels] = useState<PaperclipAdapterModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<PaperclipEffort | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !agent) return;
    setModel(agent.model ?? "");
    setEffort(null);
    setModels(null);
    setModelsError(null);
    setSaveError(null);
    let disposed = false;
    loadAdapterModels(agent.adapterType || "claude_local")
      .then((list) => {
        if (!disposed) setModels(list);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setModelsError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      disposed = true;
    };
  }, [open, agent, loadAdapterModels]);

  if (!agent) return null;

  async function submit() {
    if (saving || !agent) return;
    setSaving(true);
    setSaveError(null);
    const ok = await onSave(agent.id, {
      // 空串表示清除显式模型，回落 adapter 默认。
      ...(model === "" ? {} : { model }),
      ...(effort === null ? {} : { effort }),
    });
    setSaving(false);
    if (ok) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "paperclip.agentConfig.title" }, { name: agentDisplayName(agent) })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "paperclip.agentConfig.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5">
          <div className="flex flex-col gap-1">
            <Label>{intl.formatMessage({ id: "paperclip.agentConfig.model" })}</Label>
            {models === null && modelsError === null ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <Loader2 className="size-4 animate-spin" />
                {intl.formatMessage({ id: "paperclip.agentConfig.loadingModels" })}
              </div>
            ) : modelsError !== null ? (
              <p className="text-ui-base text-danger">{modelsError}</p>
            ) : (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={intl.formatMessage({ id: "paperclip.agentConfig.modelDefault" })}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    {intl.formatMessage({ id: "paperclip.agentConfig.modelDefault" })}
                  </SelectItem>
                  {(models ?? []).map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label ?? entry.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label>{intl.formatMessage({ id: "paperclip.agentConfig.effort" })}</Label>
            <Select
              value={effort ?? ""}
              onValueChange={(value) =>
                setEffort((value === "" ? null : value) as PaperclipEffort | null)
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={intl.formatMessage({ id: "paperclip.agentConfig.effortUnchanged" })}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">
                  {intl.formatMessage({ id: "paperclip.agentConfig.effortUnchanged" })}
                </SelectItem>
                {PAPERCLIP_EFFORTS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "paperclip.agentConfig.effortHint" })}
            </p>
          </div>
          {saveError ? <p className="text-ui-base text-danger">{saveError}</p> : null}
        </div>
        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button disabled={saving || modelsError !== null} onClick={() => void submit()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
