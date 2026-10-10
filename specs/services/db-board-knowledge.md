# 数据库看板 · 项目业务知识库（代码感知的引导收集）

把「探索看板」从裸表名猜测升级为**懂业务代码的问答**：注册本地项目根目录（含前端/后端 git 仓库），自动收集代码证据 + 数据库注释，经 ZCode 既有一次式模型链路蒸馏成**表级业务知识卡片**（中文用途/关键字段含义/表关联/业务域归类），注入看板生成。关联 spec：`specs/services/db-board.md`。

设计原则（产品约束）：**依托 ZCode 自身能力、只扩展不动官方逻辑代码**——证据收集只做轻量文本定位与切片（不实现 Java/XML 解析器），语义理解全部交给 `generateWorkspaceText` 模型链路；本功能不实现写代码/调服务能力，深度分析引导用户以常规 ZCode 任务在该项目工作区完成。

## 产品规则

- **知识来源**（互补合并，全部只读）：
  1. 数据库注释：Kingbase Oracle 兼容视图 `all_col_comments` / `all_tab_comments`（实测 V8R3 可用；视图缺失时降级为空，不阻塞）。
  2. 后端代码证据：`**/domain/*Entity.java`（@TableName + 字段中文 javadoc）、`**/mapper/**/*Mapper.xml`（SQL 摘录含 join，每文件截断）、`**/db/**/*.sql`（DDL COMMENT）、`application-*.yml`（自动发现 Nacos 配置与数据源线索）、Controller/Service 文件名（业务操作名）。
  3. 前端代码证据（PC `hbt-oa-web` 多页站 + H5 `hbt-oa-h5` Vue，按 URL 首段 ↔ 表业务前缀挂载，如 `doc/*` ↔ `oa_doc*`）：PC `assets/js-v/**.js` 的 `utils.ajax*` 调用与同名 `views/**.html` 的 `<title>` 配对（中文页面名 → 接口）、`docs/*MODULES*MAP*.md`（菜单中文名 → 页面）；H5 `src/router/index.js` 路由中文注释、`src/**/api.js` 模块（中文注释 + url）、`*.vue` 内联 http 调用。
  4. Nacos（可选）：服务清单 + 配置中心内容 → 服务↔数据源映射、领域命名线索；登录须 POST 表单（实测）；失败降级跳过。
- **蒸馏**：按业务域分片（Java 包 `modules.<domain>` 分组，每片约 10 表），每片一次 `generateWorkspaceText` 调用，输出结构化 JSON 表卡片；单片失败重试一次，再失败降级为**纯抽取卡片**（实体 javadoc + DB 注释直接拼装，不经 LLM），不阻塞整批。
- **构建任务**：单当前任务语义（新构建取消旧构建）；`startBuild` 立即返回，进度经 `onBuildProgress` 事件（分阶段：探测仓库→扫描收集→DB 注释→Nacos→蒸馏 i/N→落盘），节流 300ms，终态必发；可取消（AbortSignal 贯穿文件遍历与 git 子进程）。
- **项目档案即全栈项目注册**：profile（根目录多仓库 + Nacos + **数据库绑定 `dbBinding.connectionId`**）。保存带绑定的档案时同步激活为看板当前连接（多项目/多环境切换入口）；连接本体仍在数据库看板管理（状态唯一所有者不变）。不进任务分组（任务管理维度，与数据库绑定正交）。
- **git 自动增量**：每 5 分钟对每个仓库 `git rev-parse HEAD`；变更 → `git diff --name-only 旧..新` → 经「表→证据文件索引」反查受影响表 → 仅重收集+重蒸馏这些表后合并落盘；增量与全量构建互斥。定时器随服务生命周期释放。
- **生成两步化**（知识库存在时；无知识库或失败自动回退现有单步行为）：Step A 轻调用选表（域→表→一句话用途索引 + 问题 → 相关表清单）；Step B 注入选中表的知识卡片（中文用途/关键字段含义/关联/示例 SQL 片段）+ 全库简表。
- **凭据安全**：Nacos/DB 密码存 credentialService（`db-board-knowledge:nacos-password`），配置文件不落明文密码；日志与知识文件中不落凭据；知识文件 `~/.zcode/v2/db-board-knowledge.json`（atomicWriteJson，含 profile 与知识本体）。
- **能力边界**：不写数据、不改代码、不调业务接口；知识浏览提供引导文案（在 ZCode 中打开该项目工作区做深度分析）。
- **知识卡手动管理与导出**：`saveTableCard`（按表名 upsert，域分组与统计同步重算）/ `deleteTableCard` / `distillTableCard`（单表手动蒸馏，不落盘：汇集 DB 表/列注释 + 既有卡证据 → 一次 LLM 调用返回草稿，前端表单回填后由用户确认保存）；手动修改会被下次构建按证据覆盖（对话框有提示）；知识浏览一键导出 Markdown 文档（概览 + 域分组 + 卡片字段 + 统计，前端 Blob 下载）。新增卡片的表名为可筛选下拉（Command），已有卡/无卡表用徽标区分，选中后自动带出（已有卡整卡 / 表注释 + 有注释列预填）。
- **汇总看板（独立「概览」tab，默认入口）**：经 `dbBoard.getUsageSummary` 展示数据库概览——总表数/知识覆盖/业务域/已统计行数表数四个指标 + 常用业务表清单（行数 ≥1000 的前 20，按行数降序；行数是活跃度近似，逐表 count 计算可能耗时）。显式「生成汇总/刷新」触发（compute/force），打开面板只读缓存不自动计数；导出文档时若缓存缺失自动补算并把概览章节写进文档头部。汇总结果另携带全量 `rowCounts`（小写表名 → 行数，仅成功统计的知识表；概览页展示仍只有前 20），「数据浏览」表列表生成过概览后按行数倒序，未统计的表（无概览或非知识表）排在后面并保持字母序。
- **UI 布局**：
  - 主视图 tab 顺序为 概览 / 知识库 / 数据浏览 / 操作日志 / 探索看板（默认概览；数据库概览独立成 tab，不与知识浏览同屏）；页头不再重复「数据库看板」标题（侧栏已标识），连接切换与状态与 line tabs 同一条工具栏。
  - 知识库 tab：已有项目档案时默认收起档案/构建为摘要条，**业务知识浏览占满剩余高度、单一滚动**；无档案时展开配置表单。档案/Nacos/绑定入口可展开，不删除。
  - 构建失败信息默认一行，详情可展开；同一错误不重复渲染。
  - 数据浏览表列表卡片显示知识库中文名（无知识时回退数据库表注释）；分页支持直接跳页；工具栏控件高度统一 `size="sm"`。

