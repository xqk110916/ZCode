/**
 * useDbBoardAgent —— 数据库看板「助手对话」入口的数据 hook。
 *
 * 流程（见 specs/services/db-board-agent.md）：
 * 1. dbBoardAgentService.getMcpServer 懒启动宿主 loopback MCP server；
 * 2. 经 v4 createSession 命令直接建会话：payload 携带 mcpServers 描述符与
 *    firstInput（人格导语 + 用户问题），与 composer 首发同构，不改动官方 draft 链路；
 * 3. ACK 拿到 sessionId 后 setActiveTaskId 聚焦并切回聊天主视图。
 */
import { useCallback, useState } from "react";
import { buildDbBoardAgentPreamble } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";

/** db_board 工具单次调用上限：覆盖看板生成/单表蒸馏这类长调用（180s 生成链路 + 余量）。 */
const DB_BOARD_MCP_TIMEOUT_MS = 240_000;

export interface UseDbBoardAgentParams {
  workspacePath: string;
  workspaceIdentity?: string;
  username: string;
  onOpenChat: () => void;
}

/** getMcpServer 拒发的原始原因码；UI 层负责本地化。 */
export const DB_BOARD_AGENT_NOT_BOUND_ERROR = "workspace-not-bound";

export interface UseDbBoardAgentState {
  starting: boolean;
  error: string | null;
  startChat: (question: string) => Promise<boolean>;
}

export function useDbBoardAgent(params: UseDbBoardAgentParams): UseDbBoardAgentState {
  const { workspacePath, workspaceIdentity, username, onOpenChat } = params;
  const services = useServices();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startChat = useCallback(
    async (question: string): Promise<boolean> => {
      const trimmed = question.trim();
      if (!trimmed || starting) return false;
      const dbBoardAgent = services.dbBoardAgentService;
      if (!dbBoardAgent || !services.zcodeAgentService) {
        setError("service-unavailable");
        return false;
      }
      setStarting(true);
      setError(null);
      try {
        const info = await dbBoardAgent.getMcpServer({
          username,
          workspaceKey: workspaceIdentity?.trim() || workspacePath,
        });
        if (!info.available || !info.server || !info.connection) {
          setError(info.reason ?? "unavailable");
          return false;
        }
        const preamble = buildDbBoardAgentPreamble({
          connection: info.connection,
          username,
          question: trimmed,
        });
        const workspaceKey = workspaceIdentity?.trim() || workspacePath;
        const envelope = createCommandEnvelope({
          type: "createSession",
          sessionId: null,
          payload: {
            workspaceId: workspaceKey,
            firstInput: { text: preamble },
            mcpServers: [
              {
                name: info.server.name,
                type: "http",
                url: info.server.url,
                headers: [
                  { name: "Authorization", value: `Bearer ${info.server.token}` },
                ],
                isolation: "session",
                timeoutMs: DB_BOARD_MCP_TIMEOUT_MS,
              },
            ],
          },
        });
        const ack = await services.zcodeAgentService.sendConversationCommandV4({
          workspacePath,
          ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
          envelope,
        });
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          logger.warn("[db-board-agent] createSession 被拒", {
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
            message: ack.message ?? null,
          });
          setError(ack.message || ack.reasonCode || ack.status);
          return false;
        }
        const sessionId = ack.result.sessionId;
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(workspacePath, sessionId, workspaceIdentity?.trim() || undefined);
        onOpenChat();
        return true;
      } catch (caught) {
        logger.warn("[db-board-agent] 会话创建失败", {
          error: caught instanceof Error ? caught.message : String(caught),
        });
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      } finally {
        setStarting(false);
      }
    },
    [onOpenChat, services, starting, username, workspaceIdentity, workspacePath],
  );

  return { starting, error, startChat };
}
