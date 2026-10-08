/**
 * Paperclip 创建任务对话框：标题/描述/优先级/指派。
 * 指派用可视化选项组（自动分派置顶主推，含分派指令的透明化预览）；优先级为分段
 * 选择；支持 ⌘/Ctrl+Enter 提交。自动分派（DISPATCH_ASSIGNEE 特殊值）提交时由
 * Page 侧把分派指令模板拼进 description 并指派给 dispatcher（role=ceo）。
 */
import { FolderOpen, Loader2, Plus, Sparkles, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import type {
  PaperclipAgent,
  PaperclipIssuePriority,
  PaperclipProject,
} from "@zcode/shared";
import { PaperclipAdapterBrandIcon } from "@/paperclip/paperclipViews.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
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

/** projectId 的特殊值：绑定当前 ZCode 工作区（提交时按需创建 Paperclip 项目）。 */
export const PAPERCLIP_CURRENT_WORKSPACE_PROJECT = "__paperclip_current_workspace__";

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
  /** "" 不绑定 / CURRENT_WORKSPACE 当前工作区（提交时按需建项目）/ 具体 project id。 */
  projectId: string;
}

export const EMPTY_CREATE_DIALOG_STATE: PaperclipCreateDialogState = {
  title: "",
  description: "",
  priority: "medium",
  assigneeAgentId: "",
  projectId: "",
};

const PRIORITIES: ReadonlyArray<PaperclipIssuePriority> = ["urgent", "high", "medium", "low"];

const PRIORITY_DOT: Record<PaperclipIssuePriority, string> = {
  urgent: "bg-danger",
  high: "bg-warning",
  medium: "bg-info",
  low: "bg-foreground-subtlest",
};

