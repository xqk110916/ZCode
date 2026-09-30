# 分组/项目自定义数据源（custom-resources.sqlite）

## 背景与目标

ZCode 桌面端/Web 端侧边栏的「任务分组」与「项目」两类资源原先分散在两处：

- 任务分组：`~/.zcode/v2/tasks-index.sqlite` 的 `task_groups` / `task_group_members` / `task_group_view_node_orders` / `task_group_workspace_bootstraps` 四张表，与任务索引共用库文件。
- 项目列表（workspace 会话、最近项目）：`~/.zcode/v2/setting.json` 的 `lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex` 字段，与其他 AppSettings 共用文件。

本特性把这两类数据拆到独立数据源 `~/.zcode/v2/custom-resources.sqlite`（node:sqlite + WAL + busy_timeout），其余配置（主题、窗口、凭据、provider 等）存储不动。

## 产品规则

1. **从零开始**：拆分不做存量迁移。旧 `tasks-index.sqlite` 分组表与 `setting.json` 项目字段原样保留但不再读写（视为废弃），首次启动新库为空。
2. **其他配置不动**：`AppSettings` schema 不变；除上述三个项目字段外的所有设置仍走 `setting.json`；`dataBaseDir` 等启动引导字段仍留在 `setting.json`。
3. 分组产品行为保持不变：建组/重命名/颜色/删除、顶层混排排序、组成员排序、cron/off-peak 系统分组自动归属、workspace 首次 bootstrap 自动建组、删除任务清理成员关系。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 分组 4 张表 | `CustomResourcesRepo`（`packages/services/src/customResources/customResourcesRepo.ts`） | `custom-resources.sqlite` |
| 项目 3 字段 | `ProjectSessionStore`（`packages/services/src/customResources/projectSessionStore.ts`），经 `settingService` 路由 | `custom-resources.sqlite` 的 `resource_kv` 表 |
| 任务索引 | `TaskIndexRepo`（不再读写任何 `task_group*` 表） | `tasks-index.sqlite` |

> 历史备注：曾在此库增加 `guide_entries` 表承载设置「引导(新)」记录（migration `0002_guide_entries`）；该功能已废弃并随代码移除，已应用过 0002 的库中残留的账本行与空表不影响后续迁移判定。

`TaskIndexRepo` 与 `CustomResourcesRepo` 通过两个窄接口协作（均定义在 customResources 模块，避免模块级循环导入）：

- `TaskGroupStorePort`（TaskIndexRepo → CustomResourcesRepo）：任务生命周期钩子写分组——cron/off-peak 归组、首次公开顶层排序、删除任务清理分组引用、启动时按 deleted tombstone 幂等收敛。
- `TaskGroupTaskReaderPort`（CustomResourcesRepo → TaskIndexRepo）：分组校验/join 读任务——排序保存时的可见性校验、scope 内 task key、grouped 视图 join 用 active task 列表。

## 数据所有权与事件顺序

```
UI (Renderer)
 ├─ useGroupedTaskView ──RPC "zcode-task"→ zcodeTaskServiceAdapter ──→ CustomResourcesRepo ──→ custom-resources.sqlite（分组 4 表）
 │                                        └─ TaskIndexRepo（任务生命周期钩子）──TaskGroupStorePort──→ CustomResourcesRepo
 ├─ useTabPersistence / useSettingService / botsService … ──RPC "setting"→ settingService
 │        ├─ lastWorkspaceSession / recentProjects / lastActiveTabIndex → ProjectSessionStore ──→ custom-resources.sqlite（resource_kv）
 │        └─ 其余字段 → setting.json（不变；写回时剔除上述三字段）
Desktop main 早期启动
 └─ readStartupProjectSessionState() ──readonly──→ custom-resources.sqlite（不再读 setting.json 的项目字段）
```

关键事件顺序：

- 任务删除（`updateTaskState`/`deleteArchivedTask`）：先写 tasks tombstone，再调 `TaskGroupStorePort.deleteTaskGroupingReferences`；后者失败仅告警，由下次进程启动的 tombstone 收敛自愈（幂等）。
- `syncTaskMetaAtGroupedTop`：先提交 task row（tasks-index 事务），再写分组顶层排序（新库自动事务）；分组写失败仅告警，不回滚任务行——缺序节点由查询时 `normalize` 按 createdAt 补齐。
- 分组排序保存（`applyGroupedTaskViewOrder`）：先经 reader port 校验 task 可见性（tasks 库读），再在新库单事务内全量重写 membership + 顶层排序。

## 接口

- `IZCodeTaskService` 分组方法签名不变，adapter 内部委托对象从 `TaskIndexRepo` 换成 `CustomResourcesRepo`。
- `ISettingService.get()/update()` 签名不变；`get()` 返回的 AppSettings 中三个项目字段以 KV 为准，`update()` 的 patch 按字段路由（项目字段 → KV，其余 → setting.json）。
- `resource_kv` 表：`key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL`；key 与 AppSettings 字段同名（`lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex`）。

## 验收场景

1. 全新环境启动：生成 `custom-resources.sqlite`，分组与项目列表为空（不读旧数据）。
2. 建组/改色/重命名/删除、拖拽排序、任务移入组：重启后从新库恢复。
3. cron/off-peak 任务首次出现：自动归入系统分组（新库）。
4. 删除任务：新库成员关系与顶层排序清理；崩溃残留由下次启动收敛。
5. 打开项目/切换标签：新库 KV 更新，重启恢复会话；`setting.json` 不再写入三个项目字段。
6. 主题等其他设置读写不受影响。
7. 多窗口并发：两库各自 WAL + busy_timeout，写链串行不互相阻塞。
