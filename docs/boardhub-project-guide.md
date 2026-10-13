# BoardHub 项目指南 —— 数据库看板 + 任务编排独立应用（完整实现文档）

> 本文档面向想要**不基于 ZCode、用其他技术栈或其他 Agent 重新实现一个同类项目**的工程师。
> 内容涵盖产品定义、总体架构、数据模型、安全边界、Agent 集成协议（MCP）、关键设计决策与
> 移植指南。文中的实现细节均来自真实可运行的代码库（本仓库 `packages/boardhub-*` 与
> `packages/services`），不是概念设计。

---

## 1. 项目概述

### 1.1 一句话定位

**BoardHub 是一个脱离任何特定 AI 编程工具的独立应用：左侧是"数据库看板"（让 AI 安全地读
你的业务数据库、生成分析看板、沉淀业务知识），右侧是"任务编排"（把开发任务派发给任意
Agent CLI 执行并追踪状态）。**

### 1.2 解决什么问题

- 业务数据库（如 Kingbase/PostgreSQL/MySQL）有几百张表，新人/AI 都不懂表结构和中文字段
  含义 → 需要**代码感知的知识库**（从 Java/Vue 源码蒸馏出"这张表是谁在用、什么业务"）。
- 想让 AI 改数据但又怕它删库 → 需要**无删除、可回退、全审计**的数据面安全边界。
- 想用自然语言生成经营分析图表 → 需要**NL → SQL → 图表**的看板生成管线。
- 想把"修一个 bug / 跑一个数据订正"作为任务派给 Claude/Grok/ZCode 等 Agent 并追踪
  → 需要**任务编排协议**（issue → agent 认领 → run 执行 → 审查完成）。

### 1.3 核心能力清单

| 能力 | 说明 |
| --- | --- |
| 多连接管理 | 多个数据库连接配置（host/port/db/用户名），密码加密存储，连接测试 |
| 数据浏览 | 表清单（中文名 + 行数排序）、分页浏览、列搜索 |
| 只读 SQL | READ ONLY 事务 + 单语句 + 行上限，服务端强制 |
| 安全写入 | insert/update 走事务 + 前后快照 + 审计日志；**全系统不存在删除能力** |
| 操作回退 | 每条写操作生成逆向 SQL，面板内一键回退（回退本身也审计） |
| 探索看板 | 自然语言生成多图看板（bar/line/pie/kpi/table），可修订、可手动刷新 |
| 业务知识库 | 扫描本地代码仓库 → 表知识卡（中文用途、关联页面/API）+ 数据库概览 |
| 代码图谱 | 方法级知识图谱：影响分析 / 硬编码检测 / 特殊情况标注 |
| 任务编排 | 对接 Paperclip 协议：issue CRUD、agent 配置、执行流追踪 |
| AI 模型自配 | OpenAI 兼容端点直连（baseUrl/modelId/apiKey），不绑定任何厂商账号 |

---

## 2. 总体架构

### 2.1 进程拓扑（桌面形态）

```
┌─────────────────────────────────────────────────────────┐
│ Electron 主进程（极简壳，~280 行）                        │
│  · utilityProcess.fork 拉起服务端子进程                   │
│  · 端口协商：读子进程 stdout 的 READY 协议行               │
│  · BrowserWindow.loadURL("http://127.0.0.1:{port}")      │
│  · 崩溃自愈：退避序列 [1s,5s,15s] 重启服务端并重载窗口      │
└────────────┬──────────────────────────────┬─────────────┘
             │ stdout: BOARDHUB_SERVER_READY │ loadURL
             ▼                              ▼
┌─────────────────────────┐   ┌──────────────────────────────┐
│ 服务端（Node，单文件 bundle）│   │ 前端（静态资源，同源托管）      │
│  · HTTP + WebSocket RPC  │   │  · React SPA，三 Tab 布局     │
│  · 7 个业务服务（DI 容器） │◄──┤  · WS 直连同源 /ws           │
│  · 静态托管前端产物        │   └──────────────────────────────┘
│  · 数据根 ~/.boardhub     │
└───────────┬─────────────┘
            │ pg 驱动（连接池）
            ▼
   业务数据库（Kingbase / PostgreSQL / MySQL…）
```

