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

### 修复

- **Web 端 server dev 不监听共享包源码**：`packages/server` 的 `tsup --watch` 默认只监听本包 `src`，修改 `packages/services`、`packages/shared` 等包后运行中的 server 不重建，表现为新增 RPC 通道 `Unknown channel` 超时。dev 脚本已显式追加共享包 `--watch` 列表（与桌面端 dev 同口径）。

### 移除

- **设置「引导(新)」功能整体废弃**（经架构调查确认：协议层无多根工作区支持，junction 聚合的 glob/grep/文件监听不穿透，遂放弃该方案；统一工作区规划另行推进，目录搬迁由用户手动处理）。已移除：`IGuideEntryService` / `GuideEntryStore` / `nativeDirectoryPicker`、migration `0002_guide_entries`（已应用过 0002 的库中残留账本行与空表不影响迁移判定）、`GuideNewPanel` 引导覆盖层及设置侧栏入口、相关 i18n 与 spec。历史提交见下方清单中 `dbc60bf` ~ `a83c2d7` 五条。

### 文档与工程

- `AGENTS.md`：新增「桌面端打包」分档说明（全量 / 快速）、「双端（Web / 桌面）开发与验证口径」（日常调试以 Web 端为主、共享层改动两端覆盖、Web 平台能力降级口径、发版前桌面端回归）与「Git 提交」规范（Conventional Commits + 每次提交同步维护 CHANGELOG.md）。
- 新增 spec：`specs/services/custom-resource-store.md`。
- `packages/web` vite dev 开启 `strictPort`：端口被占用时直接失败，避免端口顺延漂移。
- 测试：services 包新增 6 个单测（分组库 CRUD / 项目字段 KV 路由 / TaskIndexRepo 分组钩子接线），累计 16 个全部通过。

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
