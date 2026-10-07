# 会话消息投递对接文档（local session send）

面向需要在**同一台机器**上给 zcode-server 所管理会话投递消息的外部程序：其他终端里的 agent、shell 脚本、自动化任务、CI 步骤等。行为规范见 `specs/server/local-session-send.md`。

## 一分钟版本

```bash
# 前提：zcode-server 在本机运行（dev 环境：pnpm dev:web，默认 http://localhost:3030）
# 且 Web 客户端里打开着某个会话（它就是默认投递目标）

zcode send "帮我看看构建日志"              # CLI 方式（推荐）
# 或
curl -X POST http://localhost:3030/api/local-send \
  -H 'content-type: application/json' \
  -d '{"content": "帮我看看构建日志"}'
```

消息送达后等同于用户在客户端亲自输入：会话空闲则**立即开新轮**，忙碌则进入**待发队列**（本轮结束后自动消费），transcript 中是一条普通用户消息。

## 送达语义（重要）

- 投递原语是 v4 `sendText` 命令，与 Web 客户端发送框同一条 admission 链；**不重试**——HTTP 200 只代表命令已被 agent 进程接受，后续排队/执行语义由 CLI runtime 裁决。
- 消息在 transcript 中是一条普通 `userInput` 行，客户端与手机远控都能看到。
- 一次一条消息；不支持附件（带附件请走客户端）。

## 目标会话解析规则

按优先级：

1. 请求体显式携带 `sessionId`；
2. Web 客户端上报的**当前活跃会话**（`activeTaskId` 变化时自动上报，见下）；
3. 都没有 → `404 no_active_session`。

注意事项：

- 活跃会话记录是 server **进程内存态**：server 重启后清空，需要显式传 `sessionId`，或等 Web 客户端切一次会话/重新加载后重新上报。
- 目标会话必须属于 server 配置的 workspace（`GET /api/server-info` 的 `workspaces` 字段，dev 默认为 server 进程 cwd）。其他 workspace 的 sessionId 会得到 `404 session_not_found`。
- 多个浏览器标签页同时打开时，**最近操作**的标签页上报获胜。

## HTTP 接口

所有接口位于 zcode-server（默认 `http://localhost:3030`），路径前缀 `/api/`。

### `POST /api/local-send` — 投递消息

请求体（JSON）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | string | 是 | 消息正文，1–100,000 字符 |
| `sessionId` | string | 否 | 显式目标会话（形如 `sess_xxx`），缺省用当前活跃会话 |

响应：

- `200 {"ok": true, "sessionId": "sess_..."}` — 已接受
- `400 {"error": "Invalid request body: ..."}` — body 校验失败
- `401 {"error": "Unauthorized"}` — 服务端启用 token 且未携带
- `404 {"error": "no_active_session", "hint": "..."}` — 无法解析目标
- `404 {"error": "session_not_found", "sessionId": "..."}` — 目标会话不在 server 管理的 workspace 内
- `503 {"error": "Task service is not available."}` — server 未装配任务服务
- `500 {"error": "<原因>"}` — 投递被拒或其他失败（含 v4 reasonCode 时会在 message 中）

服务端在投递前会按配置 workspace 预热任务索引并 `resume` 目标会话（从磁盘装载进 agent 进程），因此 **server 重启后** 或会话从未在本 server 上打开过时，显式 `sessionId` 的首次投递也能成功。

### `GET /api/active-session` — 查询当前活跃会话

`200 {"sessionId": "sess_..." | null, "reportedAt": "ISO 时间" | null}`。用于发送前探测目标，或调试上报链路。

### `POST /api/active-session` — 上报活跃会话

请求体 `{"sessionId": "sess_..." | null}`（`null` 表示清空）。通常**不需要外部调用**——Web 客户端已自动上报；此接口公开是为了让自定义前端/工具复用同一解析机制。

## 鉴权

与 server 既有 `/api/*` 语义完全一致：服务端以 `ZCODE_SERVER_AUTH_TOKEN` 启动时必须携带 token，否则（dev 默认）免鉴权。

token 传递方式（二选一，与 `/ws` 相同）：

- URL query：`POST http://localhost:3030/api/local-send?token=<TOKEN>`
- Cookie：`zcode_lite_token=<TOKEN>`（query 命中后自动回设）

## 调用方式

### 方式一：`zcode send`（推荐）

```bash
zcode send "<消息>"
zcode send "<消息>" --session sess_xxx        # 显式指定目标
zcode send "<消息>" --url http://localhost:3030 --token <TOKEN>
zcode send "<消息>" --json                     # 输出原始 JSON
```

环境变量回退：`ZCODE_SERVER_URL`、`ZCODE_SERVER_AUTH_TOKEN`。连接失败与 `no_active_session` 均有可读提示。

### 方式二：HTTP（任何语言/脚本）

```bash
curl -X POST "$ZCODE_SERVER_URL/api/local-send?token=$ZCODE_SERVER_AUTH_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"content\": \"构建失败，请分析日志\", \"sessionId\": \"$SESSION_ID\"}"
```

### 方式三：会话内的 agent（自用场景）

正在运行的 agent 会话可以用 Bash 工具直接调用方式一/二，把消息投给**另一个**会话（比如长驻监控会话给工作会话派发任务）。给自己所在会话投递时注意：忙碌期消息会排队到当前轮之后，不会打断当前轮。

## 错误处理建议

- **连接被拒 / 超时**：server 未启动或地址错误；确认 `GET /api/server-info` 可达后再重试。
- **401**：token 缺失或不匹配。
- **404 no_active_session**：让用户在 Web 客户端打开目标会话，或改用显式 `sessionId`。
- **404 session_not_found**：sessionId 不属于该 server 的 workspace（会话属于另一台 server/桌面端）。
- **500**：多为 v4 命令被拒（如会话正在迁移/已删除）。可安全重试一次；连续失败应停止并上报。
- 不要为 4xx 做自动重试；5xx 重试建议间隔 ≥ 2s。

## 桌面端（阶段二，预留）

桌面端任务的接收链路（main 进程本地控制 socket + 聚焦窗口活跃任务解析）在本阶段未实现；实现后本节将补充桌面端的 endpoint 与探测方式，`zcode send` 会优先探测桌面端、回退 zcode-server。
