# Paperclip 集成：外部 Agent 编排任务的客户端接入

## 背景与目标

Paperclip（github.com/paperclipai/paperclip）是独立部署的开源 AI Agent 编排平台：管理一组
CLI agent（Claude Code、Grok Build、Codex 等），以 issue 为工作单元，由 heartbeat 引擎唤醒
agent 执行。本集成**不引入 Paperclip 的任何代码**，ZCode 仅作为其 REST API + WebSocket 的
客户端，让用户在 ZCode 内（Web 与桌面双端）：

1. 配置 Paperclip server 地址与可选 Bearer token；
2. 查看 Paperclip 里的 agent 列表；
3. 创建 issue 并指派给 agent（Paperclip 收到后自动入唤醒队列，唤醒对应 CLI agent）；
4. 实时跟踪 issue 状态变化（live-events WebSocket 订阅，失败降级为手动刷新）。

## 产品规则

- Paperclip 是任务与 agent 的**唯一事实源**：ZCode 不镜像、不缓存任务到本地持久化；
  列表数据总是来自当次 API 查询或当次进程内订阅投影。
- 连接配置：`AppSettings.paperclipServerUrl`（可选覆盖；env `PAPERCLIP_SERVER_URL`，
  缺省 `http://localhost:3100`）。token 存 `ICredentialService`（key
  `paperclip-api-token`），可为空（Paperclip trusted-local 模式免认证）。
- 未配置或连接失败时，面板显示连接状态与「去设置」引导；不阻塞 ZCode 其他功能。
- `companyId` 由服务在首次成功调用 `GET /api/companies` 时解析并仅存进程内存；
  404/多公司时取第一个（V1 单公司假设），失败不落盘。
- ZCode 只读 agent、只写 issue（创建/更新/评论）；agent 的雇佣与 adapter 配置留在
  Paperclip 自身 UI 完成。
- 派单即唤醒：`POST /api/companies/{companyId}/issues` 带 `assigneeAgentId` 后由
  Paperclip heartbeat 队列驱动执行，ZCode 不直接拉起任何 CLI 进程。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 任务（issue）、agent、company | Paperclip server | Paperclip 的 PostgreSQL |
| server URL 配置 | `ISettingService` | `~/.zcode/v2/setting.json`（`paperclipServerUrl`） |
| Bearer token | `ICredentialService` | 加密 `credentials.json`（key `paperclip-api-token`） |
| companyId 缓存 | `PaperclipService`（host/server 进程内） | 进程内存，重启重解析 |
| WS 连接与重连状态机 | `PaperclipService`（host/server 进程内） | 进程内存 |
| UI 任务列表投影 | `PaperclipPage` 组件树 | React state，unmount 即弃 |

## 数据流与事件顺序

```
UI (renderer/浏览器, 双端)
  PaperclipPage ──usePaperclip──► IPaperclipService (RPC: MessagePort / WS)
                                       │
Host (桌面窗口 utilityProcess) / server (Web) 进程
  PaperclipService
    ├─ RestClient ──HTTP──► Paperclip :3100 /api/...
    ├─ LiveEvents ──WS────► Paperclip live-events（company 级，指数退避重连）
    └─ 配置读取：settingService + credentialService
```

事件顺序（连接生命周期）：

1. 首次调用（或设置变更后首次调用）→ 解析 URL + token → `GET /api/health`
   探活 → `GET /api/companies` 解析 companyId（内存缓存）→ 状态置 `connected`。
2. companyId 就绪后建立 live-events WS；断开按 1s/2s/4s…封顶 30s 退避重连，
   每次状态迁移发 `onDidChangeConnectionState`。
3. WS 收到 issue 相关事件 → 规范化 → `onDidReceiveIssueEvent` → UI 更新投影；
   WS 不可用（认证拒绝/路径 404）时置 `polling` 降级态，UI 提供手动刷新。
4. 设置变更（`paperclipServerUrl` 或 token 重存）→ 服务下一次调用时重建客户端与
   WS（旧连接 dispose）；不做热切换竞态处理，以最后一次配置为准。

幂等与边界：

- `createIssue` 无幂等键：由用户显式提交动作触发，重复点击由 UI 禁用提交按钮防抖。
- 服务实例随 `createLocalServices` 生命周期存在；dispose 时关闭 WS 与未决请求。
- 双端多窗口（桌面每窗口一个 Host）会各持一条 WS：Paperclip 按多客户端设计，可接受。

## 接口

`packages/shared/src/paperclip.ts`：DTO + zod schema（宽容解析、未知字段透传）：
`PaperclipAgent`、`PaperclipIssue`、`PaperclipIssueStatus`、`PaperclipConnectionState`
（`disconnected | connecting | connected | polling`）、`PaperclipIssueEvent`、
`PaperclipCreateIssueInput`、`PaperclipUpdateIssueInput`。

`packages/services/src/paperclip/paperclip.ts`（browser-safe，根入口导出）：

```ts
interface IPaperclipService {
  getConnectionState(): Promise<PaperclipConnectionStateSnapshot>;
  testConnection(url: string, token?: string): Promise<PaperclipTestConnectionResult>;
  listAgents(): Promise<PaperclipAgent[]>;
  listIssues(filter?: PaperclipIssueFilter): Promise<PaperclipIssue[]>;
  createIssue(input: PaperclipCreateIssueInput): Promise<PaperclipIssue>;
  updateIssue(issueId: string, patch: PaperclipUpdateIssueInput): Promise<PaperclipIssue>;
  postComment(issueId: string, body: string): Promise<void>;
  onDidChangeConnectionState: Event<PaperclipConnectionStateSnapshot>;
  onDidReceiveIssueEvent: Event<PaperclipIssueEvent>;
}
```

- descriptor 频道 `ServiceChannels.Paperclip = "paperclip"`；注册进
  `services/src/node.ts` 的 `createLocalServices` 注册链。
- REST 客户端 `paperclipRestClient.ts`：依赖注入（resolveBaseUrl/resolveToken/
  fetchImpl/logger），10s 超时，类型化 `PaperclipApiError`（httpStatus + body 摘要）。
- 日志走 `createServiceLogger("paperclip")`；token/URL query 永不落日志。

UI（`packages/ui/src/paperclip/`）：`PaperclipPage` 主视图（`WorkspaceMainView` 加
`"paperclip"`，Plugin Store 同构入口）；设置分区 `PaperclipSettingsSection`。

## 验收场景

1. 未配置时打开面板：显示 `disconnected` 状态条与设置引导；无报错弹窗。
2. 配置地址指向运行中的 Paperclip（trusted-local）：状态条转 `connected`，
   agent 列表展示名称/类型/模型。
3. 创建 issue（标题+描述+指派 agent）：列表出现新任务；Paperclip 侧该 agent 被
   唤醒执行；状态变化经 WS 推送回面板（无 WS 时手动刷新可见）。
4. `updateIssue` 置 `done` 带 comment：Paperclip 任务线程出现该评论。
5. 断开 Paperclip 进程：状态条转 `disconnected`，操作返回类型化错误；恢复进程后
   重连自动转回 `connected`（退避重连生效）。
6. 错误地址/token：`testConnection` 返回可读失败原因；面板不崩溃。
