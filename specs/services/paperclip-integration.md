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
  404/多公司时取第一个（V1 单公司假设），失败不落盘。列表为空（全新实例，onboard
  不建公司）时自动创建默认公司 "ZCode" 后连接（首连自举），创建失败按断连口径抛错。
- ZCode 侧只读 agent 列表；对 agent 的**写操作收敛为两类**：更新模型/推理力度
  （`updateAgent`，merge 语义）与一键确保 dispatcher 存在（`ensureDispatcherAgent`）。
  agent 的常规雇佣与完整 adapter 配置留在 Paperclip 自身 UI 完成。
- 派单即唤醒：`POST /api/companies/{companyId}/issues` 带 `assigneeAgentId` 后由
  Paperclip heartbeat 队列驱动执行，ZCode 不拉起任何任务执行 CLI 进程（本地 server
  进程的代为启停见「本地服务生命周期」节，属有意边界扩展）。
- **模型配置**：模型/effort 的事实源是 Paperclip（`adapterConfig.model/effort` +
  config-revisions 审计）；UI 下拉只是当次查询 `GET .../adapters/{type}/models`
  的投影 + `PATCH /api/agents/{id}` 写路径。effort 档位与模型的适配由 Paperclip
  校验，422 原因如实展示。
- **自动分派与主 Agent**：dispatcher = 公司内 `role === "ceo"` 的 agent（第一个）。
  - 团队新增第一个 agent 时若无 dispatcher，默认其成为主 Agent（role=ceo）。
  - 主 Agent 标识可在 agent 配置弹窗手动切换（`PATCH role=ceo`，原主 Agent 回落
    general；Paperclip 侧 ceo 唯一，切换即时生效不随表单提交）。
  - 创建任务对话框的指派**默认值为直接指派给主 Agent**（用户可改选「主 Agent
    自动分派」/其他 agent/不指派）；主 Agent 行内带标识徽章。
  - 「主 Agent 自动分派」选项：无 dispatcher 时可一键创建（默认 `claude_local`
    复用宿主机 CLI 登录态）。**分派决策的所有者是 dispatcher 的 LLM**（经
    Paperclip 员工技能创建子任务/指派/自处理）；ZCode 不做客户端侧的任务规模
    判断，只在自动分派提交时把分派指令模板（`PAPERCLIP_DISPATCH_DIRECTIVE`）
    拼入 description——模板在对话框中有提示，用户可见可预期。
- **agent 唯一性**：每个 CLI（adapterType）只允许注册一个 agent——添加弹窗对已
  存在的 adapter 禁选并标注「已添加」，服务层 `createAgent` 重复时拒绝（409 语义）。
- **agent 删除**：agent 卡片提供删除（`DELETE /api/agents/{id}`），卡片内两步确认
  （4s 自动复位）；主 Agent 也可删除（删除时悬停提示团队将失去主 Agent，新任务
  默认指派与自动分派需先补位），删除成功从本地列表移除并 toast 反馈。
- **工作区绑定**：创建任务可选绑定 Paperclip 项目（任务执行时从项目工作区解析
  git worktree）。「当前工作区」选项把当前 ZCode workspace 路径映射为
  `local_path` 项目（`ensureProjectForWorkspace` 按 `codebase.localFolder === cwd`
  幂等匹配，首次按需创建）；已注册时创建对话框默认选中。项目/仓库的常规管理
  留在 Paperclip UI。
- **本地 agent 注册**：「添加 agent」按本机 CLI 探测结果注册对应 local adapter
  （复用 CLI 已有登录态，不配 key）；探测只是展示提示，不阻断创建。
- **模型双来源**：agent 配置弹窗的模型清单 = Paperclip adapter 静态清单 +
  本机 Claude Code 网关发现（见接口节）；手动输入的模型 ID 优先生效。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 任务（issue）、agent、company | Paperclip server | Paperclip 的 PostgreSQL |
