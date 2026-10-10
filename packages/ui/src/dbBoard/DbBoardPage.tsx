/**
 * 数据库看板主页面：连接条 + line tabs（探索看板 / 数据浏览 / 操作日志 / 知识库）。
 * 与 PaperclipPage 同构：纯投影，数据来自 useDbBoard / useDbBoardDashboards。
 */
import { useMemo, useState } from "react";
import { DatabaseZap, Pin, Plug, PlugZap, Plus } from "lucide-react";
import type { DbBoardConnectionEntry } from "@zcode/services";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog.js";
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DbBoardAgentChatEntry } from "@/dbBoard/DbBoardAgentChatEntry.js";
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

function connectionLabel(entry: DbBoardConnectionEntry): string {
  const label = entry.name?.trim() || `${entry.host}/${entry.database}`;
  return entry.env?.trim() ? `${label}（${entry.env.trim()}）` : label;
}

export function DbBoardPage(props: {
  operator: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenChat: () => void;
}) {
  const { operator, workspacePath, workspaceIdentity, onOpenChat } = props;
  const { intl } = useZCodeIntl();
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const dbBoard = useDbBoard({ workspaceKey });
  const dashboards = useDbBoardDashboards({ workspaceKey });
  const knowledge = useDbBoardKnowledge();
  const [connectionOpen, setConnectionOpen] = useState(false);
  /** null = 新建连接；否则编辑该连接。 */
  const [editingConnection, setEditingConnection] = useState<DbBoardConnectionEntry | null>(null);
  /** blocked 空态里选择要绑定到本项目的连接 id。 */
  const [bindTargetId, setBindTargetId] = useState<string | null>(null);

  const service = dbBoard.connection;
  const activeEntry = useMemo(() => {
    const fromList = dbBoard.connections.find(
      (entry) => entry.id === service?.activeConnectionId,
    );
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
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-card-border bg-card px-6 py-10 text-center">
        <DatabaseZap className="size-6 text-foreground-subtle" />
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "dbboard.binding.blockedTitle" })}
        </span>
        <p className="max-w-md text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "dbboard.binding.blockedDescription" })}
        </p>
        {dbBoard.connections.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Select
              value={bindTargetId ?? dbBoard.connections[0]!.id}
              onValueChange={setBindTargetId}
            >
              <SelectTrigger size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dbBoard.connections.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {connectionLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => void dbBoard.setBinding(bindTargetId ?? dbBoard.connections[0]!.id)}>
              <Pin />
              {intl.formatMessage({ id: "dbboard.binding.bindAction" })}
            </Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={openCreate}>
            <Plus />
            {intl.formatMessage({ id: "dbboard.connection.new" })}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={intl.formatMessage({ id: "dbboard.binding.pin" })}
                  >
                    <Pin />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {intl.formatMessage({ id: "dbboard.binding.confirmTitle" })}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {intl.formatMessage(
                        { id: "dbboard.binding.confirmDescription" },
                        { connection: connectionLabel(selectEntries.find((entry) => entry.id === (service?.activeConnectionId ?? selectEntries[0]!.id)) ?? selectEntries[0]!), workspace: workspaceKey },
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        void dbBoard.setBinding(service?.activeConnectionId ?? selectEntries[0]!.id)
                      }
                    >
                      {intl.formatMessage({ id: "dbboard.binding.bindAction" })}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <Badge
              variant="outline"
              className={cn(
                "gap-1",
                service?.state === "connected" && "border-success/40 bg-success-subtle text-success",
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
            {dbBoard.loadingTables || dashboards.generating ? <Spinner className="size-3.5" /> : null}
            <DbBoardAgentChatEntry
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              username={operator}
              onOpenChat={onOpenChat}
            />
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
    </div>
  );
}
