# 设置「引导(新)」：批量添加前后端项目到工作区

## 背景与目标

复刻首启引导页（`packages/ui/src/onboarding/OccupationOnboarding.tsx`）的卡片交互与样式，在「设置」中新增 **引导(新)** 分区：用户为「前端代码」「后端代码」两个模块各选择一个或多个本地项目文件夹（例如前端 PC 一个仓库 + H5 一个仓库），填写名称与备注后提交——所有文件夹加入工作区侧栏「项目」分区，并跳转激活第一个项目；记录持久化，可重新添加或删除。

## 产品规则

1. **表单校验**：名称必填（trim 非空）、备注选填；「前端代码」与「后端代码」各至少 1 个文件夹；三者全部满足后「添加到工作区」按钮才可用。
2. **文件夹选择**：与「打开工作区」同口径——桌面端每次点「添加文件夹」调用一次系统目录选择框（取消不生效）；Web 端（`preferDirectoryBrowser`）优先经 `IGuideEntryService.pickDirectory` 让 server（通常即用户本机 Windows）弹**系统原生 FolderBrowserDialog** 并回传路径，非 Windows / 能力缺失 / 调用异常时降级到服务端目录浏览器 `DirectoryBrowser`。同模块内路径去重；可逐条移除。
3. **提交行为（添加并跳转）**：保存历史记录后，按「前端在前、后端在后」的顺序把全部文件夹加入工作区项目 tab（去重），激活第一个（前端的第一个文件夹）并进入草稿态；随后自动更新 recentProjects（去重、上限 10，沿用既有规则）。提交成功后表单重置。
4. **历史记录**：持久化在 `custom-resources.sqlite` 的 `guide_entries` 表；列表按创建时间倒序；每条记录可「重新添加」（走同一添加并跳转链路，不新建记录）与「删除」（确认后删除，不影响已添加的项目 tab）。
5. 名称可重复；记录靠创建时间区分。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 引导记录 | `GuideEntryStore`（`packages/services/src/customResources/guideEntryStore.ts`），经 `IGuideEntryService`（通道 `guide-entry`）暴露 | `custom-resources.sqlite` 的 `guide_entries` 表 |
| 项目 tab / 跳转 | `tabStore`（`addTab`/`ensureWorkspaceTab`）+ `useRootWorkspaceActions.handleAddWorkspaceProjects` | 窗口本地 + `lastWorkspaceSession`（custom-resources KV） |

设置侧栏的「引导(新)」入口属于本机功能；引导记录与文件夹路径都是本机事实（`guideEntryService` 由本窗口 Host 提供），激活远程 workspace 时不得读写远端。

## 界面结构

复刻既有引导页（`OccupationOnboarding`）的**布局与交互形式**，复用同一组件承载：

- **入口**：设置侧栏底部、既有「引导」虚线入口正下方的并列虚线按钮「引导(新)」（Compass 图标），点击置 store 的 `guideNewOnboardingOpen`。
- **覆盖层**：`OccupationOnboarding` 增加引导(新)流程分支——与首启引导共用同一全屏框架（顶部拖拽区/自绘窗控、`grid lg:grid-cols-2` 双栏）、`OnboardingHeader`（`progressKeys=null` 隐藏三段进度条，仅保留关闭按钮，Esc 同效）与 `OccupationOnboardingVisual` 视觉栏（传入专属 hero 文案 key）。左栏为可滚动表单（`max-w-lg` 居中），右栏为视觉 aside。
- **左栏内容**（`GuideNewPanel`）：标题/描述 + 名称 Input + 备注 Textarea + 「前端代码」「后端代码」两张模块卡（文件夹行 + 移除按钮 + 虚线「添加文件夹」按钮 + 计数徽标）+ 取消（link 按钮）/提交（`h-11 flex-1 rounded-xl px-5`，校验未通过禁用）页脚；下方为历史记录列表。
- **卡片样式**沿用引导页 token：`rounded-xl border p-5`（`border-card-border bg-card hover:bg-surface-hover`）；文件夹行 `rounded-lg p-3 hover:bg-surface-hover/50`；标题 `text-ui-xl font-semibold`；辅助文案 `text-foreground-subtle`；错误 `text-destructive` + `role="alert"`。
- 提交/重新添加成功后自动关闭覆盖层，让出主界面给被激活的项目。

## 验收场景

1. 校验不满足时提交按钮禁用；逐条补齐后可用。
2. 添加 2 个前端 + 1 个后端文件夹提交：侧栏「项目」分区出现 3 个项目，当前视图跳转到第一个前端项目；重复路径不产生重复 tab。
3. 重启应用：历史记录仍在；「重新添加」再次把该记录的全部文件夹加入并跳转；「删除」后记录消失且不影响已打开项目。
4. 远程 workspace 激活时打开设置页：引导(新)读写仍是本机数据。
5. 取消目录选择框/目录浏览器：表单不变。
6. Web 端（`pnpm dev:web`，server 为 Windows）：点「添加文件夹」弹出系统原生文件夹选择器，选中后路径进入对应模块；取消不改变表单；server 非 Windows 时自动降级为目录浏览器。提交/重新添加正常（记录与项目会话落在 server 侧 custom-resources）。
