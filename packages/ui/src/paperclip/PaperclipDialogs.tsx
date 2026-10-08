/**
 * 面板的三个弹窗组装（从 PaperclipPage 拆出，控制文件行数）：
 * 创建任务 / agent 配置 / 添加本地 agent。状态由 Page 持有，这里只做传递与
 * 各弹窗自己的回调编排（toast、ensure 包装、默认主 Agent 规则）。
 */
import type { PaperclipAgent } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PaperclipCreateTaskDialog } from "@/paperclip/PaperclipCreateTaskDialog.js";
import type { PaperclipCreateDialogState } from "@/paperclip/PaperclipCreateTaskDialog.js";
import { PaperclipAgentConfigDialog } from "@/paperclip/PaperclipAgentConfigDialog.js";
import { PaperclipAddAgentDialog } from "@/paperclip/PaperclipAddAgentDialog.js";
import type { UsePaperclipState } from "@/paperclip/usePaperclip.js";

export function PaperclipDialogs({
  paperclip,
  workspacePath,
  currentWorkspaceProjectId,
  createOpen,
  setCreateOpen,
  createState,
  setCreateState,
  submitting,
  submitCreate,
  ensuringDispatcher,
  setEnsuringDispatcher,
  configAgent,
  setConfigAgent,
  addAgentOpen,
  setAddAgentOpen,
}: {
  paperclip: UsePaperclipState;
  workspacePath: string;
  currentWorkspaceProjectId: string | null;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  createState: PaperclipCreateDialogState;
  setCreateState: (state: PaperclipCreateDialogState) => void;
  submitting: boolean;
  submitCreate: () => void;
  ensuringDispatcher: boolean;
  setEnsuringDispatcher: (value: boolean) => void;
  configAgent: PaperclipAgent | null;
  setConfigAgent: (agent: PaperclipAgent | null) => void;
  addAgentOpen: boolean;
  setAddAgentOpen: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <PaperclipCreateTaskDialog
        open={createOpen}
        agents={paperclip.agents}
        dispatcher={paperclip.dispatcher}
        projects={paperclip.projects}
        workspacePath={workspacePath}
        currentWorkspaceProjectId={currentWorkspaceProjectId}
        submitting={submitting}
        ensuringDispatcher={ensuringDispatcher}
        state={createState}
        onStateChange={setCreateState}
        onOpenChange={setCreateOpen}
        onSubmit={submitCreate}
        onEnsureDispatcher={() => {
          setEnsuringDispatcher(true);
          void paperclip.ensureDispatcher().finally(() => setEnsuringDispatcher(false));
        }}
      />

      <PaperclipAgentConfigDialog
        agent={configAgent}
        open={configAgent !== null}
        onOpenChange={(open) => {
          if (!open) setConfigAgent(null);
        }}
        loadAdapterModels={paperclip.loadAdapterModels}
        discoverClaudeModels={paperclip.discoverClaudeModels}
        isDispatcher={configAgent?.id === paperclip.dispatcher?.id}
        onSetDispatcher={paperclip.setDispatcher}
        onSave={paperclip.updateAgent}
      />

      <PaperclipAddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        detectLocalAgentAdapters={paperclip.detectLocalAgentAdapters}
        existingAdapterTypes={
          new Set(
            paperclip.agents.flatMap((agent) =>
              agent.adapterType ? [agent.adapterType] : [],
            ),
          )
        }
        onCreate={async (input) => {
          // 团队还没有主 Agent 时，新增的第一个 agent 默认成为主 Agent（调度负责人）。
          const ok = await paperclip.createAgent({
            ...input,
            ...(paperclip.dispatcher ? {} : { role: "ceo" }),
          });
          if (ok) {
            toast(
              intl.formatMessage({ id: "paperclip.addAgent.created" }, { name: input.name }) +
                (paperclip.dispatcher
                  ? ""
                  : intl.formatMessage({ id: "paperclip.addAgent.becameDispatcher" })),
            );
          }
          return ok;
        }}
      />
    </>
  );
}