Web 形态 = 去掉 Electron 壳：服务端直接跑（`PORT` 默认 3210），前端 vite dev 或静态托管，
浏览器访问。**桌面与 Web 共用同一个数据根 `~/.boardhub`**，可同时开（有跨进程文件锁保护）。

### 2.2 三层职责划分

| 层 | 技术 | 职责 | 代码量级 |
| --- | --- | --- | --- |
| 桌面壳 | Electron 41（main 进程） | 进程管理、端口协商、窗口、崩溃自愈 | ~280 行 |
| 服务端 | Node + Hono(HTTP) + 自研 WS RPC + DI 容器 | 全部业务逻辑、数据库访问、AI 调用、MCP server | 核心 ~8000 行 |
| 前端 | React 19 + vite + Tailwind 风格组件库 | 三 Tab SPA，全部状态来自服务端 RPC | ~400 行骨架 + 复用组件 |

**关键原则：服务端不依赖任何 AI 编程工具的账号/运行时**。AI 能力经"OpenAI 兼容端点直连"
或"MCP server 暴露给外部 Agent"两种方式接入，与宿主解耦。

---

## 3. 服务端设计

### 3.1 服务装配（依赖注入容器）

服务端入口的核心是组装 7 个服务（ZCode 实现位于 `packages/boardhub-server/src/entry.ts`，
用 `ServiceCollection` 做 DI；移植时可用任意 DI 或直接手工构造传参）：

```ts
setDataBaseDir(join(homedir(), ".boardhub"));     // 数据根隔离，必须在最前
settingService     = createSettingService();       // 应用设置（JSON 落盘）
credentialService  = createCredentialService();    // 凭据（AES-256-GCM 加密落盘）
broadcastService   = createBroadcastService(null); // 进程内事件广播
model              = createBoardhubModelRuntime({ settingService, credentialService });
dbBoardService     = createDbBoardService({ credentialService, loadKnowledge,
                                            readCurrentModel: model.readCurrentModel,
                                            generateText: model.generateText });
dbBoardKnowledgeService = createDbBoardKnowledgeService({ credentialService, dbBoardService, ...model });
dbBoardAgentService     = createDbBoardAgentService({ dbBoardService, dbBoardKnowledgeService });
paperclipService    = createPaperclipService({ settingService, credentialService }); // 纯 REST/WS 客户端

services = new ServiceCollection()
  .register(ISettingService, settingService)
  .register(ICredentialService, credentialService)
  .register(IBroadcastService, broadcastService)
  .register(IDbBoardService, dbBoardService)
  .register(IDbBoardKnowledgeService, dbBoardKnowledgeService)
  .register(IDbBoardAgentService, dbBoardAgentService)
  .register(IPaperclipService, paperclipService);

createHttpServer(services, port /* 默认 3210，0=随机 */, {
  host: "127.0.0.1",           // 只绑回环，见安全章节
  staticRoot, spaFallback: true,
  authToken,                    // 可选；本机形态默认无（回环即边界）
});
```

依赖关系（单向，无环）：`credential/setting → model → dbBoard → knowledge → agent`；
paperclip 只依赖 setting/credential（外部进程的客户端投影）。

### 3.2 RPC 协议

- 传输：单条 **WebSocket（`/ws`）** 承载全部服务调用 + 事件推送；HTTP 仅静态资源与少量
  REST（`/api/server-info`、健康检查）。
- 寻址：`{channel}.{method}`，channel 即服务名（如 `db-board.listTables`、`paperclip.listIssues`）。
- 消息格式：JSON-RPC 风格（id/method/params/result/error），事件走 notification。
- 移植建议：这是纯自研薄层（~300 行），换成 tRPC / Socket.IO / gRPC-Web 均可，不影响
  业务服务层。

### 3.3 核心接口清单（数据库看板）

