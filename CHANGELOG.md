# Changelog

本文件记录基于上游 ZCode（zai-org/ZCode）的自定义改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] - 2026-09-30

基线：上游 `3bb1dd9`（v3.14.3）。

### 新增

#### 本机会话消息投递（local session send）

- 新增 `zcode send "<消息>"` CLI 子命令与 zcode-server 三个 HTTP 端点（`POST /api/local-send`、`GET|POST /api/active-session`）：同一台机器上任意终端/脚本可向 Web 客户端当前活跃会话投递消息，语义等同用户亲自输入（空闲开新轮、忙碌排队、transcript 为普通用户消息）；显式 `--session` 可指定目标，投递前服务端自动预热任务索引并 resume 冷会话（server 重启后或会话从未打开过也可投递）。
- Web 客户端在活跃会话切换时自动上报目标（`syncActiveTaskSession` 从桌面专属扩展为两端生效，桌面端行为不变）。
- 对接文档：`docs/session-send-api.md`（供其他 agent/脚本集成）；行为规范：`specs/server/local-session-send.md`。桌面端接收链路为阶段二，未包含在本批改动中。

#### Paperclip 外部 agent 编排集成

- 新增「Paperclip 任务」主视图面板与设置分区：配置独立部署的 Paperclip server 地址（默认 `http://localhost:3100`，env `PAPERCLIP_SERVER_URL` 可覆盖）与可选 Bearer token（加密存储于本地凭据）后，可在 ZCode 内查看 Paperclip 的 agent 团队（Claude Code / Grok Build 等 CLI agent）、创建任务并指派（Paperclip heartbeat 引擎自动唤醒执行）、实时跟踪任务状态（live-events WebSocket 订阅，断连退避重连，WS 不可用时降级为手动刷新并在状态条如实展示）。
- 连接由服务层持有（桌面窗口 Host / Web server 进程），renderer 不直连 Paperclip：手机与远程 Web 场景同样可用，token 不进入浏览器上下文。ZCode 只读 agent、只写 issue，不镜像任务数据；agent 的雇佣与 adapter 配置仍在 Paperclip 自身 UI 完成。
- 行为规范：`specs/services/paperclip-integration.md`；测试：services 包 `paperclipClient.test.ts`（REST 宽容解析 / 错误归一化 / WS 认证拒绝不重试与退避重连）6 个用例，并经本地 `paperclipai test-drive` 实例完成真实 API 与事件流联调。

#### 分组 / 项目独立数据源（`custom-resources.sqlite`）

- 任务分组（`task_groups` 等 4 张表）从 `tasks-index.sqlite` 拆到独立库 `~/.zcode/v2/custom-resources.sqlite`，`CustomResourcesRepo` 为唯一所有者；`IZCodeTaskService` 接口不变，UI 零改动。存量数据不迁移（从零开始），旧库分组表原样废弃。
- 项目会话三字段（`lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex`）从 `setting.json` 拆到新库 `resource_kv` 表；`settingService.get()/update()` 接口不变、内部按字段路由，`setting.json` 不再持久化这三个字段，其他配置存储不动。桌面主进程启动恢复改为只读新库（异常兜底空列表）。
- 任务生命周期分组钩子（cron / 闲时系统分组归属、删除任务清理、顶层排序初始化）经 `TaskGroupStorePort` 写入新库；跨库一致性由"任务行先提交 + 钩子失败告警 + 启动幂等收敛"保证。
- 详见 `specs/services/custom-resource-store.md`。

### 修复

- **Web 端 server dev 不监听共享包源码**：`packages/server` 的 `tsup --watch` 默认只监听本包 `src`，修改 `packages/services`、`packages/shared` 等包后运行中的 server 不重建，表现为新增 RPC 通道 `Unknown channel` 超时。dev 脚本已显式追加共享包 `--watch` 列表（与桌面端 dev 同口径）。

### 移除

- **设置「引导(新)」功能整体废弃**（经架构调查确认：协议层无多根工作区支持，junction 聚合的 glob/grep/文件监听不穿透，遂放弃该方案；统一工作区规划另行推进，目录搬迁由用户手动处理）。已移除：`IGuideEntryService` / `GuideEntryStore` / `nativeDirectoryPicker`、migration `0002_guide_entries`（已应用过 0002 的库中残留账本行与空表不影响迁移判定）、`GuideNewPanel` 引导覆盖层及设置侧栏入口、相关 i18n 与 spec。历史提交见下方清单中 `dbc60bf` ~ `a83c2d7` 五条。

### 文档与工程

- `.gitignore`：新增工作区 `.zcode/plans/` 忽略（plan 模式按会话落盘的计划文档运行产物；`.zcode/commands/` 仍可跟踪）。
- `AGENTS.md`：新增「桌面端打包」分档说明（全量 / 快速）、「双端（Web / 桌面）开发与验证口径」（日常调试以 Web 端为主、共享层改动两端覆盖、Web 平台能力降级口径、发版前桌面端回归）与「Git 提交」规范（Conventional Commits + 每次提交同步维护 CHANGELOG.md）。
- 新增 spec：`specs/services/custom-resource-store.md`。
- `packages/web` vite dev 开启 `strictPort`：端口被占用时直接失败，避免端口顺延漂移。
- 测试：services 包新增 6 个单测（分组库 CRUD / 项目字段 KV 路由 / TaskIndexRepo 分组钩子接线），累计 16 个全部通过；server 包新增 local-session-send 路由单测 9 个（目标解析 / 错误映射 / 预热），全部通过。

### 提交清单

| 提交 | 说明 |
| --- | --- |
| `6f0e5dd` | feat(services): 分组/项目拆分到 custom-resources sqlite |
| `dbc60bf` | feat(ui): 设置新增「引导(新)」分区批量添加前后端项目（已废弃） |
| `6e648d4` | refactor(ui): 引导(新)复用 OccupationOnboarding 覆盖层（已废弃） |
| `cf8a65a` | fix(ui): Web 端选文件夹改用服务端目录浏览器（已废弃） |
| `7d8d721` | fix(server): dev 监听共享包源码支持热更新 |
| `78f9e28` | feat(ui): Web 端引导(新)优先弹 Windows 原生文件夹选择器（已废弃） |
| `a83c2d7` | fix(services): guide-entry 描述符模块保持浏览器安全（已废弃） |
| `08cf457` | docs(agents): 桌面端打包分档 + 双端开发验证口径 |
| `652b24d` | chore(web): vite dev 端口占用时直接失败 |
| `1528272` | docs: 确立提交规范并新建 CHANGELOG |
| 本次提交 | revert: 移除已废弃的「引导(新)」功能 |
