# Changelog

本文件记录基于上游 ZCode（zai-org/ZCode）的自定义改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] - 2026-09-30

基线：上游 `3bb1dd9`（v3.14.3）。

### 新增

#### 分组 / 项目独立数据源（`custom-resources.sqlite`）

- 任务分组（`task_groups` 等 4 张表）从 `tasks-index.sqlite` 拆到独立库 `~/.zcode/v2/custom-resources.sqlite`，`CustomResourcesRepo` 为唯一所有者；`IZCodeTaskService` 接口不变，UI 零改动。存量数据不迁移（从零开始），旧库分组表原样废弃。
- 项目会话三字段（`lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex`）从 `setting.json` 拆到新库 `resource_kv` 表；`settingService.get()/update()` 接口不变、内部按字段路由，`setting.json` 不再持久化这三个字段，其他配置存储不动。桌面主进程启动恢复改为只读新库（异常兜底空列表）。
- 任务生命周期分组钩子（cron / 闲时系统分组归属、删除任务清理、顶层排序初始化）经 `TaskGroupStorePort` 写入新库；跨库一致性由"任务行先提交 + 钩子失败告警 + 启动幂等收敛"保证。
- 详见 `specs/services/custom-resource-store.md`。

#### 设置「引导(新)」：批量添加前后端项目到工作区

- 入口位于设置侧栏底部，与既有「引导」并列的虚线按钮；点击打开**复用 `OccupationOnboarding` 组件**的全屏引导覆盖层（双栏布局 / 视觉栏 / 关闭与 Esc），不再新建页面组件。
- 表单：「前端代码」「后端代码」两个模块各选择 ≥1 个项目文件夹（可多选，如 PC 端 + H5 端双仓库；路径去重、可逐条移除、计数徽标）+ 名称（必填）+ 备注（选填）；三项校验齐备后「添加到工作区」才可用。
- 提交后按"前端在前、后端在后"把全部文件夹加入侧栏「项目」分区并**跳转激活第一个**，同时批量更新最近项目（去重、上限 10）；历史记录持久化在新库 `guide_entries` 表（migration `0002_guide_entries`），支持「重新添加」与两步确认删除。
- 文件夹选择交互（桌面 / Web 双端）：
  - 桌面端：Electron 系统目录选择框（不变）；
  - Web 端：浏览器无法打开系统对话框，改由 server（通常即用户本机 Windows）经 `IGuideEntryService.pickDirectory`（通道 `guide-entry`，PowerShell STA 弹系统原生 `FolderBrowserDialog`）代选并回传完整路径；非 Windows / 能力缺失 / 调用异常时自动降级到服务端目录浏览器 `DirectoryBrowser`。
  - 详见 `specs/ui/settings-guide-new.md`。

### 修复

- **Web 端 server dev 不监听共享包源码**：`packages/server` 的 `tsup --watch` 默认只监听本包 `src`，修改 `packages/services`、`packages/shared` 等包后运行中的 server 不重建，表现为新 RPC 通道（如 `guide-entry`）`Unknown channel` 超时。dev 脚本已显式追加共享包 `--watch` 列表（与桌面端 dev 同口径）。
- **服务描述符模块误引 Node 依赖**：`guideEntryService` 曾静态引入 `node:child_process`（原生选择器），经浏览器包（`RemoteServiceAccess` 引用描述符）打进页面导致模块加载即崩（`Cannot access "node:child_process.spawn"`）。已改为类型上移、实现仅在 server 组合根注入，描述符模块保持浏览器安全。
- **Web 端选文件夹静默无效**：原先 Web 上下文调用 `platform.selectDirectory` 恒为 null（受限 preload 环境下还会抛未捕获异常），已建立"原生选择器 → 目录浏览器"降级链并捕获全部异常。

### 文档与工程

- `AGENTS.md`：新增「桌面端打包」分档说明（全量 / 快速）与「双端（Web / 桌面）开发与验证口径」（日常调试以 Web 端为主、共享层改动两端覆盖、Web 平台能力降级口径、发版前桌面端回归）；新增「Git 提交」规范（Conventional Commits + 每次提交同步维护 CHANGELOG.md）。
- 新增 spec：`specs/services/custom-resource-store.md`、`specs/ui/settings-guide-new.md`。
- `packages/web` vite dev 开启 `strictPort`：端口被占用时直接失败，避免端口顺延漂移。
- 测试：services 包新增 6 个单测（分组库 CRUD / 项目字段 KV 路由 / TaskIndexRepo 分组钩子接线 / 引导记录存储与校验 / 原生选择器透传），累计 19 个全部通过。

### 提交清单

| 提交 | 说明 |
| --- | --- |
| `6f0e5dd` | feat(services): 分组/项目拆分到 custom-resources sqlite |
| `dbc60bf` | feat(ui): 设置新增「引导(新)」分区批量添加前后端项目 |
| `6e648d4` | refactor(ui): 引导(新)复用 OccupationOnboarding 覆盖层 |
| `cf8a65a` | fix(ui): Web 端选文件夹改用服务端目录浏览器 |
| `7d8d721` | fix(server): dev 监听共享包源码支持热更新 |
| `78f9e28` | feat(ui): Web 端引导(新)优先弹 Windows 原生文件夹选择器 |
| `a83c2d7` | fix(services): guide-entry 描述符模块保持浏览器安全 |
| `08cf457` | docs(agents): 桌面端打包分档 + 双端开发验证口径 |
| `652b24d` | chore(web): vite dev 端口占用时直接失败 |
