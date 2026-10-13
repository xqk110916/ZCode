# 代码知识图谱 · 对接文档

> 面向消费者：任何 MCP 客户端（Claude Code / Cursor / LangChain / 自研 Agent）如何接入并使用代码知识图谱。
> 系统本身的架构与维护见 [code-graph-maintenance.md](./code-graph-maintenance.md)。

## 1. 功能概述

代码知识图谱扫描目标仓库（前后端全栈），建立方法级知识图谱，提供四类能力：

| 能力 | MCP 工具 | 典型问题 |
|------|----------|----------|
| 影响范围分析 | `trace_impact` | 「改了 `getUserList` 会影响哪些页面/接口/表？」 |
| 硬编码清查 | `find_hardcoded` | 「项目里有哪些写死的用户 ID / 角色 ID / 状态码？」 |
| 图谱检索 | `query_code_graph` | 「收发文相关的 Service 有哪些？」 |
| 图谱构建 | `build_code_graph` | 传入项目根目录，自助构建/重建图谱 |

工具挂载在 `db_board` MCP server 上（与数据库看板工具同 server，共 18 个工具）。

HJT 项目（Java + Vue 全栈，约 6,400 个代码文件）实测参考值：
1,483 Java 类 / 5,953 方法 / 929 Controller 端点 / 6,316 前端 API 调用 / 286 硬编码项 / 878 特殊情况标注，全量构建约 10 秒。

## 2. 前置条件

1. **ZCode dev 服务在运行**：server（默认 3030）+ web（默认 5173），即 `pnpm dev:web`。
2. **db_board MCP server 已启动**：它是懒启动的——在 ZCode 里任意绑定工作区新建一次对话、或调用一次 `dbBoardAgentService.getMcpServer`，server 即启动并把端点写入磁盘（见下节）。
3. **（可选）工作区绑定**：严格模式下只有绑定了连接的工作区能在 ZCode 内创建助手会话；外部 MCP 客户端直连不受此门控（持 token 即可），但需要先完成一次启动让端点文件生成。

## 3. 快速开始（三步）

### 第 1 步：获取端点

server 启动后，端点描述符持久化在固定位置：

```json
// ~/.zcode/v2/db-board-mcp.json
{
  "name": "db_board",
  "url": "http://127.0.0.1:60550/mcp",
  "token": "<Bearer token>",
  "updatedAt": "2026-10-13T06:29:23.128Z"
}
```

BoardHub 独立应用运行时对应写在 `~/.boardhub/.zcode/v2/db-board-mcp.json`。

### 第 2 步：配置你的 MCP 客户端

**Claude Code（`.mcp.json`）：**

```json
{
  "mcpServers": {
    "db_board": {
      "type": "http",
      "url": "http://127.0.0.1:60550/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Cursor（`~/.cursor/mcp.json`）：** 同上结构，`url` + `headers`。

**通用 JSON-RPC（任何语言可直接 HTTP 调用）：** 见第 5 节协议细节。

**LangChain（Python，langchain-mcp-adapters）：**

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
import json, os

# 读 ZCode 持久化的端点描述符
with open(os.path.expanduser("~/.zcode/v2/db-board-mcp.json"), encoding="utf-8") as f:
    ep = json.load(f)

client = MultiServerMCPClient({
    "db_board": {
        "transport": "streamable_http",
        "url": ep["url"],
        "headers": {"Authorization": f"Bearer {ep['token']}"},
    }
})
tools = await client.get_tools()
# 之后把 tools 交给 create_react_agent / 任一 agent 执行器即可
```

### 第 3 步：构建图谱

