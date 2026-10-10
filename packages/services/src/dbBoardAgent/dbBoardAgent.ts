import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { DbBoardConnectionState } from "../dbBoard/dbBoard.js";

/**
 * 数据库助手 Agent（browser-safe 接口层）。
 *
 * 行为契约见 specs/services/db-board-agent.md。核心不变量：
 * - MCP server 属于宿主进程，懒启动，只绑 127.0.0.1 + 随机 Bearer token；
 * - token 只返回给本宿主 UI，不落日志、不进提示词；
 * - 写入 operator 由宿主注入（"<用户名> via db-agent"），不接受外部覆盖。
 */

export interface DbBoardAgentMcpServerDescriptor {
  name: "db_board";
  /** loopback MCP 端点（Streamable HTTP）。 */
  url: string;
  /** Bearer token（Authorization header 值为 "Bearer <token>"）。 */
  token: string;
}

export interface DbBoardAgentConnectionSummary {
  state: DbBoardConnectionState;
  /** 展示名：name（env）或 host:port/database。 */
  label: string;
}

/** 未可用原因：workspace-not-bound（严格模式下该工作区未绑定连接）。 */
export type DbBoardAgentUnavailableReason = "workspace-not-bound";

export interface DbBoardAgentMcpInfo {
  /** false 时无 server/connection，reason 说明原因（工作区门控）。 */
  available: boolean;
  reason?: DbBoardAgentUnavailableReason;
  server?: DbBoardAgentMcpServerDescriptor;
  connection?: DbBoardAgentConnectionSummary;
}

export interface IDbBoardAgentService {
  /**
   * 懒启动 MCP server 并返回描述符 + 当前连接摘要。
   * 携带 workspaceKey 且处于严格模式时：未绑定工作区 available=false（不发 token）；
   * 已绑定先把激活连接切到绑定连接再返回。username 用于审计 operator 前缀。
   */
  getMcpServer(params: {
    username?: string;
    workspaceKey?: string;
  }): Promise<DbBoardAgentMcpInfo>;
}

export const IDbBoardAgentService = createServiceDescriptor<IDbBoardAgentService>(
  ServiceChannels.DbBoardAgent,
);