| 分组 | 方法 | 语义要点 |
| --- | --- | --- |
| 连接 | `getConnectionState(wsKey?)` / `saveConnection` / `testConnection` / `deleteConnection` / `setActiveConnection` | 多连接 + 全局单激活；快照含 `state/config/workspaceAccess` |
| 元数据 | `listTables(force)` / `getTableColumns(schema, table)` | 进程内缓存，force 强制回源 |
| 浏览 | `queryRows({schema, table, page, pageSize, searchColumn?, searchValue?})` | 参数化查询，主键探测分页 |
| 写入 | `insertRow` / `updateRow` | 同事务写审计表；返回行数据 + logId |
| 审计 | `listOpLogs` / `rollback(logId)` | 逆序分页；回退 = 反向 SQL 也入审计 |
| 看板 | `generateDashboard({question, previousSpec?, locale?})` / `runDashboardSql` / `explainQuery` / `listDashboards` / `saveDashboard` / `deleteDashboardDefinition` | spec 是 zod 校验的 JSON（图定义 + 修订历史） |
| 汇总 | `getUsageSummary({compute?, force?})` | 有界并发逐表 count，按连接 id 持久化 |
| 知识库 | `registerProject` / `buildKnowledge` / `getKnowledge` / `distillTableCard` / … | 代码扫描 + LLM 蒸馏，见 §6 |

任务编排（Paperclip 客户端面）：`getConnectionState` / `listIssues` / `createIssue` /
`updateIssue` / `listAgents` / `createAgent` / `updateAgent` / `listRunSnapshots` /
`listIssueComments` / `startLocalServer` / `stopLocalServer`（+ 事件流 `onDidReceiveIssueEvent`）。

### 3.4 数据存储布局（数据根 `~/.boardhub`）

```
~/.boardhub/
├── .zcode/v2/                     # （ZCode 实现沿用其配置目录结构；移植自定）
│   ├── setting.json               # 应用设置：locale、paperclipServerUrl、模型 baseUrl/modelId
│   ├── credentials.json           # 凭据：DB 密码、模型 apiKey（AES-256-GCM 加密）
│   ├── db-board.json              # 连接配置 v3 {version, connections[], activeConnectionId, bindings?}
│   ├── db-board-knowledge.json    # 知识库（表知识卡 + 概览）
│   ├── db-board-usage.json        # 行数汇总（按连接 id）
│   └── custom-resources.sqlite    # 看板定义等（KV 表）
└── logs/
    └── boardhub-server.log        # 服务端日志（打包形态唯一排查渠道，5MB 轮转一份）
```

- **凭据永不落明文**：加密 key 由 `platform:homedir:username` 派生（可用 `ZCODE_CREDENTIAL_SECRET`
  环境变量覆盖）；日志/工具输出/提示词中均不出现。
- **跨进程写并发**（Web 版与桌面版共用数据根）：settings、连接配置、usage、知识库 JSON 的
  写入全部走 `withFileLock` 共享文件锁 + 原子写（临时文件 + rename）；连接配置用
  "锁内读最新 → 定向变更 → 写回"（不做全量内存覆盖，防止双开互相抹掉对方的连接）。

---

## 4. 数据库安全模型（最重要的设计）

这是整个项目区别于"裸连数据库的 AI 工具"的核心，移植时**必须完整保留**：

1. **无删除**：全系统不提供任何 DELETE 能力。数据面唯一"消失数据"的路径是回退事务内部的
   反向 SQL（且自身被审计）。工具层、面板、MCP 全部遵守。
2. **只读 SQL 四重强制**（服务端执行，Agent 层不复检也不放宽）：
   `BEGIN READ ONLY` 事务 + 单语句包装（拒绝分号拼接）+ 行上限（默认 500）+
   `statement_timeout`。
3. **标识符白名单**：schema/table/column 名只接受从元数据缓存来的实存标识符，参数值走
   参数化查询——SQL 注入在结构上不可能。
4. **写入三件套**：同一事务内 `SELECT … FOR UPDATE` 取 before 快照 → 写入（RETURNING 取
   after 快照）→ 写审计表（operator、表、主键、前后值、逆向 SQL、logId）。
5. **回退**：面板操作日志 tab 中对 active 日志一键执行逆向 SQL；检查同行无更大 id 的
   active 日志（必须按行逆序回退）；回退生成新日志。
6. **网络边界**：服务端只绑 `127.0.0.1`——channel 上有凭据与数据库配置服务，无鉴权时
   绝不能暴露局域网（需要外部访问必须显式设 host 且配 authToken）。
7. **operator 注入**：Agent 写工具忽略调用方传的任何 operator 参数，由宿主强制注入
   `"{用户名} via db-agent"`，审计归因不可伪造。