## 状态所有者

| 数据 | 唯一所有者 | 物理位置 |
| --- | --- | --- |
| 知识库 profile（项目根目录/Nacos 配置/构建选项） | dbBoardKnowledgeService | `~/.zcode/v2/db-board-knowledge.json` |
| 知识本体（表卡片/域分组/仓库 HEAD 快照/证据索引） | dbBoardKnowledgeService | 同上文件 |
| 构建任务运行态（阶段/进度/取消） | dbBoardKnowledgeService | host 进程内，不持久化 |
| Nacos 密码 | credentialService | `~/.zcode/v2/credentials.json`（加密） |
| 代码事实 | 项目 git 仓库本身 | 只读 |
| DB 注释事实 | 目标库 | 只读 |

## 接口

- Channel：`ServiceChannels.DbBoardKnowledge = "db-board-knowledge"`；接口 `packages/services/src/dbBoardKnowledge/dbBoardKnowledge.ts`（browser-safe），实现 `dbBoardKnowledgeService.ts`（node-only）。
- `IDbBoardKnowledgeService`：`getProfile() / saveProfile(profile, nacosPassword?) / probeProject(root) / startBuild() / cancelBuild() / getBuildState() / onBuildProgress: Event / getKnowledge() / deleteKnowledge()`。
- 纯函数模块：`dbBoardKnowledgeExtract.ts`（实体 javadoc 抽取、Mapper 表/join 抽取、DDL COMMENT 抽取、yml Nacos 发现——均为文本级正则/切片，无 IO）、`dbBoardKnowledgePrompt.ts`（蒸馏 prompt 构建 + 输出 zod 解析）、`nacosClient.ts`（undici：登录/服务清单/配置列表与读取）。
- dbBoard 扩展（同模块内增量）：`DbBoardColumnMeta.comment?`、`DbBoardTableMeta.comment?`（`all_*_comments` 视图，catalog 查询合并，视图缺失降级空）；`generateDashboard` 两步化（注入 `loadKnowledge` 端口，node.ts 装配闭包，避免服务间硬依赖）。
- 注入依赖：`{ dbBoardService 公开面, readCurrentModel, generateText, credentialService }`——全部复用现有实例，不新建模型/数据库通道。

## 数据流与事件顺序

```
注册: probeProject(root) → 仓库/栈/Nacos 线索探测（只读）→ saveProfile 落盘
构建: startBuild
  1. 探测仓库（顶层+一级 .git）→ 记录 HEAD
  2. 收集证据（有界并发 walk，跳过 target/node_modules/.git；256KB/文件）
  3. DB 注释批量拉取（dbBoardService.listTables/getTableColumns）
  4. Nacos（可选）：登录→服务清单→配置列表→数据源映射
  5. 分片蒸馏：每片证据包 → LLM → zod 解析 → 失败重试一次 → 再失败纯抽取降级
  6. 归并 → atomicWriteJson（表卡片 + 域分组 + HEAD 快照 + 证据索引）
增量: 定时 HEAD 比对 → git diff 文件清单 → 反查受影响表 → 仅重蒸馏该批 → 合并落盘
使用: generateDashboard → loadKnowledge → Step A 选表 → Step B 注入卡片生成
```

## 验收场景

1. probeProject 对 hbt-oa 返回单仓库 + Maven/MyBatis-Plus 栈 + 自动发现的 Nacos 地址（凭据掩码展示）。
2. 全量构建完成后：~135 张实体表均有卡片（中文 purpose/关键字段含义），archives/收发文相关表归入正确业务域；构建进度与取消可用。
3. 「今年产生了多少收发文」生成：Step A 选中收发文相关表，Step B SQL 使用正确表与列（含 DB 注释佐证的列名），不再猜测。
4. 项目内一次 git 提交后 ≤ 一个轮询周期：仅受影响表被重蒸馏，其余卡片与 HEAD 快照不变。
5. 数据库浏览表头显示列注释 tooltip；`all_*_comments` 不可用时功能不报错。
6. Nacos 不可达：构建仍成功（跳过该阶段并如实标注）。
7. 删除知识库后，看板生成回退裸元数据行为，一切照旧。
