/**
 * 创建任务的提交编排（从 PaperclipPage 拆出，控制文件行数）：
 * 工作区「当前工作区」ensure、自动分派模板拼装、toast 反馈。
 */
import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PaperclipAgent, PaperclipProject } from "@zcode/shared";
import { agentDisplayName } from "@/paperclip/paperclipViews.js";
import {
  buildDispatchDescription,
  EMPTY_CREATE_DIALOG_STATE,
  PAPERCLIP_CURRENT_WORKSPACE_PROJECT,
  PAPERCLIP_DISPATCH_ASSIGNEE,
  type PaperclipCreateDialogState,
} from "@/paperclip/PaperclipCreateTaskDialog.js";

export function usePaperclipCreateSubmit(input: {
  workspacePath: string;
  dispatcher: PaperclipAgent | null;
  projects: readonly PaperclipProject[];
  createIssue: (payload: {
    title: string;
    description?: string;
    priority: PaperclipCreateDialogState["priority"];
    projectId?: string;
    assigneeAgentId?: string;
  }) => Promise<boolean>;
  ensureProjectForWorkspace: (input: { name: string; cwd: string }) => Promise<PaperclipProject | null>;
}) {
  const { intl } = useZCodeIntl();
  const [submitting, setSubmitting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createState, setCreateState] = useState<PaperclipCreateDialogState>(
    EMPTY_CREATE_DIALOG_STATE,
  );

  /** 打开对话框：dispatcher 存在时默认指派主 Agent；当前工作区已注册为项目时默认绑定。 */
  const openCreateDialog = useCallback(
    (defaults: { dispatcherId: string | null; currentWorkspaceProjectId: string | null }) => {
      setCreateState({
        ...EMPTY_CREATE_DIALOG_STATE,
        assigneeAgentId: defaults.dispatcherId ?? "",
        projectId: defaults.currentWorkspaceProjectId ?? "",
      });
      setCreateOpen(true);
    },
    [],
  );

  const submitCreate = useCallback(async () => {
    if (!createState.title.trim() || submitting) return;
    let projectId = createState.projectId;
    if (projectId === PAPERCLIP_CURRENT_WORKSPACE_PROJECT && input.workspacePath) {
      const project = await input.ensureProjectForWorkspace({
        // 项目名取工作区目录名（Paperclip 项目重名可共存，按 cwd 幂等匹配）。
        name: input.workspacePath.split("/").filter(Boolean).pop() ?? input.workspacePath,
        cwd: input.workspacePath,
      });
      if (!project) {
        // ensureProjectForWorkspace 已把原因写进 actionError；中止提交。
        return;
      }
      projectId = project.id;
    }
    setSubmitting(true);
    const dispatcher = input.dispatcher;
    const autoDispatch =
      createState.assigneeAgentId === PAPERCLIP_DISPATCH_ASSIGNEE && dispatcher !== null;
    const ok = await input.createIssue({
      title: createState.title.trim(),
      // 自动分派：指令模板随描述一起提交（对话框中有提示，用户可见可预期）。
      ...(autoDispatch
        ? { description: buildDispatchDescription(createState.description) }
        : createState.description.trim() === ""
          ? {}
          : { description: createState.description.trim() }),
      priority: createState.priority,
      ...(projectId === "" ? {} : { projectId }),
      ...(autoDispatch
        ? { assigneeAgentId: dispatcher.id }
        : createState.assigneeAgentId === "" ||
            createState.assigneeAgentId === PAPERCLIP_DISPATCH_ASSIGNEE
          ? {}
          : { assigneeAgentId: createState.assigneeAgentId }),
    });
    setSubmitting(false);
    if (ok) {
      setCreateOpen(false);
      setCreateState(EMPTY_CREATE_DIALOG_STATE);
      // 创建成功的轻反馈：自动分派时说明交给谁调度，手动指派时说明唤醒谁。
      toast(
        autoDispatch
          ? intl.formatMessage(
              { id: "paperclip.toast.createdAuto" },
              { name: dispatcher ? agentDisplayName(dispatcher) : "" },
            )
          : intl.formatMessage({ id: "paperclip.toast.created" }),
      );
    }
  }, [createState, submitting, input, intl]);

  return {
    submitting,
    createOpen,
    setCreateOpen,
    createState,
    setCreateState,
    openCreateDialog,
    submitCreate,
  };
}
