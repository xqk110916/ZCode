/**
 * 数据库看板「助手对话」入口：Popover 内输入业务问题，
 * 经 useDbBoardAgent 创建带 db_board MCP 工具集的会话并切回聊天视图。
 */
import { useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DB_BOARD_AGENT_NOT_BOUND_ERROR, useDbBoardAgent } from "@/dbBoard/useDbBoardAgent.js";

export function DbBoardAgentChatEntry(props: {
  workspacePath: string;
  workspaceIdentity?: string;
  username: string;
  onOpenChat: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const agent = useDbBoardAgent({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    username: props.username,
    onOpenChat: props.onOpenChat,
  });

  const submit = async () => {
    const ok = await agent.startChat(question);
    if (ok) {
      setQuestion("");
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" title={intl.formatMessage({ id: "dbboard.agent.chatHint" })}>
          <MessageCircle />
          {intl.formatMessage({ id: "dbboard.agent.chat" })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-3">
        <div className="flex flex-col gap-2">
          <span className="text-ui-sm font-medium">
            {intl.formatMessage({ id: "dbboard.agent.chatTitle" })}
          </span>
          <Textarea
            autoFocus
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={intl.formatMessage({ id: "dbboard.agent.placeholder" })}
            className="min-h-16 text-ui-sm"
          />
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "dbboard.agent.note" })}
          </span>
          {agent.error ? (
            <span className="text-ui-xs text-destructive">
              {agent.error === DB_BOARD_AGENT_NOT_BOUND_ERROR
                ? intl.formatMessage({ id: "dbboard.agent.notBound" })
                : intl.formatMessage(
                    { id: "dbboard.agent.error" },
                    { message: agent.error.slice(0, 120) },
                  )}
            </span>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {agent.starting ? <Spinner className="size-3.5" /> : null}
            <Button
              size="sm"
              disabled={!question.trim() || agent.starting}
              onClick={() => void submit()}
            >
              <Send />
              {intl.formatMessage({ id: "dbboard.agent.send" })}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
