# BoardHub 独立应用（dbBoard + Paperclip 客户端）

## 目标与边界

BoardHub 是 monorepo 内的独立 Web 应用，把「数据库看板（dbBoard）」与「Paperclip 任务编排客户端」从 ZCode 主应用中抽出来单独使用；后续可通过静态托管 + 极简 Electron 壳演进为桌面端。

- 复用 `@zcode/services` 的 dbBoard 三件套与 paperclip 服务、`@zcode/ui` 的 `DbBoardPage` / `PaperclipPage`，不复制业务代码。
- 不包含 ZCode agent 会话、任务运行时、OAuth 登录、计费链路；裁剪版服务端只注册 BoardHub 所需服务。
- AI 能力（看板 NL 生成、知识库蒸馏）经 BoardHub 自配的 OpenAI 兼容 API 直连，不依赖 ZCode 账号体系。
- 本期不做：Electron 壳、dbBoard 助手对话 UI（依赖 ZCode 会话，隐藏入口；MCP server 装配保留，二期可独立暴露）、Paperclip 自主执行/自动认领、TUI。

## 包结构

| 包                         | 职责                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `packages/boardhub-server` | 裁剪版服务端：装配 + OpenAI 兼容模型运行时 + HTTP/WS 宿主         |
| `packages/boardhub-web`    | 轻量前端：vite + ServiceProvider + 顶部 Tab（看板 / 任务 / 设置） |

## 状态所有者

| 状态                                                                  | 所有者                                                                       | 说明                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 应用设置（locale、paperclipServerUrl、boardhubModelBaseUrl/Id）       | `ISettingService` → `~/.boardhub/.zcode/v2/setting.json`                     | 复用 `createSettingService()`                                       |
| 凭据（数据库密码、Nacos 密码、paperclip token、boardhub 模型 apiKey） | `ICredentialService` → 同目录 `credentials.json`（加密）                     | 复用 `createCredentialService()`                                    |
| 跨页广播                                                              | `IBroadcastService`（`createBroadcastService(null)`，无跨窗口能力）          | 单页应用，仅本地 emitter                                            |
| dbBoard 连接/绑定/审计                                                | `IDbBoardService`                                                            | bindings 恒空 = legacy 模式，所有功能可用                           |
| 看板定义 / 知识库                                                     | `DbBoardDashboardStore`（custom-resources.sqlite）/ `dbBoard-knowledge.json` | 同目录隔离                                                          |
| Paperclip 任务事实                                                    | Paperclip server（外部进程）                                                 | BoardHub 仅 REST+WS 客户端投影，不镜像不缓存                        |
| 模型调用                                                              | `boardhubModel`（boardhub-server 内）                                        | 读 settings + credential，`fetch` 直连 `{baseUrl}/chat/completions` |

数据隔离：entry 启动即调用 `setDataBaseDir(join(homedir(), ".boardhub"))`（优先级高于环境变量与 `~/.zcode` 默认），BoardHub 与 ZCode 主应用的配置、凭据、看板互不可见。

## 模型运行时（boardhubModel）

- 配置：`boardhubModelBaseUrl` / `boardhubModelId` 存 settings（`ZCodeAppSettings` 新可选字段），API key 存 credential（key：`boardhub-model-api-key`）。
- `readCurrentModel()`：三项配置齐全时返回 `{ providerId: "boardhub-openai-compat", modelId }`；否则 `null`（dbBoard 据此报 model-unavailable，纯浏览/查询不受影响）。
- `generateText(params)`：`POST {baseUrl}/chat/completions`（Bearer apiKey），`messages: [{role:"user", content: prompt}]`，`max_tokens = params.maxOutputTokens ?? 4096`；`params.timeoutMs` → `AbortSignal.timeout`。非 200 / 超时 / 空回复抛错，由 dbBoard 既有错误路径呈现。
- 不支持流式；`selection` 仅承载 providerId/modelId，不透传 options。

## 服务端装配（entry）

