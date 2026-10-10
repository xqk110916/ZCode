# 数据库看板：数据操作 + 探索看板（db-board）

内部数据库操作台。一个主视图（Web / 桌面同入口），三个 tab：

- **探索看板**：参照《Claude-Dashboards-需求文档.docx》（仓库根目录）的最小复刻口径——自然语言问题 → 模型生成只读 SQL + 图表定义 → 只读事务执行 → 图表 + 查询抽屉 + 刷新时间 + 页内对话修订 + SQL/CSV 导出。不做 BI 对接、CMEK、自动调度（需求文档 11.2 边界）。
- **数据浏览**：对目标库（Kingbase8 `hbt_test`，PG 线协议兼容、非 SSL）做 查询 / 新增 / 修改，**禁止删除**；每次增改同事务写审计日志，支持基于日志回退。
- **操作日志**（独立 tab）：审计日志列表 + 变更列 diff + 回退；支持"全部表 / 仅当前选中表"筛选，回退成功后数据浏览侧状态由共享 hook 统一刷新。

## 产品规则

- **删除永不暴露**：`IDbBoardService` 接口层没有任何 delete 数据行的方法；UI 无删除按钮。回退一条 insert 日志的唯一逆操作是按 PK 删行——该 DELETE 只存在于回退事务内部，且仅由 rollback 入口触发。
- **增改必须留痕**：insert/update 与审计日志写入同一目标库事务（update 先 `SELECT ... FOR UPDATE` 取 before 快照）。日志表：`zcode_db_board_op_log`（首次连接成功时 `CREATE TABLE IF NOT EXISTS`），字段含 op_type(insert/update)、schema/table、pk_json、before_json、after_json、status(active/rolled_back)、rolled_back_at、rollback_of。审计表本身不出现在表浏览器中，只能通过日志接口读取。
- **回退规则**：
  - 仅 status=active 的日志可回退；
  - 回退 update（需精确恢复值）：同一行存在 id 更大的 active 日志（含补偿）时必须先回退新日志，且乐观校验当前行值与 after_json 一致，不一致报冲突；
  - 回退 insert（删行，与当前值无关）：只被同一行 id 更大的**非补偿**日志（rollback_of 为空的用户真实操作）阻挡——否则补偿链会让最初的新增永远无法回退；删行时该行残留的 active 补偿日志一并标记 rolled_back；
  - 回退在事务内：执行逆操作 → 原日志标记 rolled_back → 写补偿日志（insert 回退的补偿 = 一条 after 为被删行的 insert 型日志；update 回退的补偿 = before/after 对调的 update 日志），因此回退本身可审计、可再回退。回退"补偿 insert"= 按快照重新插入该行（undo 的 undo = redo），与"回退原始 insert = 删行"以 rollback_of 是否为空区分。
