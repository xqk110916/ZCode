/**
 * Paperclip「添加本地 agent」弹窗：检测本机 CLI 并注册为对应 local adapter 的 agent。
 * 复用各 CLI 已有登录态（无需在 Paperclip 配 key）；检测只是提示，不阻断创建。
 */
import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { PaperclipLocalAdapterCandidate } from "@zcode/shared";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { PaperclipAdapterBrandIcon } from "@/paperclip/paperclipViews.js";

export function PaperclipAddAgentDialog({
  open,
  onOpenChange,
  detectLocalAgentAdapters,
  existingAdapterTypes,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detectLocalAgentAdapters: () => Promise<PaperclipLocalAdapterCandidate[]>;
  /** 团队中已注册的 adapterType 集合：每个 CLI 只允许添加一次，已存在的禁选。 */
  existingAdapterTypes: ReadonlySet<string>;
  onCreate: (input: { name: string; adapterType: string; role?: string }) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [candidates, setCandidates] = useState<PaperclipLocalAdapterCandidate[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setSelected("");
    setName("");
    setError(null);
    let disposed = false;
    detectLocalAgentAdapters()
      .then((list) => {
        if (disposed) return;
        setCandidates(list);
        // 默认选中第一个"未添加且可用"的 CLI；已添加的被禁选。
        const firstAvailable = list.find(
          (candidate) => candidate.available && !existingAdapterTypes.has(candidate.adapterType),
        );
        if (firstAvailable) {
          setSelected(firstAvailable.adapterType);
          applyDefaultName(firstAvailable.cliName);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [open, detectLocalAgentAdapters, existingAdapterTypes]);

  function applyDefaultName(cliName: string) {
    setName(cliName.charAt(0).toUpperCase() + cliName.slice(1));
  }

  async function submit() {
    if (!selected || !name.trim() || creating) return;
    setCreating(true);
    setError(null);
    const ok = await onCreate({ name: name.trim(), adapterType: selected });
    setCreating(false);
    if (ok) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "paperclip.addAgent.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "paperclip.addAgent.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5">
          <div className="flex flex-col gap-1">
            <Label>{intl.formatMessage({ id: "paperclip.addAgent.adapter" })}</Label>
            {candidates === null ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <Loader2 className="size-4 animate-spin" />
                {intl.formatMessage({ id: "paperclip.addAgent.detecting" })}
              </div>
            ) : (
              <div
                role="radiogroup"
                aria-label={intl.formatMessage({ id: "paperclip.addAgent.adapter" })}
                className="flex flex-col gap-1"
              >
                {candidates.map((candidate) => {
                  const isSelected = selected === candidate.adapterType;
                  const alreadyAdded = existingAdapterTypes.has(candidate.adapterType);
                  return (
                    <button
                      key={candidate.adapterType}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      aria-disabled={alreadyAdded}
                      disabled={alreadyAdded}
                      onClick={() => {
                        if (alreadyAdded) return;
                        setSelected(candidate.adapterType);
                        applyDefaultName(candidate.cliName);
                      }}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-ui-base transition-colors",
                        alreadyAdded
                          ? "cursor-not-allowed border-border-subtle opacity-60"
                          : isSelected
                            ? "border-border-focused bg-selected text-foreground"
                            : "border-border-subtle text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                      )}
                    >
                      <PaperclipAdapterBrandIcon
                        adapterType={candidate.adapterType}
                        className="size-4 shrink-0 object-contain"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">{candidate.cliName}</span>
                      {alreadyAdded ? (
                        <span
                          className="shrink-0 text-ui-sm text-foreground-subtlest"
                          title={intl.formatMessage({ id: "paperclip.addAgent.alreadyAddedHint" })}
                        >
                          {intl.formatMessage({ id: "paperclip.addAgent.alreadyAdded" })}
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "shrink-0 text-ui-sm",
                            candidate.available
                              ? "text-success"
                              : "text-foreground-subtlest",
                          )}
                        >
                          {intl.formatMessage({
                            id: candidate.available
                              ? "paperclip.addAgent.detected"
                              : "paperclip.addAgent.notDetected",
                          })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="paperclip-add-agent-name">
              {intl.formatMessage({ id: "paperclip.addAgent.name" })}
            </Label>
            <Input
              id="paperclip-add-agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={intl.formatMessage({ id: "paperclip.addAgent.namePlaceholder" })}
            />
          </div>
          {error ? <p className="text-ui-base text-danger">{error}</p> : null}
        </div>
        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button disabled={!selected || !name.trim() || creating} onClick={() => void submit()}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {intl.formatMessage({ id: "paperclip.addAgent.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