---

## 5. AI 模型运行时（自配直连）

不依赖任何 AI 编程工具的账号体系（`packages/boardhub-server/src/boardhubModel.ts`）：

- **配置**：`baseUrl` + `modelId` 存设置（明文，非敏感），`apiKey` 存凭据服务（加密）。
  baseUrl/modelId 缺任一即"未配置"——纯浏览/查询/审计/手动看板不受影响，仅 AI 生成入口
  报 `model-unavailable`。
- **调用**：`POST {baseUrl}/chat/completions`（Bearer apiKey），单轮 user 消息，
  `max_tokens` 默认 4096，`timeoutMs` → `AbortSignal.timeout`。非流式。
- **接口形状**（供 dbBoard 消费）：`readCurrentModel()` 返回
  `{providerId, modelId}` 或 null；`generateText({prompt, maxOutputTokens?, timeoutMs?})`。

移植时这一层可以整体替换成任意 LLM SDK，只要满足上面两个函数签名。

---

## 6. 业务知识库（代码感知的引导收集）

**目标**：让 AI 在没有 DBA 的情况下知道"每张表是什么业务、被哪些页面/接口使用"。

### 6.1 流程

1. **注册项目**：用户指定本地代码仓库根目录（支持多 git 仓库 / 多模块 Maven），服务端
   探测技术栈（Java Spring / Vue 等）。
2. **配置发现**：从 `application-*.yml` 提取 Nacos/数据源线索（凭据掩码显示，可一键采用）。
3. **证据扫描**（正则级纯函数，无 IO）：从源码提取实体/DDL/前端页面与字段的引用关系
   （Mapper 调用、URL 字符串、ajax 调用等）。
4. **LLM 蒸馏**：按类分片送模型，产出**表知识卡**：中文表用途、列含义（结合列注释）、
   关联页面/API、注意事项。zod 校验输出 JSON。
5. **持久化**：`db-board-knowledge.json`；导出 Markdown 文档（含"数据库概览"章节）。

### 6.2 数据库概览（汇总看板）

总表数 / 知识覆盖率 / 业务域 / 已统计行数四指标 + 常用业务表清单（行数 ≥1000 的知识表按
行数降序取前 20——行数作为"使用频繁度"的近似）。行数统计：有界并发 6、每表 8s 超时、失败
跳过（Kingbase 兼容模式下统计快表恒为 0，只能逐表 count，150 张知识表约 9s）。显式触发、
按连接 id 持久化；生成过概览后"数据浏览"表列表按行数倒序。

### 6.3 代码知识图谱（进阶）

扫描全栈代码建方法级图谱（8 种节点：method/class/endpoint/apiCall/page/table/domain/
hardcoded；8 种边：CONTAINS/CALLS/MAPS_TO/USES_TABLE/RENDERS/LOCATED_IN/
BELONGS_TO_DOMAIN/DEPENDS_ON_CONFIG）。三个查询工具：

- `trace_impact`：改了方法 X → 双向 BFS 求受影响页面/接口/表（纯图遍历，无需 LLM）。
- `find_hardcoded`：写死值清单（用户名/用户 ID/部门 ID/角色 ID/字典 ID/魔法数字/配置键，
  10 种正则模式——如 `USER_[a-f0-9]{32}`、`username === 'xxx'`）。
- `query_code_graph`：按名称/类型/文件搜节点。

实测规模（一个 148 万行 Java+Vue 项目）：1,483 类 / 5,953 方法 / 929 端点 / 6,316 前端
API 调用 / 878 特殊情况注释 / 50 硬编码身份 ID。

---

## 7. Agent 集成层 —— MCP（移植到其他 Agent 的钥匙）

**这是"不基于 ZCode 也能用"的核心机制**：全部数据库能力被封装为标准 MCP
（Model Context Protocol）server，任何支持 MCP 的 Agent（Claude Code、Cursor、Codex、
自研 Agent…）都能直连。

### 7.1 传输与安全

- 宿主进程内懒启动 **Streamable HTTP** MCP 端点：只绑 `127.0.0.1` 的随机端口 + 随机
  Bearer token。