- **SQL 安全**：表/列标识符必须先通过元数据白名单校验再双引号插值；值一律 `$n` 参数化；仅单语句。数据浏览分页 pageSize ≤ 200。
- **探索看板只读强制**：模型生成的 SQL 在 `BEGIN TRANSACTION READ ONLY` 中执行，叠加 `statement_timeout`、行上限（默认 1000）、外包装 `SELECT * FROM (<sql>) _sub LIMIT <n>`（多语句必然语法错误）与语句头校验（必须 SELECT/WITH 开头）。
- **看板是活的工件**：看板定义持久化（custom-resources sqlite `resource_kv`，key `db-board-dashboard:<id>`），可回来编辑；看板定义的删除是应用态资源管理（同自动化），与"禁止删除数据行"无关。
- **数字必须能被打开**：每张图绑定可查看的 SQL 与上次刷新时间；失败保留上次成功数据并标注失败（不静默冒充新数据）；支持"解释此查询"。修订走页内对话：携带 previousSpec 重新生成，查询与刷新时间同步更新。
- **无中生有禁止**：未连接/元数据不可用/生成失败时明确报错，不产出"看起来有数"的空图。
- **能力边界**：无主键表仅支持查询；视图（非 BASE TABLE）不列出；bytea/数组类型列在增改表单中只读。
- **连接入口时序**：所有数据操作入口经 `ensurePool` 先 `await loadConfigFile()` 再判配置——面板挂载时状态查询与数据查询并发，后者先到不得把"配置未加载"误报为"尚未配置连接"。
- **表清单缓存**：`listTables()` 进程内缓存（连接切换/保存配置失效），`listTables(true)` 强制回源；UI 表列表刷新按钮走 force，避免每次打开面板重复查库。
- **工作区绑定（准入控制，轻量版语义）**：连接配置 v3 增加 `bindings: Record<workspaceKey, connectionId>`（workspaceKey 统一为 `workspaceIdentity?.trim() || workspacePath`）。**绑定键统一为 `workspaceIdentity || workspacePath`，存取两侧按归一化形态匹配（正斜杠统一为反斜杠 + 小写，Windows 路径形态容错；解绑按归一化匹配删除，兼容历史原样键）**；绑定表非空即「严格模式」**：只有绑定了连接的工作区可以使用数据库看板/数据库助手，未绑定工作区面板显示空态引导、`getMcpServer` 不发 token；**绑定表为空即「legacy 模式」**：所有工作区可用（v1/v2 配置迁移后即此模式，行为与旧版完全一致，首次创建绑定才进入严格模式，清空最后一条绑定回到 legacy）。激活连接仍是全局单份（轻量版取舍，多窗口并发时后打开者生效）：`getConnectionState(workspaceKey?)` 在严格模式且该工作区已绑定时，若当前激活连接与绑定不一致则自动切到绑定连接（幂等，供面板打开与周期对账调用）；`setBinding(workspaceKey, connectionId|null)` 校验连接存在后 upsert（null 解绑），绑定/解绑立即落盘并同步激活。数据面另有**服务端校验**：所有触库方法（元数据/浏览/写入/审计/看板生成与执行/汇总）接受可选 `workspaceKey`，严格模式下未绑定的工作区调用直接拒绝（错误码 `workspace-not-bound`）；**无 key 调用不门控**（服务端脚本、知识库服务内部调用、MCP 工具内部调用——助手侧准入由 getMcpServer 发 token 卡点承担）。renderer 自报 workspaceKey 与 operator 同级 advisory（防接线错误与误用，不是对抗性边界）；数据侧硬边界仍是无删除/只读事务/审计。连接管理面（save/delete/setActive/list/test/bindings）不校验——blocked 工作区需要能完成绑定自救。
- **使用情况汇总（知识库汇总看板的数据源）**：`getUsageSummary({compute?, force?})` 返回全库表数、知识覆盖表数、业务域数与「常用业务表」清单（知识覆盖表中行数 ≥1000 的前 20 张，按行数降序；行数是活跃度近似）。行数来自逐表 `count(*)`（Kingbase V8R3 Oracle 兼容模式实测 `all_tables.num_rows` 恒为 0、`pg_class`/`information_schema.tables.table_rows` 均不可用，无统计快表可走）：有界并发 6、每表独立事务 `SET LOCAL statement_timeout 8s`、失败/超时的表记为未知并跳过。**不自动计算**：`compute=false` 只读缓存（缺省 null），`compute=true` 才执行计数；`force=true` 绕过缓存重算。缓存随连接切换/配置保存失效（与表清单缓存同口径），并按连接 id 持久化到 `~/.zcode/v2/db-board-usage.json`（`{connectionId: summary}`，含全量 rowCounts）——进程重启后首次只读时从磁盘恢复（先 loadConfigFile 再取激活连接），避免数据浏览排序随重启失效；重新生成覆盖写回。
- **凭据**：密码存 credentialService（key `db-board:password`），连接配置存 `~/.zcode/v2/db-board.json`（原子写）；凭据不进 git、不落日志。operator 由客户端自报（web OAuth 用户名，缺省 `local`）——服务端为共享令牌鉴权，operator 字段为 advisory 审计信息，不可作为安全边界。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 连接配置（多连接列表 + 激活项 + 工作区绑定，v3 `{version, connections[], activeConnectionId?, bindings?}`；旧单份格式加载时自动迁移为 id="default"，v2 迁移后 bindings 为空 = legacy 模式） | dbBoardService | `~/.zcode/v2/db-board.json` |
| 连接密码（每连接一份，key `db-board:password:<id>`；default 连接回退旧 key） | credentialService | `~/.zcode/v2/credentials.json`（加密） |
| pg 连接池 | dbBoardService | host 进程内（配置变更时重建） |
| 表/列元数据缓存（TTL 30s） | dbBoardService | host 进程内 |
| 业务数据行事实 | 目标库 | Kingbase hbt_test |
| 审计日志 | dbBoardService（独占写入） | 目标库 `zcode_db_board_op_log` |
| 看板定义 | dbBoardService | custom-resources.sqlite `resource_kv` |
| 看板运行态（刷新时间/错误/数据快照/生成进度） | UI 模块级 persistent state | renderer 内存（切 tab/主视图保留，刷新页面重置，不落盘） |
| 使用情况汇总（行数统计） | dbBoardService | 内存缓存 + `~/.zcode/v2/db-board-usage.json`（按连接 id） |

## 接口

