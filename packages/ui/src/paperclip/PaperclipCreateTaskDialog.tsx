/**
 * Paperclip 创建任务对话框：标题/描述/优先级/指派 agent。
 * 提交经 usePaperclip.createIssue（防抖由禁用提交按钮承担），成功后由父组件关闭并清空表单。
 */
import { Loader2, Plus } from "lucide-react";
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

export interface PaperclipCreateDialogState {
  title: string;
  description: string;
  priority: PaperclipIssuePriority;
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
  submitting,
  state,
  onStateChange,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  agents: PaperclipAgent[];
  submitting: boolean;
  state: PaperclipCreateDialogState;
  onStateChange: (next: PaperclipCreateDialogState) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const { intl } = useZCodeIntl();
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
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agentDisplayName(agent)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <Button disabled={!state.title.trim() || submitting} onClick={onSubmit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {intl.formatMessage({ id: "paperclip.form.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
