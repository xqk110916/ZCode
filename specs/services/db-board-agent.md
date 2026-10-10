# 数据库助手 Agent（db-board-agent）

数据库看板的对话智能体入口：把既有 `IDbBoardService` / `IDbBoardKnowledgeService` 的能力封装为一个
MCP server，供 ZCode 会话（以及后续任何 AI 产品，见 Phase 3 规划）以标准工具面消费。行为基准见
`specs/services/db-board.md` 与 `specs/services/db-board-knowledge.md`；本文只定义 agent 层的封装规则。

## 产品规则

- 用户在数据库看板面板通过「对话」入口向数据库助手提问；助手是一个普通 ZCode 会话，
  附加 `db_board` MCP 工具集（14 个工具），以知识库优先的方式回答业务数据问题。
- 助手**永不删除数据**：工具面没有删除工具；insert/update 由既有服务在目标库同事务写审计日志。
- 回退（rollback）是面板「操作日志」tab 的专属能力，agent 工具面不提供，也不引导用户绕过确认。
- 连接管理（新建/切换/测试连接）留在面板；助手会话跟随宿主当前激活连接，不提供切换工具，
  用户要求切换时引导回面板。
- 写操作（insert/update）必须两步确认：助手先在对话中展示变更预览（目标表、行、列的新旧值），
  获得用户明确同意后才调用写工具。该约束由人格导语 + 工具描述共同承载（prompt 层约束），
  服务端仍以审计日志 + 无删除接口为硬边界。
- 写入的审计 operator 固定为 `"<用户名> via db-agent"`，由宿主在 server 启动/调用侧注入，
  不接受工具参数覆盖。

## 状态所有者与边界

- **MCP server 属于宿主进程**（desktop main / web server 的 services host）：
  - 复用同一份 `dbBoardService` / `dbBoardKnowledgeService` 实例（连接池、目录缓存、知识库 JSON、
    dashboard resource_kv store、`generateWorkspaceText` 模型链路都只有这一份所有者）；
  - 监听 `127.0.0.1` 随机端口的 HTTP MCP 端点（Streamable HTTP、无会话状态），
    鉴权为随机 Bearer token，仅返回给本宿主的 UI；
  - 懒启动：首次 `getMcpServer()` 才监听；宿主 dispose 时关闭。
- **会话创建走 v4 `createSession` 命令**（UI 经 `sendConversationCommandV4` 直发）：
  payload 携带 `mcpServers: [db_board 描述符]` 与 `firstInput`（人格导语 + 用户问题）。
  这是协议原生能力，不改动 composer/draft/prewarm 等官方链路。
- **人格导语作为首条用户消息**进入会话历史：自描述、可审计，冷恢复后人格语义仍在
  （MCP 工具面冷恢复不自动重建，属已知限制，见下）。
- 工具命名最终表现为 `mcp__db_board__<tool>`（CLI 的 MCP 工具命名规则）。

## 接口

`IDbBoardAgentService`（channel `db-board-agent`，注册链同 db-board 扩展点）：

- `getMcpServer(params: { username?: string; workspaceKey?: string }): Promise<DbBoardAgentMcpInfo>`
  - 懒启动 loopback MCP server；返回 `{ available, reason?, server?, connection? }`。
  - **工作区门控卡点**：携带 `workspaceKey` 且连接配置处于严格模式（绑定表非空）时，未绑定的工作区返回
    `available:false, reason:"workspace-not-bound"`——不发 token，助手会话从根上建不起来；已绑定则先把激活连接
    切到绑定连接（幂等）再返回描述符。不携带 `workspaceKey` 的调用（服务端脚本/测试）不做门控。
  - `username` 用于审计 operator 前缀（与面板 operator 同源）；缺省 `local`。
  - `connection` 为当前激活连接摘要（state + 显示名），供人格导语标注「当前连接」。

MCP 工具面（14 个，输入为 JSON Schema，输出为 markdown 文本）：

| 工具 | 参数（概） | 说明 |
| --- | --- | --- |
| `list_tables` | `force?` | 表清单（注释中文名优先）+ 知识域索引 |
| `get_table_columns` | `schema, table` | 列元数据（类型/注释/主键/默认值） |
| `query_rows` | `schema, table, search_column?, search_value?, page?, page_size?` | 分页浏览（单列模糊搜索；精确过滤走 SQL 工具） |
| `run_readonly_sql` | `sql, max_rows?` | 只读 SELECT：READ ONLY 事务 + 单语句包装 + 行上限（服务端强制） |
| `get_table_card` | `table` | 知识卡（用途/关键字段/关联/前端证据） |
| `search_knowledge` | `keywords` | 按关键词检索知识域与表卡 |
| `insert_row` | `schema, table, values` | 新增（operator 服务端强制；返回行 + 审计 logId） |
| `update_row` | `schema, table, pk, values` | 修改（同上；pk 必须覆盖全部主键列） |
| `generate_dashboard` | `question, previous_dashboard_id?, revision_note?` | 生成/修订看板 spec（含每图 SQL）；修订经 id 取回上一版 |
| `save_dashboard` | `spec` | 保存看板定义（resource_kv） |
| `list_dashboards` | — | 已存看板清单 |
| `distill_table_card` | `schema, table` | 单表知识蒸馏（不落盘，返回卡片内容） |
| `save_table_card` | `card` | 保存知识卡（域/用途/关键字段/关联） |
| `list_op_logs` | `schema?, table?, page?, page_size?` | 审计日志（含 via db-agent 标记的写入） |

