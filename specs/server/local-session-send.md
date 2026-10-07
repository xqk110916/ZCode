# 本机会话消息投递（local session send）

## 产品规则

- 同一台机器上的外部进程（终端、脚本、其他 agent）可以把一条消息投递到 zcode-server 所管理的会话，语义与用户在 Web 客户端亲自输入完全一致：空闲时开新轮，忙碌时按 CLI 既有 admission 排队/steer，transcript 中是一条普通 `userInput` 消息。
- 默认投递目标是「当前活跃会话」：由 Web 客户端在 activeTaskId 变化时上报；显式传 `sessionId` 时以显式值为准。
- 投递原语唯一：服务端只走 `IZCodeTaskService.sendPrompt`（无附件路径即 v4 `sendText`，`heldQueueDisposition: keepQueueAndSend`），不新建平行队列或第二写入路径。
- 鉴权沿用既有 `/api/*` token 语义：设置 `ZCODE_SERVER_AUTH_TOKEN` 时必须携带 token（query 或 cookie），dev 默认免鉴权。本阶段仅支持同机使用，不做跨机器 relay。

## 状态所有者

- 「当前活跃会话」记录：zcode-server 进程内存（`createHttpServer` 内的 local-send 路由闭包），单值保存最近一次上报，易失；server 重启后清空，外部调用方需显式传 `sessionId` 或等客户端重新上报。多标签页/多客户端时最近上报者为准。
- 会话真实状态与消息准入：CLI runtime admission 是唯一事实源；server 不缓存会话 busy/空闲状态，不做重试。
- Web 客户端 activeTaskId 仍是 renderer 内存状态（Zustand），仅通过 `IPlatformService.syncActiveTaskSession` 上报快照，不反向读取。

## 接口

- `POST /api/active-session`：body `{ sessionId: string | null }`（zod：`activeSessionReportSchema`）。`null` 表示当前无活跃会话，清空记录。Web 平台层在 sessionId 变化时调用，fire-and-forget。
- `GET /api/active-session`：返回 `{ sessionId: string | null, reportedAt: string | null }`，用于调试与对接方探测。
- `POST /api/local-send`：body `{ content: string(1..100_000), sessionId?: string }`（zod：`localSendSchema`）。处理顺序：
  1. 解析目标：`sessionId` 显式值 > 最近上报的活跃会话；都无 → `404 { error: "no_active_session" }`。
  2. `IZCodeTaskService` 未注册 → `503`。
  3. 预热：对 server 配置的每个 workspace 调 `listTasks` / `listPinnedTasks` / `listArchivedTasks`，填充内存 taskTargets 并定位目标 meta；索引中无该会话 → `404 { error: "session_not_found" }`。
  4. `resumeTask` 把目标会话按磁盘装载进 workspace 级 agent 进程（CLI 网关的 `sendText` 只对已加载会话生效，冷会话会以 `proto.sessionNotFound` 拒绝；顺序与 cron 派发的 resume→send 一致），随后 `sendPrompt({ taskId, traceId: randomUUID(), content })`；成功 → `200 { ok: true, sessionId }`。
  5. 错误映射：`ZCODE_SESSION_TARGET_NOT_FOUND` → `404 { error: "session_not_found" }`；v4 命令被否决（`ZCODE_V4_COMMAND_REJECTED`）→ `500` 且 message 含 reasonCode；其余 → `500 { error: message }`。
- 调用方入口：`zcode send "<message>" [--session <id>] [--url <url>] [--token <token>]`（`apps/zcode-cli`），env 回退 `ZCODE_SERVER_URL` / `ZCODE_SERVER_AUTH_TOKEN`；对接说明见 `docs/session-send-api.md`。

## 验收场景

1. Web 客户端打开某会话后，`zcode send "hi"`：消息出现在该会话 transcript 并开新轮。
2. 目标会话忙碌时投递：消息进入待发队列（客户端 UI 可见），不丢失。
3. 无上报且未显式指定 sessionId：返回 `404 no_active_session`，CLI 提示可操作的指引。
4. `--session` 显式指定非当前会话：投递到指定会话。
5. server 重启后（内存上报已清空）显式 `--session` 投递：预热生效，投递成功。

## 迁移边界

- 桌面端（阶段二）：main 进程本地控制 socket + 聚焦窗口活跃任务解析 + adapter `deliverSessionMessage` 实现，复用同一份对接文档补充章节；本阶段不改动 `packages/desktop`。
- 终端 TUI 会话接收（mailbox 空闲唤醒）、跨机器 relay、token 文件发现机制均不在本阶段范围。