export function PaperclipCreateTaskDialog({
  open,
  agents,
  dispatcher,
  projects,
  workspacePath,
  currentWorkspaceProjectId,
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
  projects: PaperclipProject[];
  /** 当前 ZCode 工作区绝对路径（「当前工作区」选项的 cwd）。 */
  workspacePath: string;
  /** 已绑定当前工作区的 Paperclip 项目 id（无则 null，选中时提交侧按需创建）。 */
  currentWorkspaceProjectId: string | null;
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
  /** 「当前工作区」选项的实际值：已有对应项目用其 id，否则用待创建哨兵值。 */
  const currentWorkspaceValue = currentWorkspaceProjectId ?? PAPERCLIP_CURRENT_WORKSPACE_PROJECT;

  function selectAssignee(value: string) {
    onStateChange({ ...state, assigneeAgentId: value });
  }

  /**
   * 选项行（radiogroup 内）。用 div 而不是 button：部分选项内嵌动作按钮，
   * HTML 不允许 button 嵌套 button；键盘可达性由显式 onKeyDown 保证（Enter/Space）。
   */
  function renderOption(input: {
    key: string;
    selected: boolean;
    onSelect: () => void;
    children: ReactNode;
  }) {
    return (
      <div
        key={input.key}
        role="radio"
        aria-checked={input.selected}
        tabIndex={0}
        onClick={input.onSelect}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            input.onSelect();
          }
        }}
        className={cn(
          "flex w-full items-center gap-2.5 border-b border-border-subtle px-3 py-2 text-left text-ui-sm transition-colors last:border-b-0",
          "focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-border-focused",
          input.selected
            ? "bg-selected text-foreground"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
        )}
      >
        <span
          className={cn(
            "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
            input.selected ? "border-info" : "border-border",
          )}
          aria-hidden
        >
          {input.selected ? <span className="size-1.5 rounded-full bg-info" /> : null}
        </span>
        {input.children}
      </div>
    );
  }

  const canSubmit =
    state.title.trim().length > 0 && !submitting && !(autoDispatch && !dispatcher);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(88vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onKeyDown={(event) => {
          // ⌘/Ctrl+Enter 快捷提交（DESIGN.md：键盘是 first-class 交互路径）。
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border-subtle px-5 py-4 pr-12">
          <DialogTitle>{intl.formatMessage({ id: "paperclip.createTask" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "paperclip.createTask.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-1.5">
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
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "paperclip.form.priority" })}</Label>
            <div
              role="radiogroup"
              aria-label={intl.formatMessage({ id: "paperclip.form.priority" })}
              className="flex w-full gap-0.5 rounded-xl border border-border-subtle bg-surface-muted p-0.5"
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
                      "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-ui-sm transition-colors",
                      selected
                        ? "bg-popover text-foreground shadow-sm"
                        : "text-foreground-subtle hover:text-foreground",
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", PRIORITY_DOT[priority])} aria-hidden />
                    {intl.formatMessage({ id: priorityLabelKey(priority) })}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="paperclip-create-description">
              {intl.formatMessage({ id: "paperclip.form.description" })}
            </Label>
            <SettingsFormTextarea
              id="paperclip-create-description"
              value={state.description}
              onChange={(event) => onStateChange({ ...state, description: event.target.value })}
              rows={3}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "paperclip.form.assignee" })}</Label>
            <div role="radiogroup" aria-label={intl.formatMessage({ id: "paperclip.form.assignee" })} className="max-h-56 overflow-y-auto rounded-xl border border-border-subtle">
              {renderOption({
                key: "auto",
                selected: autoDispatch,
                onSelect: () => selectAssignee(PAPERCLIP_DISPATCH_ASSIGNEE),
                children: (
                  <>
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
                  </>
                ),
              })}
              {agents.map((agent) =>
                renderOption({
                  key: agent.id,
                  selected: state.assigneeAgentId === agent.id,
                  onSelect: () => selectAssignee(agent.id),
                  children: (
                    <>
                      <PaperclipAdapterBrandIcon
                        adapterType={agent.adapterType || ""}
                        className="size-4 shrink-0 object-contain"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {agentDisplayName(agent)}
                        {agent.id === dispatcher?.id ? (
                          <span className="ml-2 shrink-0 rounded bg-info-subtle px-1.5 py-0.5 text-ui-xs font-medium text-info">
                            {intl.formatMessage({ id: "paperclip.form.dispatcherBadge" })}
                          </span>
                        ) : null}
                      </span>
                      {agent.adapterType ? (
                        <span className="shrink-0 font-mono text-ui-sm text-foreground-subtlest">
                          {agent.adapterType}
                        </span>
                      ) : null}
                    </>
                  ),
                }),
              )}
              {renderOption({
                key: "none",
                selected: state.assigneeAgentId === "",
                onSelect: () => selectAssignee(""),
                children: (
                  <>
                    <UserRound className="size-4 shrink-0 text-foreground-subtlest" />
                    <span className="min-w-0 flex-1 truncate">
                      {intl.formatMessage({ id: "paperclip.form.assigneeAny" })}
                    </span>
                  </>
                ),
              })}
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "paperclip.form.workspace" })}</Label>
            <div
              role="radiogroup"
              aria-label={intl.formatMessage({ id: "paperclip.form.workspace" })}
              className="max-h-56 overflow-y-auto rounded-xl border border-border-subtle"
            >
              {renderOption({
                key: "workspace-none",
                selected: state.projectId === "",
                onSelect: () => onStateChange({ ...state, projectId: "" }),
                children: (
                  <>
                    <FolderOpen className="size-4 shrink-0 text-foreground-subtlest" />
                    <span className="min-w-0 flex-1 truncate">
                      {intl.formatMessage({ id: "paperclip.form.workspaceNone" })}
                    </span>
                  </>
                ),
              })}
              {workspacePath ? (
                renderOption({
                  key: "workspace-current",
                  selected:
                    state.projectId === currentWorkspaceValue ||
                    state.projectId === PAPERCLIP_CURRENT_WORKSPACE_PROJECT,
                  onSelect: () =>
                    onStateChange({ ...state, projectId: currentWorkspaceValue }),
                  children: (
                    <>
                      <FolderOpen className="size-4 shrink-0 text-info" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {intl.formatMessage({ id: "paperclip.form.workspaceCurrent" })}
                        </span>
                        <span className="block break-all font-mono text-ui-xs leading-snug text-foreground-subtlest">
                          {workspacePath}
                        </span>
                        {currentWorkspaceProjectId === null ? (
                          <span className="mt-0.5 block text-ui-xs text-foreground-subtlest">
                            {intl.formatMessage({ id: "paperclip.form.workspaceWillCreate" })}
                          </span>
                        ) : null}
                      </span>
                    </>
                  ),
                })
              ) : null}
              {projects
                .filter((project) => project.id !== currentWorkspaceProjectId)
                .map((project) =>
                  renderOption({
                    key: project.id,
                    selected: state.projectId === project.id,
                    onSelect: () => onStateChange({ ...state, projectId: project.id }),
                    children: (
                      <>
                        <FolderOpen className="size-4 shrink-0 text-foreground-subtlest" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{project.name}</span>
                          {project.codebase?.localFolder ? (
                            <span className="block truncate font-mono text-ui-sm text-foreground-subtlest">
                              {project.codebase.localFolder}
                            </span>
                          ) : null}
                        </span>
                      </>
                    ),
                  }),
                )}
            </div>
          </div>
          </div>
        </div>
        <DialogFooter className="shrink-0 gap-3 border-t border-border-subtle px-5 py-3 sm:items-center sm:justify-between">
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "paperclip.form.shortcut" })}
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button disabled={!canSubmit} onClick={onSubmit}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {intl.formatMessage({ id: "paperclip.form.submit" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
