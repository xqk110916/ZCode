/**
 * 数据库看板主页面：连接条 + line tabs（探索看板 / 数据浏览 / 操作日志 / 知识库）。
 * 与 PaperclipPage 同构：纯投影，数据来自 useDbBoard / useDbBoardDashboards。
 */
import { useMemo, useState } from "react";
import { Pin, Plug, PlugZap, Plus } from "lucide-react";
import type { DbBoardConnectionEntry } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useRecentProjects } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardAgentChatEntry } from "@/dbBoard/DbBoardAgentChatEntry.js";
import {
  connectionLabel,
  DbBoardBindDialog,
  DbBoardInlineNotice,
  workspaceDisplayName,
  workspaceOptionKey,
  type DbBoardWorkspaceOption,
} from "@/dbBoard/DbBoardBindDialog.js";
import { DbBoardBlockedState } from "@/dbBoard/DbBoardBlockedState.js";
import { DbBoardConnectionDialog } from "@/dbBoard/DbBoardConnectionDialog.js";
import { DbBoardKnowledgeSummary } from "@/dbBoard/DbBoardKnowledgeSummary.js";
import { DbBoardDataTab } from "@/dbBoard/DbBoardDataTab.js";
import { DbBoardExplorerTab } from "@/dbBoard/DbBoardExplorerTab.js";
import { DbBoardKnowledgeTab } from "@/dbBoard/DbBoardKnowledgeTab.js";
import { DbBoardLogsTab } from "@/dbBoard/DbBoardLogsTab.js";
import { useDbBoard } from "@/dbBoard/useDbBoard.js";
import { useDbBoardDashboards } from "@/dbBoard/useDbBoardDashboards.js";
import { useDbBoardKnowledge } from "@/dbBoard/useDbBoardKnowledge.js";

const TAB_TRIGGER_CLASS =
  "h-8 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden";

