/**
 * Paperclip agent 配置弹窗：名称、模型与推理力度。
 * 模型列表双来源：Paperclip adapter 静态清单 + 本机 Claude Code 第三方网关发现
 * （discoverClaudeModels；命中时置前分组展示，贴合"实际可用的模型"）；另留手动
 * 输入兜底（/v1/models 不可用或想用别名时）。保存走 updateAgent（PATCH merge），
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
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { agentDisplayName } from "@/paperclip/paperclipViews.js";

/** Radix Select 不允许空字符串 value；「默认模型」哨兵（映射回清除显式模型）。 */
const MODEL_DEFAULT_SENTINEL = "__paperclip_model_default__";
/** effort「保持不变」哨兵（映射回 null，PATCH 不携带该字段）。 */
const EFFORT_UNCHANGED_SENTINEL = "__paperclip_effort_unchanged__";

export function PaperclipAgentConfigDialog({
  agent,
  open,
  onOpenChange,
  loadAdapterModels,
  discoverClaudeModels,
  onSave,
}: {
  agent: PaperclipAgent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loadAdapterModels: (adapterType: string) => Promise<PaperclipAdapterModel[]>;
  discoverClaudeModels: () => Promise<PaperclipAdapterModel[]>;
  onSave: (
    agentId: string,
    patch: { name?: string; model?: string; effort?: PaperclipEffort },
  ) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [models, setModels] = useState<PaperclipAdapterModel[] | null>(null);
  const [discovered, setDiscovered] = useState<PaperclipAdapterModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [effort, setEffort] = useState<PaperclipEffort | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isClaudeAdapter = (agent?.adapterType ?? "").replace(/_local$/, "") === "claude";

  useEffect(() => {
    if (!open || !agent) return;
    setName(agent.name || "");
    setModel(agent.model ?? "");
    setCustomModel("");
    setEffort(null);
    setModels(null);
    setDiscovered([]);
    setModelsError(null);
    setSaveError(null);
    let disposed = false;
    const adapterType = agent.adapterType || "claude_local";
    loadAdapterModels(adapterType)
      .then((list) => {
        if (!disposed) setModels(list);
      })
      .catch((error: unknown) => {
        if (!disposed) setModelsError(error instanceof Error ? error.message : String(error));
      });
    // 仅 claude 系 adapter 做第三方发现（读的是 Claude Code 的网关配置）。
    if (isClaudeAdapter) {
      discoverClaudeModels().then((list) => {
        if (!disposed && list.length > 0) setDiscovered(list);
      });
    }
    return () => {
      disposed = true;
    };
  }, [open, agent, loadAdapterModels, discoverClaudeModels, isClaudeAdapter]);

  if (!agent) return null;

  async function submit() {
    if (saving || !agent) return;
    setSaving(true);
    setSaveError(null);
    // 手动输入的模型 ID 优先于下拉选择（网关别名等场景）。
    const effectiveModel = customModel.trim() !== "" ? customModel.trim() : model;
    const ok = await onSave(agent.id, {
      ...(name.trim() === "" || name.trim() === agent.name ? {} : { name: name.trim() }),
      // 空串表示清除显式模型，回落 adapter 默认。
      ...(effectiveModel === "" ? {} : { model: effectiveModel }),
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
            <Label htmlFor="paperclip-agent-name">
              {intl.formatMessage({ id: "paperclip.agentConfig.name" })}
            </Label>
            <Input
              id="paperclip-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={agentDisplayName(agent)}
            />
          </div>
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
              <Select
                value={model === "" ? MODEL_DEFAULT_SENTINEL : model}
                onValueChange={(value) => setModel(value === MODEL_DEFAULT_SENTINEL ? "" : value)}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={intl.formatMessage({ id: "paperclip.agentConfig.modelDefault" })}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODEL_DEFAULT_SENTINEL}>
                    {intl.formatMessage({ id: "paperclip.agentConfig.modelDefault" })}
                  </SelectItem>
                  {discovered.length > 0 ? (
                    <SelectGroup>
                      <SelectLabel>
                        {intl.formatMessage({ id: "paperclip.agentConfig.modelsDiscovered" })}
                      </SelectLabel>
                      {discovered.map((entry) => (
                        <SelectItem key={`d:${entry.id}`} value={entry.id}>
                          {entry.label ?? entry.id}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ) : null}
                  <SelectGroup>
                    {discovered.length > 0 ? (
                      <SelectLabel>
                        {intl.formatMessage({ id: "paperclip.agentConfig.modelsBuiltin" })}
                      </SelectLabel>
                    ) : null}
                    {(models ?? []).map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.label ?? entry.id}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            <Input
              value={customModel}
              onChange={(event) => setCustomModel(event.target.value)}
              placeholder={intl.formatMessage({ id: "paperclip.agentConfig.modelCustomPlaceholder" })}
              spellCheck={false}
              className="font-mono"
            />
            {discovered.length > 0 ? (
              <p className="text-ui-sm text-foreground-subtlest">
                {intl.formatMessage({ id: "paperclip.agentConfig.discoveredHint" })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label>{intl.formatMessage({ id: "paperclip.agentConfig.effort" })}</Label>
            <Select
              value={effort ?? EFFORT_UNCHANGED_SENTINEL}
              onValueChange={(value) =>
                setEffort(
                  (value === EFFORT_UNCHANGED_SENTINEL ? null : value) as PaperclipEffort | null,
                )
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={intl.formatMessage({ id: "paperclip.agentConfig.effortUnchanged" })}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EFFORT_UNCHANGED_SENTINEL}>
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
