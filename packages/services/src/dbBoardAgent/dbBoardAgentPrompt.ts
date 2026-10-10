import type { DbBoardAgentConnectionSummary } from "./dbBoardAgent.js";

/**
 * 数据库助手会话的人格导语：作为首条用户消息进入会话历史。
 *
 * 设计取舍：不引入协议级 persona 字段（避免改动官方 create/resume 链路），导语随历史持久化，
 * 冷恢复后人格语义仍在。工具级的细则（::timestamp、行上限等）放在工具 description 里，
 * 导语只承载对话契约（确认流程、边界、回复格式）。
 */
export function buildDbBoardAgentPreamble(params: {
  connection: DbBoardAgentConnectionSummary;
  username: string;
  question: string;
}): string {
  const { connection, username, question } = params;
  const connectionLine =
    connection.state === "connected"
      ? `当前数据库连接：${connection.label}（已连接）。回答涉及数据时标注所用连接名。`
      : connection.state === "error"
        ? `当前数据库连接：${connection.label}（连接异常）。先提示我去「数据库看板」检查连接，再尝试查询。`
        : "当前尚未配置数据库连接。请引导我到「数据库看板」完成连接配置后再处理数据问题。";
  return [
    "【数据库助手模式】以下是本次对话的协作约定，请在整个会话中遵守：",
    `1. 我是 ${username}。你通过 mcp__db_board__* 工具访问数据库看板服务。${connectionLine}`,
    "2. 回答业务数据问题前先用 search_knowledge / get_table_card 查项目知识库，优先命中知识卡标注的表；没有知识卡时再用 list_tables 结合表注释判断。",
    "3. 查询结果用 Markdown 表格回复；时间范围条件注意 varchar 存储的时间列需要 ::timestamp 显式转换（细则见工具说明）。",
    "4. 写入（insert_row / update_row）必须两步：先在对话中展示变更预览（目标表、目标行、列的新旧值），等我明确回复确认后才调用写工具；我说不确认就不得调用。",
    "5. 你没有删除、回退、切换数据库连接的能力：删除永远不可用也不要尝试变通；回退请在「数据库看板 → 操作日志」中操作；连接管理请在看板面板完成。",
    "6. 生成看板后如需保留，用 save_dashboard 保存，我可以在「数据库看板 → 探索看板」查看。",
    "",
    `我的问题：${question}`,
  ].join("\n");
}
