# 代码知识图谱 · 维护文档

> 面向维护者：系统架构、数据模型、扩展方法、已知问题与修复历史。
> 消费者接入见 [code-graph-integration.md](./code-graph-integration.md)。行为规范见 `specs/services/code-graph.md`。

## 1. 系统架构

```text
代码仓库（projectRoot）
   │ walkCodeFiles（有界并发 8，跳过 .git/node_modules/target/dist，上限 6,000 文件 × 256KB）
   ▼
codeGraphExtract.ts（正则级纯函数提取器，无 IO）
   │  Java 结构 / Controller 端点 / 前端 API 调用 / 硬编码 / 特殊情况
   ▼
CodeGraphDoc { nodes[], edges[], repoSnapshots[], stats }   ← codeGraphTypes.ts
   │ atomicWriteJson
   ▼
~/.zcode/v2/code-graph.json（持久化）
   │
   ├── codeGraphImpact.ts（双向 BFS 影响分析 + 搜索，纯函数）
   ├── codeGraphTools.ts（4 个 MCP 工具，挂在 db_board server 上）
   └── 外部 MCP 客户端（Streamable HTTP + Bearer，端点文件 ~/.zcode/v2/db-board-mcp.json）
```

### 源文件清单

| 文件 | 职责 | 约行数 |
|------|------|--------|
| `packages/services/src/dbBoardKnowledge/codeGraphTypes.ts` | 节点/边/文档/蒸馏/影响结果类型 | ~150 |
| `packages/services/src/dbBoardKnowledge/codeGraphExtract.ts` | 全部提取器 + 图构建辅助（max-lines 豁免） | ~540 |
| `packages/services/src/dbBoardKnowledge/codeGraphImpact.ts` | traceImpact（双向 BFS）/ searchGraph / findHardcoded | ~160 |
| `packages/services/src/dbBoardKnowledge/codeGraphService.ts` | walkCodeFiles + buildCodeGraph + JSON 存储 + createCodeGraphService | ~330 |
| `packages/services/src/dbBoardAgent/codeGraphTools.ts` | 4 个 MCP 工具定义（zod 入参校验 + markdown 输出） | ~270 |
| `packages/services/src/dbBoardAgent/dbBoardAgentMcpServer.ts` | MCP server 宿主（工具清单合并 db 14 + 图谱 4） | — |
| `packages/services/src/dbBoardAgent/dbBoardAgentService.ts` | getMcpServer 门控 + 端点持久化 + dispose 清理 | — |
| `packages/services/test/codeGraph.test.ts` | 16 用例（roma.js 真实代码为 fixture） | ~260 |
| `specs/services/code-graph.md` | 行为规范 | — |

## 2. 数据模型

### 节点（`CodeGraphNode`，id 全局唯一 = `{type}:{qualifiedName}`）

| type | 产生者 | metadata 关键字段 |
|------|--------|-------------------|
| `method` | extractJavaStructure | signature / returnType / annotations[] |
| `class` | extractJavaStructure | —（同时充当「文件占位节点」id=`file:<path>`） |
| `endpoint` | extractEndpoints | url / httpMethod |
| `apiCall` | extractFrontendApiCalls | url / httpMethod |
| `page` | buildGraphFromApiCalls | —（id=`page:<目录/文件名>`） |
| `table` | （预留，来自表知识卡） | comment |
| `domain` | （预留） | description |
| `hardcoded` | extractHardcoded | **value / kind / context**（前后 3 行代码） |

### 边（`CodeGraphEdge`）

| type | 含义 |
|------|------|
| `CONTAINS` | class → method |
| `CALLS` | method → method（Mapper/Service 调用，方法体窗口 2000 字符内按字段名匹配） |
| `MAPS_TO` | endpoint → Controller 方法；apiCall → endpoint（按 URL 匹配） |
| `USES_TABLE` | method → table（预留：经 Mapper XML 反查表名） |
| `RENDERS` | page → apiCall |
| `LOCATED_IN` | hardcoded → 文件占位节点 |
| `DEPENDS_ON_CONFIG` | class → hardcoded(configKey)（@Value 注入） |
| `BELONGS_TO_DOMAIN` | （预留） |

### 硬编码检测模式（codeGraphExtract.ts `HARDCODED_PATTERNS` 等）

| 模式 | kind |
|------|------|
| `\bUSER_[a-f0-9]{32}\b` | userID |
| `\bHZ[a-f0-9]{20,}\b` | deptID |
| `DICTIONARIES_ID[=:]["']?<hex32>` | dictID |
| `roleId[=:]\s*"<hex32>` / `ROLE_ID\w*\s*=` | roleID |
| `\b[a-f0-9]{32}\b`（通用兜底） | userID |
| `username === 'xxx'` / `getItem('username') === 'xxx'` | username |
| `roleName === 'xxx'` | roleID |
| `if (status/type/state… === N)` | statusCode |
| `@Value("${key}")` | configKey |

## 3. 数据文件位置

| 文件 | 内容 | 生命周期 |
|------|------|----------|
| `~/.zcode/v2/code-graph.json` | 图谱本体（nodes/edges/stats/repoSnapshots） | 构建覆盖；进程内缓存 + 磁盘 |
| `~/.zcode/v2/db-board-mcp.json` | MCP 端点描述符（url+token） | getMcpServer 启动时写；dispose 时删 |
| `~/.zcode/v2/db-board-knowledge.json` | 表级知识卡（独立于图谱） | 知识库构建时写 |

