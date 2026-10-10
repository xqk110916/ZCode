import type { IDbBoardService, DbBoardConnectionState } from "../dbBoard/dbBoard.js";
import type { IDbBoardKnowledgeService } from "../dbBoardKnowledge/dbBoardKnowledge.js";
import type { IDbBoardAgentService } from "./dbBoardAgent.js";
import { createDbBoardAgentMcpServerHost } from "./dbBoardAgentMcpServer.js";
import { workspaceBindingKey } from "../dbBoard/dbBoardBindings.js";

/**
 * Node 侧实现（仅 ./node 入口引用）：懒启动 loopback MCP server，
 * 连接摘要与 operator 前缀在此维护。接口契约见 specs/services/db-board-agent.md。
 *
 * 工作区门控卡点：携带 workspaceKey 且连接配置处于严格模式（绑定表非空）时，
 * 未绑定的工作区不发 token（助手会话从根上建不起来）；已绑定则先把激活连接
 * 切到绑定连接（getConnectionState(workspaceKey) 内幂等完成）再返回描述符。
 */
export function createDbBoardAgentService(options: {
  dbBoardService: IDbBoardService;
  dbBoardKnowledgeService: IDbBoardKnowledgeService;
}): IDbBoardAgentService & { dispose(): void } {
  const { dbBoardService, dbBoardKnowledgeService } = options;
  let operatorUsername = "local";
  const host = createDbBoardAgentMcpServerHost({
    dbBoardService,
    dbBoardKnowledgeService,
    getOperatorUsername: () => operatorUsername,
  });

  const connectionLabel = async (): Promise<string> => {
    const [snapshot, connections] = await Promise.all([
      dbBoardService.getConnectionState(),
      dbBoardService.listConnections(),
    ]);
    const active = connections.find((entry) => entry.id === snapshot.activeConnectionId);
    if (active) {
      const label = active.name?.trim() || `${active.host}:${active.port}/${active.database}`;
      return active.env?.trim() ? `${label}（${active.env.trim()}）` : label;
    }
    return snapshot.config
      ? `${snapshot.config.host}:${snapshot.config.port}/${snapshot.config.database}`
      : "未配置";
  };

  return {
    async getMcpServer(params) {
      const username = params.username?.trim();
      if (username) operatorUsername = username;
      const workspaceKey = params.workspaceKey?.trim() || null;
      if (workspaceKey) {
        const bindings = await dbBoardService.getBindings();
        if (bindings.mode === "strict" && !bindings.bindings[workspaceBindingKey(workspaceKey)]) {
          return { available: false, reason: "workspace-not-bound" };
        }
      }
      // 携带 workspaceKey 时先经 getConnectionState 把激活连接拉齐到绑定连接（幂等）。
      const snapshot = await dbBoardService.getConnectionState(workspaceKey ?? undefined);
      const endpoint = await host.start();
      let state: DbBoardConnectionState = snapshot.state;
      let label = "未配置";
      try {
        label = await connectionLabel();
      } catch {
        // 连接摘要失败不阻断会话创建；导语里按未连接处理。
      }
      return {
        available: true,
        server: { name: "db_board", url: endpoint.url, token: endpoint.token },
        connection: { state, label },
      };
    },
    dispose() {
      host.dispose();
    },
  };
}