```
setDataBaseDir(~/.boardhub)
settingService = createSettingService()
credentialService = createCredentialService()
broadcastService = createBroadcastService(null)
model = createBoardhubModelRuntime({ settingService, credentialService })
dbBoardService = createDbBoardService({ credentialService, loadKnowledge, readCurrentModel, generateText })
dbBoardKnowledgeService = createDbBoardKnowledgeService({ credentialService, dbBoardService, readCurrentModel, generateText })
dbBoardAgentService = createDbBoardAgentService({ dbBoardService, dbBoardKnowledgeService })
paperclipService = createPaperclipService({ settingService, credentialService })
services = new ServiceCollection().register(ISettingService, …).register(ICredentialService, …)
  .register(IBroadcastService, …).register(IDbBoardService, …).register(IDbBoardKnowledgeService, …)
  .register(IDbBoardAgentService, …).register(IPaperclipService, …)
createHttpServer(services, PORT 默认 3210（0=随机）, { host 默认 127.0.0.1, staticRoot?, spaFallback: true, authToken? })
```

不注册 `zcodeAgentService`；dbBoard workspaceKey 由前端传固定值 `"boardhub"`。

- **网络边界**：默认只绑回环——channel 上有凭据与数据库配置服务，无 `authToken` 时绝不能暴露到局域网；外部访问需显式 `BOARDHUB_SERVER_HOST=0.0.0.0`。
- **端口回传**：`PORT=0` 时实际端口经 stdout 协议行 `BOARDHUB_SERVER_READY {"port":N}` 回传（桌面壳消费），消除「先探测再启动」的 TOCTOU 竞态。
- **日志落盘**：console（log/info/warn/error）tee 到 `~/.boardhub/logs/boardhub-server.log`（超 5MB 保留一份旧档；debug 不落盘）——打包形态没有终端，该文件是错误页指引的排查渠道。
- **跨进程写并发**（Web 版与桌面版共用 `~/.boardhub`）：`setting.json` 写入、dbBoard 连接配置变更（`mutateConfigFile`：锁内读最新 → 定向变更 → 原子写回，内存态从 doc 回同步，**不做全量内存覆盖**）、使用情况汇总、知识库 JSON 写入均走 `withFileLock` 共享文件锁（与凭据写入同模式）；知识库构建仍为单实例语义（双开同时构建未定义）。

## 前端（boardhub-web）

- 入口不挂 `Root`：`connectViaWebSocket(/ws)` → `ServiceProvider` → `ZCodeIntlProvider`（不传 setting/broadcast，localStorage 偏好）→ 主题 class → `<Toaster/>`。
- 布局：顶部 Tab 切换 `DbBoardPage`（`agentChatEnabled=false`、workspacePath=`"boardhub"`）与 `PaperclipPage`（不传执行回调与 workspacePath——无 ZCode 工作区上下文，创建任务不提供「当前工作区」项目绑定）与设置页。
- 设置页：模型配置（baseUrl / modelId / apiKey，apiKey 走 credentialService）+ Paperclip 连接（serverUrl / token）+ 本地 server 启停；`PaperclipSettingsSection` 传 `showAutoClaim={false}`（独立版自动认领永不生效）。
- vite alias `@` → `../ui/src`，复用 `@zcode/ui/styles.css` 与组件库；平台能力用 `@zcode/client/web-platform` 的 `createNoopWebPlatform()`（与 ZCode Web 端共享 no-op 基座，后者在其上覆盖产品化方法）。

## 桌面端（Electron 壳，packages/boardhub-desktop）

形态：极简 Electron 壳，**不复用** `packages/desktop` 的 host 进程 / native 闭包 / 自动更新等 ZCode 专属设施。