- token 不落日志、不进提示词；无 token 的请求 401。
- 复用宿主同一份服务实例（连接池、看板 store、模型链路单一所有者）。
- 使用官方 `@modelcontextprotocol/sdk`（2.x）。

### 7.2 工具清单（17 个）

| 分组 | 工具 | 说明 |
| --- | --- | --- |
| 元数据 | `list_tables` / `get_table_columns` / `get_table_card` / `search_knowledge` | 表按业务域分组；知识卡缺失时提示可现场蒸馏 |
| 浏览 | `query_rows` | 分页 + 列搜索 |
| 只读 SQL | `run_readonly_sql` | 服务端四重强制（见 §4） |
| 写入 | `insert_row` / `update_row` | operator 强制注入；**无删除工具** |
| 看板 | `generate_dashboard` / `save_dashboard` / `list_dashboards` | NL → spec → 执行 |
| 蒸馏 | `distill_table_card` / `save_table_card` | 单表知识卡生成/保存 |
| 审计 | `list_op_logs` | 查审计（无回退工具——回退保留在面板，人工决策） |
| 图谱 | `trace_impact` / `find_hardcoded` / `query_code_graph` | 见 §6.3 |

### 7.3 会话契约（导语）

通过 MCP 创建 Agent 会话时，首条输入携带"人格导语"约定行为：知识库优先选表；查询结果用
Markdown 表格并标注连接名；写入必须先展示新旧值预览并获得确认；删除永不可用；切换连接
引导回面板。导语在协议层注入，不依赖特定 Agent 的 system prompt 机制。

### 7.4 接入示例（任意 MCP 客户端）

```js
// 1. 从宿主获取 endpoint + token（ZCode 中由 getMcpServer(wsKey) 下发）
const { url, token } = await hostService.getDbBoardMcpServer();

// 2. 标准 MCP 客户端
const client = new Client({ name: "my-agent", version: "1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
await client.connect(transport);
const tools = await client.listTools();          // 17 个工具
const result = await client.callTool({ name: "list_tables", arguments: {} });
```

---

## 8. 任务编排（Paperclip 协议客户端）

BoardHub 的"任务编排" Tab 是 Paperclip server（独立进程，`npm` 包 `paperclipai`，默认端口
3100）的**纯客户端投影**：REST（CRUD）+ WS（live events），不镜像不缓存任务事实。

- **领域模型**：Company → Project → Issue（标题/描述/优先级/状态机 待办→执行→审查→完成/
  取消）→ Run（一次执行尝试：agent、输出、耗时）→ Comment（agent 进展流水）。
- **Agent**：每个 agent = 一个可执行身份（adapterType：CLI 型如 claude/grok，或 http 型）；
  role=ceo 的第一个 agent 是 dispatcher（自动分派）。
- **本地服务生命周期**（BoardHub 设置页可启停）：
  - 固定安装目录（如 `~/.paperclip/server`，`npm install --prefix` 产物）；
  - **启动运行本地已安装版本**（`node <目录>/paperclipai/dist/index.js run`，不联网秒起），
    从未安装才一次性 `npm install paperclipai@latest`；
  - 手动更新：`npm view` 对比 registry（15s 超时静默降级 + 10min 缓存），有新版显示标识，
    手动触发覆盖安装（运行中则自动重启）；
  - Windows 上服务在独立终端窗口长期运行（服务自带控制台后，其子进程——pg_dump 每小时
    备份等——继承控制台而不是弹新黑窗）；
  - 健康探测 `GET /api/health`（3s 超时）；启停幂等（先探健康再动作）；停止按命令行模式
    匹配进程（`paperclip[a]i` 字符类技巧避免自匹配）。
- 数据库一律外置 PostgreSQL（Windows 内置 Administrator 账户的全权令牌使内嵌 PG 无法
  原生运行）；每 60 分钟自动 `pg_dump` 备份，保留 30 天。

移植提示：Paperclip 是独立开源服务，可直接复用；或按上述领域模型自研（核心是 issue 状态机
+ agent 唤醒队列 + live events 广播）。

---

## 9. 前端设计

- **骨架**（`BoardHubApp`，~120 行）：顶部 Tab（数据库看板 / 任务编排 / 设置）+ 主题切换
  （亮/暗，localStorage）。无路由、无全局状态库——各页面 hook 自管。