明确**不提供**：delete、rollback、连接管理（save/delete/setActive/test）、知识库构建流水线
（构建/探测属于面板重操作）、`explainQuery`（解释由会话模型自己完成）。

## 事件顺序

```text
面板输入问题
  → UI: dbBoardAgent.getMcpServer({username})          # 懒启动 server，拿 url/token/连接摘要
  → UI: sendConversationCommandV4(createSession        # mcpServers=[db_board], firstInput=导语+问题
       { workspaceId, mcpServers, firstInput })
  → 宿主信封增强（feature flags，既有逻辑）→ CLI v4-bridge → createRecord
       runtimeConfig.mcp = { servers: { db_board: {type:http, url, headers} } }
  → CLI MCP 客户端连接 loopback 端点 → listTools → 注册 mcp__db_board__*
  → firstInput 首轮：模型按导语与工具描述作答（查询走只读工具；写入先预览确认）
  → UI: setActiveTaskId(sessionId) + 切回聊天主视图
工具调用（CLI → loopback HTTP → MCP server）
  → 校验 Bearer token → 分发到 dbBoardService/dbBoardKnowledgeService
```

写入路径的幂等与审计语义完全继承 `specs/services/db-board.md`（同事务审计、乐观校验、补偿日志），
agent 层不新增状态。

## 绑定工作区的自动附加

- 宿主在 v4 `createSession` 信封处（与 Off-Peak/动态工作流同一注入面）按 `payload.workspaceId` 解析：
  严格模式下已绑定的工作区，普通会话（用户直接在聊天里新建的任务）自动附加 db_board MCP 描述符——
  未绑定或 legacy 模式不注入；payload 已带 db_board（面板「对话」入口）时按名字去重。
- 解析失败按不注入处理（fail-open 只影响数据库工具面）；注入的工具面安全边界不变（无删除/审计/只读强制）。
- 冷恢复的既有限制同样适用：CLI 重启后恢复的会话不自动重挂工具。

## 安全不变量

- server 只绑 `127.0.0.1`；随机端口 + 随机 Bearer token；token 不落日志、不进提示词。
- 凭据（数据库/Nacos 密码）只存在于 credentialService；工具参数、工具输出、人格导语中均不出现。
- 只读 SQL 的强制项（READ ONLY、单语句、行上限、statement_timeout）在 `dbBoardService.runDashboardSql`
  服务端执行，agent 层不复检也不放宽。
- 写工具忽略调用方传入的任何 operator 字样参数，operator 由宿主注入。

## 已知限制（Phase 1）

- 冷恢复：CLI 重启后恢复 db 助手会话不自动重挂 MCP 工具（v4 resume 参数不携带），历史与导语仍在，
  助手可继续对话但工具面缺失；需要工具时引导用户新建对话。Phase 1.5 若引入协议级 persona 字段可解。
- 单激活连接：会话跟随宿主当前激活连接；面板切换连接后，同一会话内下一次工具调用即用新连接，
  助手回答时应按工具返回的连接摘要自校准（导语要求标注连接名）。
- 每宿主一个 MCP server 实例、单一 operator 前缀（单用户桌面/单人 web 场景）。

## 验收场景

1. 面板提问「今年产生了多少收发文」→ 会话创建成功，回答引用 oa_doc 知识卡，SQL 含 `::timestamp`
   显式转换，结果以 markdown 表格呈现并标注当前连接名。
2. 要求修改数据 → 助手先给出目标行与新旧值预览并询问确认；确认后写入成功，操作日志出现
   `用户名 via db-agent` 条目；拒绝则不发生任何写调用。
3. 要求删除数据 / 回退 / 切换连接 → 助手拒绝并说明边界（删除永不可用；回退去面板操作日志 tab）。
4. `run_readonly_sql` 提交非 SELECT（或带分号的多语句）→ 服务端拒绝，无副作用。
5. 生成看板 → 图表 SQL 展示给用户，`save_dashboard` 后面板「探索看板」出现该看板。
6. 未配置连接时提问 → `getMcpServer` 返回 connection.state=disconnected，导语包含引导配置提示，
   工具调用返回连接错误并由助手转述。