export function DbBoardPage(props: {
  operator: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenChat: () => void;
  /** 助手对话入口依赖 ZCode agent 会话；BoardHub 独立应用传 false 隐藏。 */
  agentChatEnabled?: boolean;
}) {
  const { operator, workspacePath, workspaceIdentity, onOpenChat, agentChatEnabled = true } = props;
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const dbBoard = useDbBoard({ workspaceKey });
  const dashboards = useDbBoardDashboards({ workspaceKey });
  const knowledge = useDbBoardKnowledge();
  const [connectionOpen, setConnectionOpen] = useState(false);
  /** null = 新建连接；否则编辑该连接。 */
  const [editingConnection, setEditingConnection] = useState<DbBoardConnectionEntry | null>(null);
  /** 绑定对话框开关（页头 Pin 与 blocked 空态共用）。 */
  const [bindOpen, setBindOpen] = useState(false);
  /** 绑定到非当前项目的成功回执；绑当前项目时视图自身变化即反馈，不设通知。 */
  const [bindNotice, setBindNotice] = useState<string | null>(null);
  const { recentProjects } = useRecentProjects();

  const service = dbBoard.connection;
  const activeEntry = useMemo(() => {
    const fromList = dbBoard.connections.find((entry) => entry.id === service?.activeConnectionId);
    if (fromList) {
      return fromList;
    }
    // 兜底：listConnections 尚未返回时，连接状态快照已带完整字段（运行时含 id），
    // 保证"连接配置"回显不依赖第二个 RPC 的完成时序。
    if (service?.activeConnectionId && service.config) {
      return { ...service.config, id: service.activeConnectionId } as DbBoardConnectionEntry;
    }
    return null;
  }, [dbBoard.connections, service]);
  // 清单暂缺（断连窗口 listConnections 失败未恢复）时回退用快照合成条目，保证选择器永不与状态徽标矛盾。
  const selectEntries =
    dbBoard.connections.length > 0 ? dbBoard.connections : activeEntry ? [activeEntry] : [];

  // 绑定目标：当前项目置顶，最近项目按服务端同款归一化去重后追加。
  const workspaceOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: DbBoardWorkspaceOption[] = [];
    if (workspaceKey) {
      options.push({ key: workspaceKey, isCurrent: true });
      seen.add(workspaceOptionKey(workspaceKey));
    }
    for (const path of recentProjects) {
      const trimmed = path.trim();
      if (!trimmed || seen.has(workspaceOptionKey(trimmed))) continue;
      seen.add(workspaceOptionKey(trimmed));
      options.push({ key: trimmed, isCurrent: false });
    }
    return options;
  }, [workspaceKey, recentProjects]);

  // blocked 空态的「已绑定项目」清单（排除当前项目；blocked 时当前必不在绑定表内，防御性排除）。
  const boundOtherProjects = useMemo(() => {
    const current = workspaceKey ? workspaceOptionKey(workspaceKey) : null;
    return Object.keys(dbBoard.bindingsInfo?.bindings ?? {})
      .filter((key) => workspaceOptionKey(key) !== current)
      .map(workspaceDisplayName);
  }, [dbBoard.bindingsInfo, workspaceKey]);

  const stateLabel =
    service?.state === "connected"
      ? intl.formatMessage({ id: "dbboard.connection.connected" })
      : service?.state === "error"
        ? intl.formatMessage({ id: "dbboard.connection.error" })
        : intl.formatMessage({ id: "dbboard.connection.disconnected" });

  const openEditActive = () => {
    setEditingConnection(activeEntry);
    setConnectionOpen(true);
  };

  const openCreate = () => {
    setEditingConnection(null);
    setConnectionOpen(true);
  };

  // blocked 空态与页头 Pin 共用：条件挂载让每次打开都以激活连接 + 当前项目为默认值。
  const bindDialog =
    bindOpen && selectEntries.length > 0 ? (
      <DbBoardBindDialog
        connections={selectEntries}
        defaultConnectionId={service?.activeConnectionId ?? selectEntries[0]!.id}
        workspaceOptions={workspaceOptions}
        onBind={(connectionId, targetWorkspaceKey) => {
          setBindOpen(false);
          setBindNotice(null);
          void dbBoard.setBinding(connectionId, targetWorkspaceKey).then((ok) => {
            // 绑到非当前项目时当前视图不变（仍 blocked），需要明确回执，否则看起来"没反应"。
            if (ok && workspaceOptionKey(targetWorkspaceKey) !== workspaceOptionKey(workspaceKey)) {
              setBindNotice(
                intl.formatMessage(
                  { id: "dbboard.binding.boundNotice" },
                  { workspace: targetWorkspaceKey },
                ),
              );
            }
          });
        }}
        onClose={() => setBindOpen(false)}
      />
    ) : null;

  if (!dbBoard.serviceAvailable) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl border border-card-border bg-card text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "dbboard.serviceUnavailable" })}
      </div>
    );
  }

  const access = service?.workspaceAccess ?? "legacy";
  if (access === "blocked") {
    return (
      <DbBoardBlockedState
        hasConnections={dbBoard.connections.length > 0}
        boundOtherProjects={boundOtherProjects}
        boundKeysTooltip={Object.keys(dbBoard.bindingsInfo?.bindings ?? {}).join("\n")}
        actionError={dbBoard.actionError}
        onClearActionError={dbBoard.clearActionError}
        bindNotice={bindNotice}
        onClearBindNotice={() => setBindNotice(null)}
        onOpenBindDialog={() => setBindOpen(true)}
        onCreateConnection={openCreate}
        bindDialog={bindDialog}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bindNotice ? (
        <DbBoardInlineNotice
          tone="success"
          message={bindNotice}
          onClose={() => setBindNotice(null)}
        />
      ) : null}
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
          <TabsList variant="line" className="h-8 gap-1 p-0">
            <TabsTrigger value="overview" className={TAB_TRIGGER_CLASS}>
              {intl.formatMessage({ id: "dbboard.tab.overview" })}
            </TabsTrigger>
            <TabsTrigger value="knowledge" className={TAB_TRIGGER_CLASS}>
              {intl.formatMessage({ id: "dbboard.tab.knowledge" })}
            </TabsTrigger>
            <TabsTrigger value="data" className={TAB_TRIGGER_CLASS}>
              {intl.formatMessage({ id: "dbboard.tab.data" })}
            </TabsTrigger>
            <TabsTrigger value="logs" className={TAB_TRIGGER_CLASS}>
              {intl.formatMessage({ id: "dbboard.tab.logs" })}
            </TabsTrigger>
            <TabsTrigger value="explorer" className={TAB_TRIGGER_CLASS}>
              {intl.formatMessage({ id: "dbboard.tab.explorer" })}
            </TabsTrigger>
          </TabsList>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {selectEntries.length > 0 ? (
              <Select
                value={service?.activeConnectionId ?? selectEntries[0]!.id}
                onValueChange={(id) => void dbBoard.setActiveConnection(id)}
              >
                <SelectTrigger size="sm" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectEntries.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {connectionLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="max-w-52 text-foreground-subtle"
                onClick={openCreate}
              >
                {intl.formatMessage({ id: "dbboard.connection.none" })}
              </Button>
            )}
            {access === "bound" ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="bg-selected"
                title={intl.formatMessage({ id: "dbboard.binding.unpin" })}
                onClick={() => void dbBoard.setBinding(null)}
              >
                <Pin />
              </Button>
            ) : selectEntries.length > 0 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                title={intl.formatMessage({ id: "dbboard.binding.pin" })}
                onClick={() => setBindOpen(true)}
              >
                <Pin />
              </Button>
            ) : null}
            <Badge
              variant="outline"
              className={cn(
                "gap-1",
                service?.state === "connected" &&
                  "border-success/40 bg-success-subtle text-success",
                service?.state === "error" &&
                  "border-destructive/40 bg-destructive/10 text-destructive",
              )}
              title={
                service?.config
                  ? `${service.config.host}:${service.config.port}/${service.config.database}${service?.error ? `\n${service.error}` : ""}`
                  : undefined
              }
            >
              {service?.state === "error" && service.error
                ? `${stateLabel}：${service.error.slice(0, 48)}`
                : stateLabel}
            </Badge>
            {dbBoard.loadingTables || dashboards.generating ? (
              <Spinner className="size-3.5" />
            ) : null}
            {agentChatEnabled ? (
              <DbBoardAgentChatEntry
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                username={operator}
                onOpenChat={onOpenChat}
              />
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void dbBoard.refreshConnection()}
              title={intl.formatMessage({ id: "dbboard.connection.recheck" })}
            >
              <PlugZap />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={openCreate}
              title={intl.formatMessage({ id: "dbboard.connection.new" })}
            >
              <Plus />
              {intl.formatMessage({ id: "dbboard.connection.new" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={openEditActive}
              title={intl.formatMessage({ id: "dbboard.connection.configure" })}
            >
              <Plug />
              {intl.formatMessage({ id: "dbboard.connection.configure" })}
            </Button>
          </div>
        </div>
        <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col">
          <DbBoardKnowledgeSummary
            summary={dbBoard.usage.usageSummary}
            computing={dbBoard.usage.usageSummaryComputing}
            knowledgeReady={Boolean(knowledge.knowledge)}
            onGenerate={() => void dbBoard.usage.loadUsageSummary({ compute: true })}
            onRefresh={() => void dbBoard.usage.loadUsageSummary({ compute: true, force: true })}
          />
        </TabsContent>
        <TabsContent value="knowledge" className="flex min-h-0 flex-1 flex-col">
          <DbBoardKnowledgeTab
            state={knowledge}
            connections={dbBoard.connections}
            boardTables={dbBoard.tables}
            onLoadColumns={dbBoard.getTableColumns}
            onEnsureSummary={(params) => dbBoard.usage.loadUsageSummary(params)}
          />
        </TabsContent>
        <TabsContent value="data" className="flex min-h-0 flex-1 flex-col">
          <DbBoardDataTab
            state={dbBoard}
            operator={operator}
            knowledge={knowledge.knowledge}
            rowCounts={dbBoard.usage.usageSummary?.rowCounts ?? null}
          />
        </TabsContent>
        <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
          <DbBoardLogsTab state={dbBoard} operator={operator} />
        </TabsContent>
        <TabsContent value="explorer" className="flex min-h-0 flex-1 flex-col">
          <DbBoardExplorerTab state={dashboards} knowledgeReady={Boolean(knowledge.knowledge)} />
        </TabsContent>
      </Tabs>

      <DbBoardConnectionDialog
        key={editingConnection?.id ?? "new"}
        open={connectionOpen}
        onOpenChange={setConnectionOpen}
        editing={editingConnection}
        onSave={dbBoard.saveConnection}
        onTest={dbBoard.testConnection}
      />
      {bindDialog}
    </div>
  );
}