- **进程模型**：main 进程（tsup 产物）→ `utilityProcess.fork` 拉起 boardhub-server 单文件 bundle（esbuild 全内联 CJS，同 `packages/server/build-remote.ts` 模式：banner 注入 `import.meta.url` 等价物、`node:` 内置模块自动 external），`BrowserWindow.loadURL("http://127.0.0.1:{port}")` 加载 server 静态托管的 web 产物——同源 `/ws` 直接可用，前端零改动。
- **端口协商**：server 以 `PORT=0` 随机端口启动，main 从其 stdout 解析 `BOARDHUB_SERVER_READY {"port":N}` 协议行（等待上限 15s），READY 后以 `/api/server-info` 确认（5s）再开窗；失败展示错误页（附日志文件路径 `~/.boardhub/logs/boardhub-server.log`）。
- **崩溃自愈**：server 子进程意外退出时（非 app 退出），若有存活窗口则按退避序列 [1s, 5s, 15s] 重启 server（新端口）并 `loadURL` 重载窗口（端口已变，reload 无效）；连续 3 次失败停止自动重试并展示错误页。`before-quit` 置 quitting 标志防止退出路径触发自愈。
- **生命周期**：`window-all-closed`（非 macOS）退出；`will-quit` 杀 server 子进程；macOS `activate` 重建窗口（server 进程跨窗口存活，端口复用）。
- **数据目录**：沿用 `~/.boardhub`（server entry 内 `setDataBaseDir`），与 Web 版共用配置；桌面壳不引入 sandbox / App Support 重定向。
- **产物布局**：`resources/server/entry.cjs` + `resources/web/`（vite build），`asar: false`（内部工具首版从简；静态托管与 utilityProcess 均以真实路径运行，规避 asar fs 差异）。
- **dev 模式**：`ELECTRON_START_URL`（默认 `http://localhost:5175`）直接加载 vite dev server，配合 `pnpm dev:boardhub` 使用，主进程不拉子进程。
- 打包：electron-builder（mac dmg 优先，win nsis 留配置）；Electron / electron-builder 版本对齐 `packages/desktop`（41.0.3 / ^26.8.1）。

## 对现有代码的兼容改动

- `PaperclipPage`：`onExecuteInZCode` / `onAutoExecuteInZCode` / `workspacePath` 改可选；执行回调未传时隐藏对应按钮且 `usePaperclipAutoClaim` 不启用（读 `paperclipAutoClaim` 处同门控）；`workspacePath` 未传时创建对话框不提供「当前工作区」项目选项。ZCode 主应用传参不变。
- `PaperclipSettingsSection`：新增可选 prop `showAutoClaim`（默认 `true`）；`false` 时隐藏自动认领开关。
- `settingService` / dbBoard 配置与知识库写入 / 使用情况汇总：写路径统一 `withFileLock` 共享文件锁（跨进程丢更新防护，见服务端章节）；dbBoard 配置由「全量内存态覆盖」改为「锁内定向变更」。
- `@zcode/client` 新增 `web-platform` 子路径导出（`createNoopWebPlatform`）；`packages/web` 的 `createWebPlatform` 改为基座 + 产品化方法覆盖。
- `DbBoardPage`：新增可选 prop `agentChatEnabled`（默认 `true`）；`false` 时不渲染 `DbBoardAgentChatEntry`。
- `ZCodeAppSettings` + `validationAppSettings.ts`：新增 `boardhubModelBaseUrl?` / `boardhubModelId?`（均为可选字符串，前者 URL 形态校验）。

## 验收场景

1. **启动**：`pnpm dev:boardhub` 后访问 vite 端口，三 Tab 可切换；`~/.boardhub/.zcode/v2/` 下生成配置文件，`~/.zcode` 不新增 boardhub 相关文件。
2. **模型未配置**：看板生成入口报模型不可用；数据浏览 / SQL 查询 / 审计日志 / 手动看板不受影响。
3. **模型已配置**（OpenAI 兼容端点）：自然语言生成看板成功；知识库构建（蒸馏）成功。
4. **Paperclip**：设置 serverUrl+token 后任务板渲染、issue 增改查、agent 配置、本地 server 启停可用；无「在 ZCode 中执行」与自动认领。
5. **主应用回归**：`pnpm dev:web` 下 Paperclip 自主执行、自动认领、dbBoard 助手对话行为与改动前一致。