- **页面复用**：看板页与任务页是纯 props 组件（`DbBoardPage` / `PaperclipPage`），任何
  宿主都能挂；ZCode 专属能力（助手对话入口、工作区绑定）通过可选 props 关闭
  （`agentChatEnabled=false`、不传 `workspacePath`）。
- **服务接入**：入口 `connectViaWebSocket("/ws")` → `ServiceProvider`；平台能力走 no-op
  基座（`createNoopWebPlatform()`——目录选择等桌面能力降级为服务端目录浏览器）。
- **i18n**：自研轻量 intl（`formatMessage({id, params})`），zh-CN/en-US 两个 JSON 文件。
- **设计规范**：8px 间距栅格、`text-ui-*` 字号、语义色 token（success/warning/destructive），
  line tabs（圆角胶囊）+ 页头连接条（状态徽章 + 版本 + 危险操作红描边）。

---

## 10. 桌面壳设计（Electron）

| 关注点 | 方案 | 理由 |
| --- | --- | --- |
| 壳 vs Tauri | Electron 41 | 服务端硬依赖 Node 原生模块（pg/native sqlite/MCP SDK），Tauri 需 sidecar 打包 Node 抵消体积优势 |
| 进程模型 | main + `utilityProcess.fork`(server) | server 是独立进程，崩溃不连坐窗口 |
| 端口协商 | `PORT=0` 随机端口 + stdout 协议行 `BOARDHUB_SERVER_READY {"port":N}`（15s 上限），READY 后 `/api/server-info` 二次确认 | 消除"先探测再启动"的 TOCTOU 竞态；同源 `/ws` 前端零改动 |
| 崩溃自愈 | 退避序列 [1s, 5s, 15s] 重启 server（新端口）+ `loadURL` 重载；连续 3 次失败展示错误页 | 瞬时故障自愈，持续故障可见 |
| 生命周期 | `window-all-closed` 退出（非 macOS）；`will-quit` 收口杀 server；macOS 关窗保活、`activate` 重建窗口复用 server | 常规桌面语义 |
| 产物 | `resources/server/entry.cjs`（esbuild 全内联单文件，~5.6MB）+ `resources/web/`；`asar: false` | 单文件 bundle 免装依赖；规避 asar 的 fs 差异 |
| dev | `ELECTRON_START_URL`（默认 vite 5175）直连 dev server，主进程不拉子进程 | 前端 HMR 不经服务端 |

打包：electron-builder（mac dmg / win nsis 配置就绪），版本对齐所复用的桌面设施。

---

## 11. 关键设计决策汇总

| # | 决策 | 理由 / 踩过的坑 |
| --- | --- | --- |
| 1 | 服务端 Node 单进程 + 回环绑定 | channel 上有凭据服务；无鉴权形态下回环即安全边界 |
| 2 | 数据根 `~/.boardhub` 与主应用隔离 | 避免独立版与宿主版配置/凭据互写；切换在服务实例化前完成（优先级最高的 `setDataBaseDir`） |
| 3 | 凭据 AES-256-GCM 加密落盘，key 由平台身份派生 | 明文密码永不落盘；跨机器不可解密 |
| 4 | AI 走 OpenAI 兼容直连，不依赖宿主 Agent | 独立应用的核心解耦点；未配置时非 AI 功能全部可用 |
| 5 | 全部 DB 能力封装 MCP | Agent 无关性的钥匙；任何 MCP 客户端即插即用 |
| 6 | 无删除 + 只读四重强制 + 审计 + 回退 | AI 改数据的安全底线；详见 §4 |
| 7 | 端口 `PORT=0` + stdout READY 协议行 | TOCTOU 竞态（先探测占端口再启动会撞） |
| 8 | 跨进程文件锁 + 原子写 | Web/桌面双开共数据根时的丢更新防护（曾出现互相抹掉连接配置） |
| 9 | server 崩溃退避自愈 + 失败错误页 | 瞬时故障（端口冲突/OOM）自愈，持续故障不白屏 |
| 10 | 本地服务固定目录安装 + 本地版本直启 | `npx @latest` 每次联网解析，弱网下冷启动 6 分钟超时；固定目录 20 秒 |
| 11 | Windows 服务驻留终端窗口 | 无控制台宿主拉起的子进程（每小时 pg_dump 备份）各自弹黑窗；终端形态让子进程继承控制台，根治 |
| 12 | Kingbase 兼容：information_schema 探测主键、逐表 count | 该模式无统计快表（`all_tables.num_rows` 恒 0） |

