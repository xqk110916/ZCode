/**
 * DbBoardBlockedState —— 严格模式下未绑定工作区的空态引导。
 *
 * 说明当前项目为何被拒、列出已绑定的其他项目（看懂"绑定都去哪了"），
 * 并渲染动作失败的错误横幅与「绑定到非当前项目」的成功回执——
 * 绑到别处时当前视图不变，没有回执会表现得像"没反应"。
 */
import type { ReactNode } from "react";
import { DatabaseZap, Pin, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardInlineNotice } from "@/dbBoard/DbBoardBindDialog.js";

export function DbBoardBlockedState(props: {
  /** 有连接 → 引导绑定；无连接 → 引导新建。 */
  hasConnections: boolean;
  /** 已绑定的其他项目展示名（路径末段）。 */
  boundOtherProjects: string[];
  /** hover 展示完整绑定键（同名目录消歧）。 */
  boundKeysTooltip: string;
  actionError: string | null;
  onClearActionError: () => void;
  bindNotice: string | null;
  onClearBindNotice: () => void;
  onOpenBindDialog: () => void;
  onCreateConnection: () => void;
  /** 页头共用的绑定对话框（条件挂载，随本空态一起渲染）。 */
  bindDialog: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const { boundOtherProjects } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-card-border bg-card px-6 py-10 text-center">
      <DatabaseZap className="size-6 text-foreground-subtle" />
      <span className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "dbboard.binding.blockedTitle" })}
      </span>
      <p className="max-w-md text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.binding.blockedDescription" })}
      </p>
      {boundOtherProjects.length > 0 ? (
        <p className="max-w-md text-ui-xs text-foreground-subtle" title={props.boundKeysTooltip}>
          {boundOtherProjects.length > 5
            ? intl.formatMessage(
                { id: "dbboard.binding.boundProjectsMore" },
                {
                  projects: boundOtherProjects.slice(0, 5).join("、"),
                  count: boundOtherProjects.length,
                },
              )
            : intl.formatMessage(
                { id: "dbboard.binding.boundProjects" },
                { projects: boundOtherProjects.join("、") },
              )}
        </p>
      ) : null}
      {props.actionError ? (
        <DbBoardInlineNotice
          tone="error"
          message={props.actionError}
          onClose={props.onClearActionError}
        />
      ) : null}
      {props.bindNotice ? (
        <DbBoardInlineNotice
          tone="success"
          message={props.bindNotice}
          onClose={props.onClearBindNotice}
        />
      ) : null}
      {props.hasConnections ? (
        <Button size="sm" onClick={props.onOpenBindDialog}>
          <Pin />
          {intl.formatMessage({ id: "dbboard.binding.openAction" })}
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={props.onCreateConnection}>
          <Plus />
          {intl.formatMessage({ id: "dbboard.connection.new" })}
        </Button>
      )}
      {props.bindDialog}
    </div>
  );
}