路径经 `getAppConfigDir()`（`ZCODE_DATA_BASE_DIR` / `setDataBaseDir` 可重定向，BoardHub 为 `~/.boardhub`）。

## 4. 常见维护任务

### 4.1 重建图谱

外部 MCP 客户端调 `build_code_graph {"project_root": "..."}`，或代码里 `codeGraphService.buildGraph(root)`。全量覆盖，无增量。

### 4.2 清空图谱

删除 `~/.zcode/v2/code-graph.json`（或让服务重启后不恢复——图谱目前**不落恢复逻辑**，重启后内存缓存空，`getGraph()` 会重新读盘，所以删文件即清空）。

### 4.3 调整扫描范围

`codeGraphService.ts` 顶部常量：`WALK_CONCURRENCY`（8）、`MAX_FILES`（6000）、`FILE_READ_LIMIT`（256KB）、`SKIP_DIRS`、`CODE_EXTENSIONS`。

### 4.4 调整硬编码检测

`codeGraphExtract.ts`：`HARDCODED_PATTERNS`（ID 类）、`USERNAME_PATTERNS`（身份比较）、`STATUS_CODE_PATTERN`（魔法数字）、`CONFIG_KEY_PATTERN`（@Value）。加模式后补对应单测。

## 5. 如何扩展

### 5.1 新增提取器（如 Go/Python 后端）

1. 在 `codeGraphExtract.ts` 加正则常量 + `extractXxx(source, filePath)` 纯函数（禁止 IO）；
2. 在 `codeGraphService.ts::buildCodeGraph` 的文件循环里按扩展名分发；
3. `codeGraph.test.ts` 加用例（真实代码片段为 fixture）。

### 5.2 新增 MCP 工具

在 `codeGraphTools.ts` 的数组里加一项（zod strict 校验入参、markdown 文本输出、错误也走 text + isError）。工具自动出现在 `tools/list`（server 宿主合并 db 14 + 图谱 N）。同步更新 `specs/services/code-graph.md` 与本文档。

### 5.3 启用 LLM 语义蒸馏（规划中）

类型已备好（`MethodKnowledge` / `HardcodedAnalysis`，codeGraphTypes.ts）。管线：按类分片（方法签名 + 调用 + SQL + 硬编码 context 为证据）→ 复用 `generateText` 一次式链路（参考 `dbBoardKnowledgeService::distillBuckets` 的 4096→1024 降档与 180s 超时模式）→ zod 校验 → 结果合并进节点 metadata。影响范围不需要 LLM（图遍历），LLM 只补语义。

### 5.4 增量构建（规划中）

复用 `dbBoardKnowledgeService` 的 git HEAD 轮询模式（`pollIncremental`：`git diff --name-only old..new` → 反查受影响节点 → 局部重建）。需要给 `CodeGraphDoc` 加节点→文件反向索引（nodes 已带 file 字段，天然可建）。

## 6. 已知问题与修复历史

| 问题 | 根因 | 状态 |
|------|------|------|
| esbuild（tsx）下方法匹配全丢 | 字符类内 `\[` `\]` 未转义，esbuild 转译与 node 原生不一致 | ✅ 保留转义 + oxlint 逐条豁免注释（见 METHOD_PATTERN 上方注释） |
| 模块级 `/g` 正则多次调用返回 null | `lastIndex` 残留 | ✅ 单次匹配类正则去掉 `/g`，用 `source.match()` |
| JSON-RPC id 用浮点报 -32600 | MCP 校验要求整数 id | ✅ 对接文档已写明；自研客户端用自增整数 |
| vitest afterEach 删临时目录 EBUSY | ProjectSessionStore sqlite 句柄未关 | ✅ node.ts dispose 双路径统一收口（WeakMap 侧表 `localSettingsForDispose`）；测试文件 afterEach 先 close |
| tsx 进程退出时 `Assertion failed ... async.c` | libuv 在句柄未完全释放时退出的噪音 | 无害，忽略 |
| 前端 API 漏提取（三元赋值 URL） | 早期模式只匹配直接字面量 | ✅ 加广义模式：任何 `'/path/xxx'` 形引号字符串（过滤静态资源后缀） |

## 7. 测试

```bash
cd packages/services
npx tsx --test test/codeGraph.test.ts        # 16 用例（提取器 + 图构建）
npx vitest run test/legacyAccountConnectionCompletion.test.ts   # 关联：settingService close 收口
```

fixture 直接取自 roma.js 真实代码（jiyaosw/jiyao/chengyilin、HZ 部门 ID、USER_ 人员 ID、字典 ID），改提取规则时这些用例就是回归防线。

## 8. 性能参考（HJT，Windows，2026-10）

| 指标 | 值 |
|------|-----|
| 扫描文件 | ~6,400（上限 6,000 实际触发） |
| 全量构建 | 10.5s |
| 节点 / 边 | 16,438 / 25,476 |
| 硬编码 | 286（username 3 / userID 20+ / deptID 30+） |

## 9. 相关文档

- 消费者接入：`docs/code-graph-integration.md`
- 行为规范：`specs/services/code-graph.md`
- 数据库助手（工具宿主）：`specs/services/db-board-agent.md`
- 表级知识库：`specs/services/db-board-knowledge.md`