| agent 模型/effort 配置 | Paperclip server（`adapterConfig` + config-revisions） | 同上 |
| 分派决策（单/多 agent、子任务拆解） | dispatcher agent 的 LLM（运行时） | Paperclip 任务线程（可审计的评论与子任务） |
| server URL 配置 | `ISettingService` | `~/.zcode/v2/setting.json`（`paperclipServerUrl`） |
| Bearer token | `ICredentialService` | 加密 `credentials.json`（key `paperclip-api-token`） |
| companyId 缓存 | `PaperclipService`（host/server 进程内） | 进程内存，重启重解析 |
| WS 连接与重连状态机 | `PaperclipService`（host/server 进程内） | 进程内存 |
| UI 任务列表投影 | `PaperclipPage` 组件树 | React state，unmount 即弃 |

## 本地服务生命周期（`startLocalServer` / `stopLocalServer` / `getLocalServerStatus`）

- **所有者**：本机 Paperclip server 是独立进程；ZCode 只"发命令 + 健康探测"（`GET /api/health`，
  3s 超时）。多窗口/多宿主并发启动由"启动前先探 health"守卫幂等（已 running 直接返回）。
- **平台默认策略（全平台原生运行，数据库一律外置 PostgreSQL，由系统服务承载）**：
  - Windows：`npx.cmd -y paperclipai@latest run` 原生 detached 启动；数据库连接串持久化在
    实例配置（`~/.paperclip/instances/default/config.json`），无需命令行注入。停止经
    powershell `Get-CimInstance` 按命令行模式匹配终止 node 进程（字符类技巧 `paperclip[a]i`
    避免过滤串自匹配）；外置 PostgreSQL 服务不随 server 停止（系统服务语义）。
    注：内置 Administrator 账户的全权令牌使内嵌 PostgreSQL 无法原生运行——外置 PG 服务
    （如 PostgreSQL 17 Windows 服务）是 Windows 上的唯一支持形态。曾用 WSL 承载（规避
    令牌问题），已废弃：WSL 与 Windows 双环境导致 CLI 检测（Windows 侧）与 agent 执行
    （WSL 侧）不一致（grok 装在用户级 PATH，WSL 互操作不可见，agent 无法启动）。
  - macOS/Linux：原生运行 `npx -y paperclipai@latest run`（detached + setsid/nohup 守护，日志
    `~/.paperclip/server-run.log`，进程独立于 ZCode 存活）；停止 pkill（同款字符类技巧）。
  - npx 解析：GUI/服务进程 PATH 常不含 nvm——Windows 依次搜 `C:\nvm4w\nodejs\npx.cmd` →
    `%APPDATA%\npm\npx.cmd` → PATH 兜底；POSIX 依次搜 `~/.nvm/versions/node/<最新>/bin` →
    Homebrew → 系统 PATH。
- **时序**：start = 探 health（已 ok → 幂等 running）→ 发启动命令 → 轮询 health（3s 间隔、上限
  **300s**——实测冷启动约 130s，npx 解析另需约 30s）→ running / 超时 error（detail 带日志
  位置）。stop = 探 health（未运行 → 幂等 stopped）→ 发停止命令 → 轮询 health 直到失败（2s 间
  隔、上限 20s）。启动成功后服务侧主动重连一次（不等 WS 退避）。
- **停止语义**：按 `paperclipai` 进程模式匹配，可能命中用户其他同名进程——停止仅由用户显式
  触发（面板/设置页按钮），个人机语义可接受。launchd/systemd 托管的 Paperclip（macOS
  managed install）与本机制互不冲突：health 守卫保证幂等。
