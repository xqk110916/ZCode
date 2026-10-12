# 代码知识图谱（code-graph）

全栈代码知识图谱：扫描前后端代码建立方法级知识图谱，支持影响范围分析、硬编码清单、特殊情况标注。

## 产品规则

- 图谱 = 节点（方法/类/端点/前端调用/页面/表/域/硬编码项）+ 边（包含/调用/映射/用表/渲染/写死于/属域/依赖配置）。
- 构建管线：扫描代码文件 → 正则提取结构/硬编码/特殊情况 → 合并图 → 持久化（JSON）。
- 影响范围推导为纯图遍历（BFS），不需要 LLM。
- LLM 语义蒸馏（按需）：为方法生成业务逻辑描述、影响说明、硬编码含义、特殊情况。
- 硬编码是第一公民：独立节点类型，有自己的搜索 MCP 工具和位置信息。

## 硬编码检测

| 模式 | 类型 | 示例 |
|------|------|------|
| `USER_[a-f0-9]{32}` | userID | roma.js 中写死的人员 ID |
| `HZ[a-f0-9]{20,}` | deptID | roma.js 中写死的部门 ID |
| `DICTIONARIES_ID=[hex32]` | dictID | roma.js 中的字典 ID |
| `roleId[=:]\s*"[hex32]"` | roleID | 后端写死的角色 ID |
| `[a-f0-9]{32}` | userID（通用） | 任何 32 位 hex |
| `username === 'xxx'` | username | roma.js 的 jiyaosw/jiyao/chengyilin |
| `getItem('username') === 'xxx'` | username | localStorage 比较 |
| `roleName === 'xxx'` | roleID | 角色名硬编码 |
| `if (status === N)` | statusCode | 状态码魔法数字 |
| `@Value("${key}")` | configKey | Java 配置注入 |

每个 HardcodedItem 记录：value + kind + file:line + 前后 3 行上下文代码。

## MCP 工具（3 个，挂载在 db-board agent）

| 工具 | 用途 |
|------|------|
| `trace_impact` | 给定方法名 → BFS 图遍历 → 受影响的页面/端点/表/方法/硬编码依赖 |
| `find_hardcoded` | 按 kind/value/file 搜索硬编码项 |
| `query_code_graph` | 按名称/类型/文件搜索图谱节点 |

## 接口

`ICodeGraphService`（内嵌于 codeGraphService.ts，不单独注册 channel）：
- `getGraph()`：读取已构建的图谱（null = 未构建）
- `buildGraph(projectRoot)`：扫描项目并构建图谱

存储：`~/.zcode/v2/code-graph.json`（atomicWriteJson）。

## 验收场景

1. 对 HJT 项目构建：1,483 类 / 5,953 方法 / 929 端点 / 6,316 前端 API 调用 / 878 特殊情况。
2. roma.js `handleSelectData` 检测到：3 个写死用户名（jiyaosw/jiyao/chengyilin）+ 部门 ID + 字典 ID + 特殊处理注释。
3. 通过 MCP 工具 `find_hardcoded({kind: "username"})` 可查到所有写死的用户名。
