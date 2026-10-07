/**
 * Paperclip 创建任务对话框：标题/描述/优先级/指派。
 * 指派用可视化选项组（自动分派置顶主推，含分派指令的透明化预览）；优先级为分段
 * 选择；支持 ⌘/Ctrl+Enter 提交。自动分派（DISPATCH_ASSIGNEE 特殊值）提交时由
 * Page 侧把分派指令模板拼进 description 并指派给 dispatcher（role=ceo）。
 */
import { Loader2, Plus, Sparkles, UserRound } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { cn } from "@/components/lib/utils.js";
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

const PRIORITIES: ReadonlyArray<PaperclipIssuePriority> = ["urgent", "high", "medium", "low"];

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

  function selectAssignee(value: string) {
    onStateChange({ ...state, assigneeAgentId: value });
  }

  const assigneeOptionClass = (selected: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-ui-base transition-colors",
      selected
        ? "border-border-focused bg-selected text-foreground"
        : "border-border-subtle text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
    );

  const canSubmit =
    state.title.trim().length > 0 && !submitting && !(autoDispatch && !dispatcher);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(event) => {
          // ⌘/Ctrl+Enter 快捷提交（DESIGN.md：键盘是 first-class 交互路径）。
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      >
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
              autoFocus
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
          </div>
          <div className="flex flex-col gap-1">
            <Label role="group">{intl.formatMessage({ id: "paperclip.form.assignee" })}</Label>
            <div role="radiogroup" aria-label={intl.formatMessage({ id: "paperclip.form.assignee" })} className="flex flex-col gap-1">
              <button
                type="button"
                role="radio"
                aria-checked={autoDispatch}
                onClick={() => selectAssignee(PAPERCLIP_DISPATCH_ASSIGNEE)}
                className={assigneeOptionClass(autoDispatch)}
              >
                <Sparkles className="size-4 shrink-0 text-info" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {intl.formatMessage({ id: "paperclip.form.assigneeAuto" })}
                  </span>
                  <span className="block truncate text-ui-sm text-foreground-subtlest">
                    {dispatcher
                      ? intl.formatMessage(
                          { id: "paperclip.form.assigneeAutoBy" },
                          { name: agentDisplayName(dispatcher) },
                        )
                      : intl.formatMessage({ id: "paperclip.form.dispatcherMissing" })}
                  </span>
                </span>
                {autoDispatch && !dispatcher ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={ensuringDispatcher}
                    onClick={(event) => {
                      event.stopPropagation();
                      onEnsureDispatcher();
                    }}
                  >
                    {ensuringDispatcher ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    {intl.formatMessage({ id: "paperclip.form.createDispatcher" })}
                  </Button>
                ) : null}
              </button>
              {agents
                .filter((agent) => agent.id !== dispatcher?.id)
                .map((agent) => {
                  const selected = state.assigneeAgentId === agent.id;
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => selectAssignee(agent.id)}
                      className={assigneeOptionClass(selected)}
                    >
                      <UserRound className="size-4 shrink-0 text-foreground-subtlest" />
                      <span className="min-w-0 flex-1 truncate">{agentDisplayName(agent)}</span>
                      {agent.adapterType ? (
                        <span className="shrink-0 font-mono text-ui-sm text-foreground-subtlest">
                          {agent.adapterType}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              <button
                type="button"
                role="radio"
                aria-checked={state.assigneeAgentId === ""}
                onClick={() => selectAssignee("")}
                className={assigneeOptionClass(state.assigneeAgentId === "")}
              >
                <UserRound className="size-4 shrink-0 text-foreground-subtlest" />
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage({ id: "paperclip.form.assigneeAny" })}
                </span>
              </button>
            </div>
            {autoDispatch ? (
              <Collapsible className="mt-1">
                <CollapsibleTrigger className="text-ui-sm text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline">
                  {intl.formatMessage({ id: "paperclip.form.viewDirective" })}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-3 font-sans text-ui-sm text-foreground-subtle">
                    {PAPERCLIP_DISPATCH_DIRECTIVE}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label>{intl.formatMessage({ id: "paperclip.form.priority" })}</Label>
            <div
              role="radiogroup"
              aria-label={intl.formatMessage({ id: "paperclip.form.priority" })}
              className="flex w-full gap-0.5 rounded-lg border border-border-subtle bg-surface-muted p-0.5"
            >
              {PRIORITIES.map((priority) => {
                const selected = state.priority === priority;
                return (
                  <button
                    key={priority}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onStateChange({ ...state, priority })}
                    className={cn(
                      "flex-1 rounded-md px-2 py-1 text-ui-base transition-colors",
                      selected
                        ? "bg-popover text-foreground shadow-sm"
                        : "text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    {intl.formatMessage({ id: priorityLabelKey(priority) })}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button disabled={!canSubmit} onClick={onSubmit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {intl.formatMessage({ id: "paperclip.form.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