- Channel：`ServiceChannels.DbBoard = "db-board"`（`packages/shared/src/channels.ts`）。
- 接口与类型：`packages/services/src/dbBoard/dbBoard.ts`（browser-safe），实现 `dbBoardService.ts`（node-only），注册于 `packages/services/src/node.ts`。
- `IDbBoardService`：
  - 连接：`getConnectionState()` / `getConnectionConfig()`（不含密码）/ `saveConnection(config)` / `testConnection(config)`
  - 工作区绑定：`getBindings()` → `{mode: "legacy"|"strict", bindings}` / `setBinding({workspaceKey, connectionId|null})` / `getConnectionState(workspaceKey?)`（快照含 `workspaceAccess: "legacy"|"bound"|"blocked"` 与 `boundConnectionId?`，见上方规则）
  - 元数据：`listTables()` / `getTableColumns(schema, table)`
  - 使用情况汇总：`getUsageSummary({compute?, force?})` → `DbBoardUsageSummary | null`（见上方规则）
  - 数据浏览：`queryRows({schema, table, page, pageSize, searchColumn?, searchValue?})` / `insertRow({schema, table, values, operator})` / `updateRow({schema, table, pk, values, operator})` / `listOpLogs({schema?, table?, page, pageSize})` / `rollback({logId, operator})`
  - 探索看板：`generateDashboard({question, previousSpec?, locale?})` / `runDashboardSql({sql})` / `explainQuery({sql, chartTitle, question?})` / `listDashboards()` / `saveDashboard(spec)` / `deleteDashboardDefinition(id)`
- Dashboard spec：`{ id, title, question, charts: [{ id, title, type: bar|line|pie|kpi|table, sql, description, columnHints? }], revisionHistory: string[], updatedAt }`，zod 校验。
- UI：`packages/ui/src/dbBoard/`（页面与子组件、`useDbBoard` / `useDbBoardDashboards` hooks）；主视图 `WorkspaceMainView = "db-board"`；侧边栏入口沿用 paperclip 模式。页头为 line tabs + 连接条（无重复大标题）；数据浏览表列表两行（表名 + 中文用途）；操作日志筛选进面板头，tab 不再单独放提示行。
- 生成链路：复用 `zcodeAgentService.generateWorkspaceText`（workspace 取 `getConversationWorkspaceDir()`），模型取 `providerRuntime.modelSelection.getView().preferredSelection`，无选中模型明确报错；querySource `db_board_dashboard`。
- 日志：`createServiceLogger("dbBoard")`，info 记录连接/增改/回退/生成生命周期，密码等凭据不落日志。

## 数据流与事件顺序

insert / update（同一事务）：

```
client → insertRow/updateRow
  1. 校验连接与元数据白名单（标识符）
  2. BEGIN
  3. update: SELECT * WHERE pk FOR UPDATE  → before 快照
  4. INSERT/UPDATE ... RETURNING *          → after 快照
  5. INSERT INTO zcode_db_board_op_log (...)
  6. COMMIT → 返回行数据 + logId
```

rollback（同一事务）：

```
client → rollback(logId)
  1. 读日志行，status 必须 active
  2. 检查同行无更大 id 的 active 日志（按行逆序）
  3. BEGIN
  4. insert 型：按 PK 定位行（不存在→冲突），DELETE
     update 型：SELECT FOR UPDATE 取当前值，乐观校验 == after_json（不一致→冲突），UPDATE 恢复 before
  5. 原日志置 rolled_back + rolled_back_at
  6. 写补偿日志（rollback_of = 原日志 id）
  7. COMMIT → 返回补偿日志 id
```

看板生成：

```
client → generateDashboard(question[, previousSpec, revisionNote])
  1. 读连接与表/列元数据（超量截断，提示点名表）
  2. preferredSelection 取当前模型（缺失→model-unavailable 报错）
  3. generateWorkspaceText：prompt = 元数据摘要 + 图表 JSON schema + 修订上下文
  4. zod 校验输出（失败重试一次）；逐图校验 SQL 语句头（SELECT/WITH）
  5. 返回 dashboard spec（UI 逐图调 runDashboardSql 渲染）
```

## 验收场景

1. 配置连接（测试连接通过）后，数据浏览列出业务表与列；审计表与系统表不可见。
2. 对有主键表新增一行：返回新行，操作日志新增一条 insert 记录（before 为空）。
3. 修改该行：日志记录 before/after，值与库中事实一致。
4. 回退 update 日志：行恢复 before 值；原日志 rolled_back；出现补偿日志。
5. 回退 insert 日志：行被移除（仅此路径可删行）；补偿日志可再回退（行恢复）。
6. 对同一行存在未回退的新日志时，回退旧日志被拒绝并提示先回退新日志。
7. 无主键表：可查询，新增/修改被拒绝。
8. 接口层与 UI 全程无删除数据行入口。
9. 探索看板：输入问题句生成 ≥1 张图；每图可查看 SQL 与刷新时间。
10. 修订指令（如"改成按周"）后 SQL 与图同步更新。
11. 某图 SQL 失败：保留上次成功数据并标注失败；单图可重试。
12. 看板保存后重新打开：定义完整；删除看板仅删定义，不动数据。
13. 未配置模型/未连接数据库时：明确报错，无空图。