---

## 12. 移植指南（不基于 ZCode 的最小自研清单)

| 模块 | ZCode 中的实现 | 移植替代 | 工作量估计 |
| --- | --- | --- | --- |
| WS RPC 框架 | `@zcode/rpc`（~300 行） | tRPC / Socket.IO / 自研 | 1-2 天 |
| DI 容器 | `ServiceCollection`（~100 行） | 直接手工构造传参即可 | 0.5 天 |
| 设置/凭据服务 | `createSettingService` / `createCredentialService` | JSON + 原子写 + AES-GCM（node:crypto 30 行） | 1 天 |
| 数据库访问 | `dbBoardService`（pg 驱动 + 事务/审计/回退） | **建议直接复用本仓库实现**（与 ZCode 耦合最浅）或按 §4 重写 | 复用 0 / 重写 5-8 天 |
| 知识库/图谱 | `dbBoardKnowledge*`（扫描+蒸馏） | 复用或按 §6 重写（正则提取器可整体搬走） | 复用 0 / 重写 3-5 天 |
| MCP server | `dbBoardAgentService`（官方 SDK） | 官方 SDK + §7.2 工具清单 | 1-2 天 |
| 前端页面 | `@zcode/ui` 的两个页面组件 | 复用（纯 props）或任意 React 栈重写 | 复用 0 / 重写 5-10 天 |
| 模型运行时 | `boardhubModel.ts`（~150 行） | 任意 LLM SDK，签名见 §5 | 0.5 天 |
| 桌面壳 | `boardhub-desktop`（~280 行） | Electron/Tauri + §10 方案 | 2-3 天 |
| 任务编排 | Paperclip server（独立 npm 包） | 直接复用；或按 §8 领域模型自研 | 复用 0 |

**Agent 侧**：你的 Agent 只需是标准 MCP 客户端（§7.4），或通过 Paperclip 的 http adapter
接入任务编排。数据库能力的全部安全边界在服务端，Agent 无需任何特殊改造。

---

## 13. 验收场景（新实现应全部通过）

1. **启动**：Web/桌面双形态可启动；数据根下生成配置；回环端口；三 Tab 可切换。
2. **模型未配置**：AI 生成入口报"模型不可用"；浏览 / SQL / 审计 / 手动看板全部正常。
3. **模型已配置**（OpenAI 兼容端点）：NL 生成看板成功；知识蒸馏成功。
4. **安全**：只读 SQL 无法写（事务回滚）；多语句被拒；无任何删除入口；写入产生审计并可
   回退；回退后原日志标记 reverted。
5. **MCP**：无 token 401；initialize → tools/list（17 个）→ tools/call 全通；写入类工具
   的 operator 被强制注入。
6. **双开**：Web 与桌面同时开，各自保存连接不互相覆盖。
7. **崩溃自愈**：杀 server 子进程，3 秒内窗口自动重载恢复。
8. **本地服务**：停止→启动 ≤30s；每小时备份不弹窗（Windows）；更新有版本对比与手动触发。

---

## 附：本仓库中的对应代码位置

| 内容 | 位置 |
| --- | --- |
| 行为规范（权威） | `specs/boardhub/standalone-app.md`、`specs/services/db-board*.md`、`specs/services/paperclip-integration.md`、`specs/services/code-graph.md` |
| 服务端 | `packages/boardhub-server/src/`（entry / boardhubModel / boardhubLog） |
| 前端 | `packages/boardhub-web/src/`（BoardHubApp / main / 模型设置） |
| 桌面壳 | `packages/boardhub-desktop/src/main/index.ts` |
| 数据库看板核心 | `packages/services/src/dbBoard/`、`dbBoardKnowledge/`、`dbBoardAgent/` |
| 任务编排客户端 | `packages/services/src/paperclip/` |
| 打包 | `packages/boardhub-server/scripts/build-bundle.ts`、`pnpm bundle:boardhub` |
