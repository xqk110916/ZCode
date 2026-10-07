/**
 * Paperclip 创建任务对话框：标题/描述/优先级/指派。
 * 指派支持「主 Agent 自动分派」（DISPATCH_ASSIGNEE 特殊值）：提交时由 Page 侧把
 * 分派指令模板拼进 description 并指派给 dispatcher（role=ceo）；智能判断的主体是
 * dispatcher 的 LLM，本组件只做路由选择。
 */
import { Loader2, Plus, Sparkles } from "lucide-react";
import type {
  PaperclipAgent,
  PaperclipIssuePriority,
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { agentDisplayName, priorityLabelKey } from "@/paperclip/paperclipViews.js";

/** assigneeAgentId 的特殊值：主 Agent 自动分派。 */
export const PAPERCLIP_DISPATCH_ASSIGNEE = "__paperclip_auto_dispatch__";

/** 分派指令模板：引导 dispatcher 的 LLM 做单/多 agent 判断（见 spec 自动分派一节）。 */
export const PAPERCLIP_DISPATCH_DIRECTIVE = [
  "【分派指令】",
  "你是本团队的调度负责人。请先评估此任务的规模，再决定执行方式：",
  "1. 若单个终端 agent 即可完成（例如一个 Claude Code / Kimi / Grok 实例，允许其内部使用子 agent 协同开发），请直接自己处理，或创建一个子任务指派给最合适的 agent；",
  "2. 若需要多种角色协作（如实现 + 审查 + 测试），请拆解为多个子任务并分别指派给合适的 agent，设置好依赖关系，跟踪至全部完成后汇总结果；",
  "3. 无论哪种方式，请在本任务线程回复你的分派决策与理由，完成后汇报结果。",
].join("\n");

/** 自动分派模式下拼装最终 description：用户描述 + 指令模板（用户可见可预期）。 */
export function buildDispatchDescription(userDescription: string): string {
  const trimmed = userDescription.trim();
  return trimmed === "" ? PAPERCLIP_DISPATCH_DIRECTIVE : `${trimmed}\n\n${PAPERCLIP_DISPATCH_DIRECTIVE}`;
}

export interface PaperclipCreateDialogState {
  title: string;
  description: string;
  priority: PaperclipIssuePriority;
  /** "" 不指派 / DISPATCH_ASSIGNEE 自动分派 / 具体 agent id。 */
  assigneeAgentId: string;
}

export const EMPTY_CREATE_DIALOG_STATE: PaperclipCreateDialogState = {
  title: "",
  description: "",
  priority: "medium",
  assigneeAgentId: "",
};

export function PaperclipCreateTaskDialog({
  open,
  agents,
  dispatcher,
  submitting,
  ensuringDispatcher,
  state,
  onStateChange,
  onOpenChange,
  onSubmit,
  onEnsureDispatcher,
}: {
  open: boolean;
  agents: PaperclipAgent[];
  dispatcher: PaperclipAgent | null;
  submitting: boolean;
  ensuringDispatcher: boolean;
  state: PaperclipCreateDialogState;
  onStateChange: (next: PaperclipCreateDialogState) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  onEnsureDispatcher: () => void;
}) {
  const { intl } = useZCodeIntl();
  const autoDispatch = state.assigneeAgentId === PAPERCLIP_DISPATCH_ASSIGNEE;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "paperclip.createTask" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "paperclip.createTask.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5">
          <div className="flex flex-col gap-1">
            <Label htmlFor="paperclip-create-title">
              {intl.formatMessage({ id: "paperclip.form.title" })}
            </Label>
            <Input
              id="paperclip-create-title"
              value={state.title}
              onChange={(event) => onStateChange({ ...state, title: event.target.value })}
              placeholder={intl.formatMessage({ id: "paperclip.form.titlePlaceholder" })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="paperclip-create-description">
              {intl.formatMessage({ id: "paperclip.form.description" })}
            </Label>
            <SettingsFormTextarea
              id="paperclip-create-description"
              value={state.description}
              onChange={(event) => onStateChange({ ...state, description: event.target.value })}
              rows={4}
            />
            {autoDispatch ? (
              <p className="text-ui-sm text-foreground-subtlest">
                {intl.formatMessage({ id: "paperclip.form.dispatchDirectiveHint" })}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>{intl.formatMessage({ id: "paperclip.form.assignee" })}</Label>
              <Select
                value={state.assigneeAgentId}
                onValueChange={(value) => onStateChange({ ...state, assigneeAgentId: value })}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={intl.formatMessage({ id: "paperclip.form.assigneeAny" })}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PAPERCLIP_DISPATCH_ASSIGNEE}>
                    <span className="flex items-center gap-1">
                      <Sparkles className="size-3" />
                      {intl.formatMessage({ id: "paperclip.form.assigneeAuto" })}
                    </span>
                  </SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agentDisplayName(agent)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {autoDispatch && !dispatcher ? (
                <div className="flex flex-col gap-1">
                  <p className="text-ui-sm text-warning">
                    {intl.formatMessage({ id: "paperclip.form.dispatcherMissing" })}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={ensuringDispatcher}
                    onClick={onEnsureDispatcher}
                  >
                    {ensuringDispatcher ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {intl.formatMessage({ id: "paperclip.form.createDispatcher" })}
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-1">
              <Label>{intl.formatMessage({ id: "paperclip.form.priority" })}</Label>
              <Select
                value={state.priority}
                onValueChange={(value) =>
                  onStateChange({ ...state, priority: value as PaperclipIssuePriority })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["urgent", "high", "medium", "low"] as const).map((priority) => (
                    <SelectItem key={priority} value={priority}>
                      {intl.formatMessage({ id: priorityLabelKey(priority) })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            disabled={!state.title.trim() || submitting || (autoDispatch && !dispatcher)}
            onClick={onSubmit}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {intl.formatMessage({ id: "paperclip.form.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