图谱不会自动构建。首次使用前调一次：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"build_code_graph","arguments":{"project_root":"F:\\masterCode\\HJT"}}}
```

成功返回节点/边统计。之后 `trace_impact` / `find_hardcoded` / `query_code_graph` 即可查询。

## 4. 工具参考

### 4.1 `build_code_graph` — 构建图谱

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `project_root` | string | ✅ | 项目根目录绝对路径（如 `F:\masterCode\HJT`） |

- 全量扫描，重复构建整体覆盖（增量构建待后续版本）。
- 耗时参考：HJT（6,400 文件）约 10 秒；建议 MCP 客户端超时 ≥ 120 秒。
- 扫描范围：`.java .js .ts .vue .jsx .tsx .xml .sql .yml/.yaml`；跳过 `.git node_modules target dist build` 等。
- 单文件读取上限 256KB，文件数上限 6,000。

### 4.2 `trace_impact` — 影响范围分析

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 方法名/类名/端点 URL，模糊匹配 |

沿 `CALLS / USES_TABLE / MAPS_TO / RENDERS / LOCATED_IN` 边做**双向 BFS**（上游谁调用它、下游它影响什么），返回：

- `affectedTables`：涉及的数据库表
- `affectedEndpoints`：受影响的 API 端点
- `affectedPages`：受影响的前端页面
- `affectedMethods`：关联方法（最多列 30）
- `hardcodedDependencies`：依赖的硬编码项（含类型与位置）

### 4.3 `find_hardcoded` — 硬编码搜索

| 参数 | 类型 | 说明 |
|------|------|------|
| `kind` | string? | `userID / deptID / roleID / dictID / username / statusCode / configKey` |
| `value` | string? | 按值模糊搜索 |
| `file` | string? | 按文件路径过滤 |
| `limit` | number? | 默认 50，最大 200 |

### 4.4 `query_code_graph` — 图谱检索

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string? | 按名称/限定名/元数据模糊搜索 |
| `type` | string? | `method / class / endpoint / apiCall / page / table / domain / hardcoded` |
| `file` | string? | 按文件路径过滤 |
| `limit` | number? | 默认 30，最大 100 |

### 4.5 同 server 的数据库工具（14 个）

`list_tables` / `get_table_columns` / `query_rows` / `run_readonly_sql` / `get_table_card` / `search_knowledge` / `insert_row` / `update_row` / `generate_dashboard` / `save_dashboard` / `list_dashboards` / `distill_table_card` / `save_table_card` / `list_op_logs`。详见 `specs/services/db-board-agent.md`。

## 5. JSON-RPC 协议细节（自研客户端必读）

传输为 MCP Streamable HTTP。所有请求 `POST` 到端点 URL：

```json
// 请求头
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <token>

// tools/list
{"jsonrpc":"2.0","id":1,"method":"tools/list"}

// tools/call
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"find_hardcoded","arguments":{"kind":"username","limit":5}}}
```

**三个实践中的坑：**

1. **`id` 必须是整数**。浮点数（如 `Math.random()`）会被判为非法 JSON-RPC，返回 `-32600 Bad Request`。
2. **响应可能是 SSE**（`Content-Type: text/event-stream`）：逐行找 `data:` 前缀，解析其后的 JSON，取 `result.content[0].text`。
3. **工具输出是 markdown 文本**：`result.content[0].text`，`result.isError === true` 表示工具执行失败（错误信息同样在该 text 中）。

## 6. 典型场景

### 场景 A：改代码前评估影响面

```text
→ trace_impact {"name": "handleSelectData"}
← 影响分析：...MaterialReg.roma.js 的 handleSelectData
  硬编码依赖：[username] jiyaosw/jiyao/chengyilin、[deptID] HZ28e7f51e...
```

### 场景 B：上线前硬编码清查

```text
→ find_hardcoded {"kind": "userID", "limit": 200}
→ find_hardcoded {"kind": "statusCode"}
```

按文件/类型分组出清单，交给业务确认哪些该配置化。

### 场景 C：全栈链路追踪（页面 → 接口 → 表）

```text
→ query_code_graph {"query": "datumRecord", "type": "apiCall"}
→ trace_impact {"name": "<上一步拿到的 Controller 方法>"}
```

## 7. 安全说明

- server 仅监听 `127.0.0.1`，不暴露局域网。
- token 随宿主重启轮换；server 停止（dispose）时会删除端点文件，避免外部拿到失效 token。
- **token 等同于数据库与代码图谱的访问凭证**：不要提交进 git、不要写进日志。图谱 4 个工具为只读，但同 server 的 `insert_row` / `update_row` 具备数据库写能力。
- 工作区绑定门控只作用于 ZCode 会话创建链；外部客户端凭 token 直连不受该门控。

## 8. 故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 端点文件不存在 | server 从未启动 | 在 ZCode 里建一次助手对话，或调用 `getMcpServer` |
| 401 unauthorized | token 已轮换（ZCode 重启过） | 重读端点文件，更新客户端配置 |
| 连接拒绝 | dev 服务未运行 | `pnpm dev:web` 重启 |
| `graphUnavailable`（工具返回） | 图谱未构建 | 先调 `build_code_graph` |
| `-32600 Bad Request` | JSON-RPC id 为浮点/缺失 | id 用自增整数 |
| 构建很慢/结果偏少 | 仓库超大触到 6,000 文件上限 | 按子目录分多次构建，或调大 `codeGraphService.ts` 中的 `MAX_FILES` |
| trace_impact 返回「未找到」 | 名称不精确 | 先用 `query_code_graph {"query": "部分名"}` 拿到准确名称 |
