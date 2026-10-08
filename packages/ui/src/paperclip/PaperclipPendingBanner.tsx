/**
 * 待 ZCode 执行横幅（从 PaperclipPage 拆出）：自主执行模式下这些任务在等你出手，
 * 置于注意力最前；带自动认领开关与「执行下一个」快捷动作。
 */
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function PaperclipPendingBanner({
  count,
  autoClaim,
  onAutoClaimChange,
  onViewPending,
  onExecuteNext,
}: {
  count: number;
  autoClaim: boolean;
  onAutoClaimChange: (checked: boolean) => void;
  onViewPending: () => void;
  onExecuteNext: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-info/40 bg-info-subtle px-4 py-3">
      <span className="flex min-w-0 items-center gap-2 text-ui-base text-info">
        <Zap className="size-4 shrink-0" />
        {intl.formatMessage({ id: "paperclip.banner.zcodePending" }, { count })}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-ui-sm text-info">
          <Switch checked={autoClaim} onCheckedChange={onAutoClaimChange} />
          {intl.formatMessage({ id: "paperclip.banner.autoClaim" })}
        </label>
        <Button variant="outline" size="sm" onClick={onViewPending}>
          {intl.formatMessage({ id: "paperclip.banner.viewPending" })}
        </Button>
        <Button size="sm" onClick={onExecuteNext}>
          <Zap className="size-4" />
          {intl.formatMessage({ id: "paperclip.banner.executeNext" })}
        </Button>
      </div>
    </div>
  );
}
