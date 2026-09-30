# 设置「引导(新)」：批量添加前后端项目到工作区

## 背景与目标

复刻首启引导页（`packages/ui/src/onboarding/OccupationOnboarding.tsx`）的卡片交互与样式，在「设置」中新增 **引导(新)** 分区：用户为「前端代码」「后端代码」两个模块各选择一个或多个本地项目文件夹（例如前端 PC 一个仓库 + H5 一个仓库），填写名称与备注后提交——所有文件夹加入工作区侧栏「项目」分区，并跳转激活第一个项目；记录持久化，可重新添加或删除。

## 产品规则

1. **表单校验**：名称必填（trim 非空）、备注选填；「前端代码」与「后端代码」各至少 1 个文件夹；三者全部满足后「添加到工作区」按钮才可用。
2. **文件夹选择**：每次点「添加文件夹」调用一次系统目录选择框（`IPlatformService.selectDirectory()`，取消返回 null 不生效）；可反复添加；同模块内路径去重；可逐条移除。
3. **提交行为（添加并跳转）**：保存历史记录后，按「前端在前、后端在后」的顺序把全部文件夹加入工作区项目 tab（去重），激活第一个（前端的第一个文件夹）并进入草稿态；随后自动更新 recentProjects（去重、上限 10，沿用既有规则）。提交成功后表单重置。
4. **历史记录**：持久化在 `custom-resources.sqlite` 的 `guide_entries` 表；列表按创建时间倒序；每条记录可「重新添加」（走同一添加并跳转链路，不新建记录）与「删除」（确认后删除，不影响已添加的项目 tab）。
5. 名称可重复；记录靠创建时间区分。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 引导记录 | `GuideEntryStore`（`packages/services/src/customResources/guideEntryStore.ts`），经 `IGuideEntryService`（通道 `guide-entry`）暴露 | `custom-resources.sqlite` 的 `guide_entries` 表 |
| 项目 tab / 跳转 | `tabStore`（`addTab`/`ensureWorkspaceTab`）+ `useRootWorkspaceActions.handleAddWorkspaceProjects` | 窗口本地 + `lastWorkspaceSession`（custom-resources KV） |

设置分区始终通过 `ServiceProvider services={localHostServices}` 使用本地 Host 服务——引导记录与文件夹路径都是本机事实，激活远程 workspace 时不得读写远端。

## 界面结构

- 表单区：名称 Input、备注 Textarea、「前端代码」「后端代码」两张模块卡（文件夹行 + 移除按钮 + 虚线「添加文件夹」按钮 + 计数徽标）、提交按钮。
- 历史记录区：记录卡（名称/备注/两组路径/创建时间）+「重新添加」「删除」操作。
- 样式复刻引导页 token：模块卡 `rounded-xl border p-5`（未选 `border-card-border bg-card hover:bg-surface-hover`）；文件夹行 `rounded-lg p-3 hover:bg-surface-hover/50`；主按钮 `h-11 rounded-xl px-5`；标题 `text-ui-xl font-semibold`；辅助文案 `text-foreground-subtle`；错误 `text-destructive` + `role="alert"`。

## 验收场景

1. 校验不满足时提交按钮禁用；逐条补齐后可用。
2. 添加 2 个前端 + 1 个后端文件夹提交：侧栏「项目」分区出现 3 个项目，当前视图跳转到第一个前端项目；重复路径不产生重复 tab。
3. 重启应用：历史记录仍在；「重新添加」再次把该记录的全部文件夹加入并跳转；「删除」后记录消失且不影响已打开项目。
4. 远程 workspace 激活时打开设置页：引导(新)读写仍是本机数据。
5. 取消目录选择框：表单不变。
