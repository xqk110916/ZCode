/**
 * BoardHub 应用骨架：顶部 Tab 切换 数据库看板 / Paperclip 任务 / 设置。
 * 复用 @zcode/ui 的 DbBoardPage 与 PaperclipPage；不传 ZCode 执行回调与助手入口。
 */
import { useState } from "react";
import { DatabaseZap, ListChecks, Moon, Settings, Sun } from "lucide-react";
import { DbBoardPage } from "@/dbBoard/DbBoardPage.js";
import { PaperclipPage } from "@/paperclip/PaperclipPage.js";
import { PaperclipSettingsSection } from "@/settings/PaperclipSettingsSection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveTheme, useTheme } from "@/useTheme.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { BoardhubModelSettingsSection } from "./BoardhubModelSettingsSection.js";

type BoardHubTab = "db-board" | "paperclip" | "settings";

/** BoardHub 无 ZCode 工作区概念：绑定/审计统一用固定 key。 */
const BOARDHUB_WORKSPACE_KEY = "boardhub";

const TABS: Array<{ id: BoardHubTab; icon: typeof DatabaseZap; labelKey: string }> = [
  { id: "db-board", icon: DatabaseZap, labelKey: "boardhub.tab.dbBoard" },
  { id: "paperclip", icon: ListChecks, labelKey: "boardhub.tab.paperclip" },
  { id: "settings", icon: Settings, labelKey: "boardhub.tab.settings" },
];

export function BoardHubApp() {
  const { intl } = useZCodeIntl();
  const { theme, setTheme } = useTheme();
  const resolvedTheme = resolveTheme(theme);
  const [tab, setTab] = useState<BoardHubTab>("db-board");

  return (
    <div className="flex h-dvh min-h-dvh w-full flex-col bg-background text-foreground">
      <header className="flex h-11 flex-none items-center gap-2 border-b border-border px-3">
        <span className="mr-1 text-ui-sm font-semibold tracking-wide">BoardHub</span>
        <nav className="flex items-center gap-1" role="tablist">
          {TABS.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-testid={`boardhub-tab-${id}`}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-3 text-ui-xs transition-colors",
                tab === id
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover",
              )}
              onClick={() => setTab(id)}
            >
              <Icon className="size-3.5" />
              {intl.formatMessage({ id: labelKey })}
            </button>
          ))}
        </nav>
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="icon-sm"
            title={intl.formatMessage({ id: "boardhub.theme.toggle" })}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? (
              <Sun className="size-3.5" />
            ) : (
              <Moon className="size-3.5" />
            )}
          </Button>
        </div>
      </header>
      {tab === "db-board" ? (
        <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-6 md:py-6">
            <DbBoardPage
              operator="boardhub"
              workspacePath={BOARDHUB_WORKSPACE_KEY}
              onOpenChat={() => {}}
              agentChatEnabled={false}
            />
          </div>
        </main>
      ) : tab === "paperclip" ? (
        <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 md:px-6 md:py-6">
            {/* 不传 workspacePath：无 ZCode 工作区上下文，创建任务不提供「当前工作区」项目绑定。 */}
            <PaperclipPage onOpenSettings={() => setTab("settings")} />
          </div>
        </main>
      ) : (
        <main className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6 md:px-6">
            <BoardhubModelSettingsSection />
            <PaperclipSettingsSection showAutoClaim={false} />
          </div>
        </main>
      )}
    </div>
  );
}