- 实现位于 `packages/services/src/paperclip/paperclipLocalServer.ts`（依赖全注入可测）；UI 入口：
  Paperclip 面板断连引导区「启动本地服务」+ 连接状态条「停止服务」+ 设置页「本地服务」块。

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
  listAdapterModels(adapterType: string): Promise<PaperclipAdapterModel[]>;
  discoverClaudeModels(): Promise<PaperclipAdapterModel[]>;
  updateAgent(agentId: string, patch: PaperclipUpdateAgentInput): Promise<PaperclipAgent>;
  ensureDispatcherAgent(): Promise<PaperclipAgent>;
  createAgent(input: { name: string; adapterType: string; role?: string }): Promise<PaperclipAgent>;
  detectLocalAgentAdapters(): Promise<PaperclipLocalAdapterCandidate[]>;
  listProjects(): Promise<PaperclipProject[]>;
  ensureProjectForWorkspace(input: { name: string; cwd: string }): Promise<PaperclipProject>;
  listIssues(filter?: PaperclipIssueFilter): Promise<PaperclipIssue[]>;
  createIssue(input: PaperclipCreateIssueInput): Promise<PaperclipIssue>;
  updateIssue(issueId: string, patch: PaperclipUpdateIssueInput): Promise<PaperclipIssue>;
  postComment(issueId: string, body: string): Promise<void>;
  onDidChangeConnectionState: Event<PaperclipConnectionStateSnapshot>;
  onDidReceiveIssueEvent: Event<PaperclipIssueEvent>;
}
```

- `updateAgent` 走 `PATCH /api/agents/{id}` 的 `{name?, adapterConfig: {model?, effort?}}`
  （merge 语义：只传要改的字段）；`ensureDispatcherAgent`/`ensureProjectForWorkspace`
  幂等（命中即返回；创建撞唯一性约束时回读取既有）。
- `detectLocalAgentAdapters` 在 host 进程用 which/where 探测本机 CLI；判定只看
  是否抛错（stdio ignore 时返回值恒为 null，不可用作依据）。
- `discoverClaudeModels` 读 `~/.claude/settings.json` 的 env 网关配置，直接调第三方
  网关 `/v1/models` 拉真实模型（60s 内存缓存）；凭证只发往其配置的端点，不落日志、
  不持久化；无配置或失败返回空，UI 回落 Paperclip 静态清单 + 手动输入兜底。

- descriptor 频道 `ServiceChannels.Paperclip = "paperclip"`；注册进
  `services/src/node.ts` 的 `createLocalServices` 注册链。
- REST 客户端 `paperclipRestClient.ts`：依赖注入（resolveBaseUrl/resolveToken/
  fetchImpl/logger），10s 超时，类型化 `PaperclipApiError`（httpStatus + body 摘要）。
- 日志走 `createServiceLogger("paperclip")`；token/URL query 永不落日志。

UI（`packages/ui/src/paperclip/`）：`PaperclipPage` 主视图（`WorkspaceMainView` 加
`"paperclip"`，Plugin Store 同构入口）；设置分区 `PaperclipSettingsSection`。

面板呈现规则（纯投影，不改事实源）：

- 首次拉取未返回前展示骨架占位，不用空态文案冒充「无数据」；已有数据后的手动刷新
  不打断当前列表。
- 状态筛选覆盖全部六种状态并带任务计数；`done`/`cancelled` 在列表内沉底，
  其余按 `updatedAt`（缺省 `createdAt`）倒序。
- 优先级用语义色区分强度（urgent=危险、high=警告、medium=信息、low=弱化）；
  issue 编号用等宽字体弱展示；agent 卡片的 `active`/`paused` 状态走 i18n
  与语义色，未知状态值原样弱展示。
- 连接状态条区分 `connected`（成功色）/`polling`（警告色）/`connecting`（信息色）
  三种标签与图标，不把 `connecting` 误标为手动刷新。

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
7. agent 卡片打开配置弹窗：模型下拉来自该 adapterType 的当次 API 查询；保存后
   卡片模型徽章更新（PATCH 返回的权威状态），Paperclip 侧 config-revisions 有记录；
   effort 与模型不匹配被 422 拒绝时弹窗展示可读原因且不关闭。
8. 无 dispatcher 时创建任务：选择「主 Agent 自动分派」显示创建引导；一键创建后
   选项立即可用。重复触发 `ensureDispatcherAgent` 不会创建第二个 ceo。
9. 自动分派提交：description = 用户描述 + 分派指令模板（对话框有提示），
   assigneeAgentId = dispatcher；Paperclip 侧 dispatcher 被 heartbeat 唤醒，
   其决策（自处理或创建子任务指派）体现在任务线程与子任务列表，面板经 WS/
   刷新可见。
10. 「添加 agent」：本机已装的 CLI 显示「已检测到」，选中创建后立即出现在团队
    列表；未装的 CLI 也可创建但标注「未检测到」。重复探测结果一致（缓存一次）。
11. 工作区绑定：选中「当前工作区」提交后，Paperclip 项目列表出现对应
    `local_path` 项目（cwd = ZCode workspace 路径），issue 带 projectId；再次
    提交不重复建项目（幂等）。agent 配置弹窗改名保存后列表与指派选项即时更新。
12. 模型发现：本机 Claude Code 配置了第三方网关时，配置弹窗顶部展示「本机网关」
    分组的真实模型（实测 11 个 GLM）；未配置/失败时仅显示 Paperclip 静态清单，
    手动输入仍可保存任意模型 ID。

## ZCode 自主执行模式（`ensureZCodeAgent` / `claimIssueForZCode` / `executeInZCode`）

ZCode 不作为被 Paperclip 驱动的 adapter（无 heartbeat 执行体、不 spawn 子进程），
而是 Paperclip 的**自主执行端**：Paperclip 只做任务账本，执行与进度完全由 ZCode
把控。身份 = 公司内 `adapterType === "http"` 的 agent（名为 "ZCode"，公司内唯一，
`ensureZCodeAgent` 幂等创建/命中，**创建后自动 pause**）。

事件顺序：任务指派给 ZCode agent → 面板任务行显示「在 ZCode 中执行」→ 点击后
`claimIssueForZCode`（board 身份 `POST /issues/{id}/checkout`，CAS 语义
`expectedStatuses: [todo, in_progress, blocked]`，成功后 status → in_progress）→
认领成功回调外层创建本地 ZCode 任务（prompt = 标题+描述，切回聊天主视图）→
执行全程在 ZCode（用户可见可插话）→ 完成后经既有 board 写路径回写（markDone /
评论）。

实测依据（写入前验证过）：

- agent API key 直写 issue 需要真实 heartbeat run 上下文（自造 runId 返回 401
  "Cross-issue writes need a run"）——run 只能由 Paperclip 的 webhook 唤醒产生，
  桌面形态无常驻端口，故 V1 不走 agent key；认领与回写均为 board 代操作（本地
  部署 board 即用户本人，审计记 board 名下）。
- checkout body 必须带 `{agentId, expectedStatuses}`；checkout 是临时检出（绑
  run、结束释放），**没有持久认领人字段**——认领身份即 assignee，效果是状态
  转 in_progress。
- 未配 webhook 的 http agent 会被 heartbeat 反复执行失败并把任务标 blocked
  （实测 statusVersion 递增），因此 ensure 后必须 pause 该 agent 暂停心跳。

边界：ZCode agent 的 Paperclip 状态灯恒为「自主执行」（paused 的模式语义，非异常）；
本地任务与 issue 的映射不做持久化，回写由用户在面板确认（markDone 带摘要评论）。

**自动认领**（`AppSettings.paperclipAutoClaim`，设置分区与待办横幅均有开关）：开启后
面板对"新出现"的待 ZCode 执行任务自动认领，并在任务绑定项目对应的工作区（未打开
则活动工作区）后台自动执行：`startDraft` + 草稿事实源预填（降级保障）→ 等 v4 预热
握手写入 `draftSessionId` → 经 `IZCodeTaskService.sendPrompt` 自动发送（与
`zcode send` / local-send 完全同一条 admission 链：空闲开新轮、忙碌排队；见
`specs/server/local-session-send.md`）。不 `focusWorkspace`、不切视图、不抢活动
标签；预热 10s 未就绪或发送失败均降级为预填草稿（用户手动发送），不打断用户。
防重两级：内存 Set + sessionStorage（`paperclip-auto-claimed`），只处理差分新出现
的任务；已在场的任务留给用户手动。

13. ZCode 自主执行：指派给 ZCode（http agent）的任务出现「在 ZCode 中执行」；
    点击后该 issue 状态原子转 in_progress（CAS：他人已认领/状态漂移时报冲突），
    ZCode 创建本地任务并切到聊天视图；完成后点「完成」回写 done + 摘要评论。
    ZCode agent 在 Paperclip 侧保持「已暂停」（不被 heartbeat 驱动，任务不会被
    误标 blocked）。
