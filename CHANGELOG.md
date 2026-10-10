# Changelog

本文件记录基于上游 ZCode（zai-org/ZCode）的自定义改动。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] - 2026-09-30

基线：上游 `3bb1dd9`（v3.14.3）。

### 新增

#### 数据库看板 · 数据库助手 Agent（MCP 能力层 + 面板对话入口）

- **工作区绑定（准入控制，轻量版）**：连接配置升级 v3，新增 `bindings: Record<workspaceKey, connectionId>`——**创建第一条绑定即进入严格模式**：只有绑定了连接的项目（左侧任务对话的工作区）可以使用数据库看板与数据库助手，未绑定项目面板显示空态引导（可直接选择连接绑定），数据库助手 `getMcpServer` 对未绑定工作区不发 token（会话从根上建不起来）；清空全部绑定回到 legacy 模式（全员可用，v1/v2 旧配置迁移后即此模式，行为不变）。页头连接选择器旁新增 Pin 按钮：绑定当前连接到本项目（首次绑定弹确认，说明对其他项目的影响）/解除绑定；打开面板与 15s 周期对账会把激活连接自动拉齐到本工作区绑定的连接（全局单激活的轻量取舍：多窗口并发时后打开者生效）。绑定键统一为 `workspaceIdentity || workspacePath`；除 UI 门控与助手发 token 卡点外，**数据面另有服务端校验**：全部触库方法（元数据/浏览/写入/审计/看板生成与执行/汇总）接受可选 workspaceKey，严格模式下未绑定工作区直接拒绝（错误码 workspace-not-bound）；无 key 调用（服务端脚本、知识库服务与 MCP 工具内部）不门控——助手侧准入由发 token 承担；连接管理面不校验（blocked 工作区可完成绑定自救）。renderer 自报 workspaceKey 与 operator 同级 advisory，数据侧硬边界仍是无删除/只读事务/审计。绑定键存取两侧按归一化形态匹配（正斜杠统一为反斜杠 + 小写；解绑按归一化匹配删除、兼容历史原样键）——不同入口添加工作区产生的路径形态差异（`F:/a` vs `F:\A`）互不排斥。
- 数据库看板能力封装为标准 MCP server（Phase 1，独立智能体路线的第一步）：宿主进程内懒启动 Streamable HTTP 端点（仅绑 `127.0.0.1` 随机端口 + 随机 Bearer token，token 不落日志不进提示词），复用同一份 dbBoard/知识库服务实例（连接池、看板 store、模型链路单一所有者），`@modelcontextprotocol/server` 2.0。
- **14 个工具**（模型侧名称 `mcp__db_board__*`）：表/列元数据、分页浏览、只读 SQL（READ ONLY 事务+单语句包装+行上限，服务端强制）、知识卡查询与检索、insert/update（operator 强制为「用户名 via db-agent」，同事务审计日志）、看板生成/保存/清单、单表蒸馏与知识卡保存、审计日志查询；**不提供**删除、回退、连接管理工具——回退保留在面板操作日志，连接管理保留在面板页头。
- **面板「对话」入口**：看板页头新增「对话」按钮，输入业务问题后经 v4 `createSession` 命令直接创建助手会话（payload 原生携带 `mcpServers` 描述符 + `firstInput` 人格导语，与 composer 首发同构，官方 draft/预热链路零改动），会话出现在正常聊天流中跟进。导语承载对话契约：知识库优先选表、查询结果 Markdown 表格并标注连接名、写入必须先展示新旧值预览并获确认、删除永不可用、切换连接引导回面板。
- 已知限制（Phase 1）：CLI 重启冷恢复的助手会话不自动重挂 MCP 工具（历史与导语仍在，需工具时新建对话）；会话跟随宿主当前激活连接；每宿主单 MCP 实例/单 operator。
- 行为规范：`specs/services/db-board-agent.md`；测试：services 包 `dbBoardAgent.test.ts` 10 用例（工具输出/markdown 截断/operator 注入与参数走私拒绝/知识匹配/导语边界）。真实 E2E：无 token 401；initialize→tools/list→tools/call 全通（`list_tables` 275 表按域分组、`run_readonly_sql` oa_doc 计数 23751、知识卡中文含义命中）；官方 MCP client SDK 25ms 兼容；完整会话 E2E——v4 建会话 + 首条输入，模型实际调用 `mcp__db_board__list_tables` 与 `run_readonly_sql` 成功作答（默认模式首次调用会弹原生工具批准框，可会话内记住）。

#### 数据库看板 · 项目业务知识库（代码感知的引导收集）

- **数据库概览汇总看板**：新增独立「概览」tab（默认入口，不与知识浏览同屏）——总表数/知识覆盖/业务域/已统计行数四个指标 + 常用业务表清单（行数 ≥1000 的知识表按行数降序取前 20，数据量少或无数据的表不进入；行数作为使用频繁度近似）。行数经 `dbBoard.getUsageSummary` 逐表 count（Kingbase 该模式无统计快表可用，实测 `all_tables.num_rows` 恒 0），有界并发 6 + 每表 8s 超时 + 失败跳过，真实库 150 张知识表约 9s；显式「生成汇总/刷新」触发，服务端缓存随连接切换失效，打开面板只读缓存不自动计数。导出文档头部同步携带「数据库概览」章节（缓存缺失时导出自动补算），含指标与常用业务表 Markdown 表格。汇总另携带全量行数表（rowCounts，仅内部数据，概览展示仍为前 20）：「数据浏览」表列表在生成过概览后按行数倒序，未统计的表排在后面保持字母序。汇总按连接 id 持久化到 `~/.zcode/v2/db-board-usage.json`：server 重启后排序与概览不丢（此前为纯内存缓存，重启即失效）。
- **探索看板进度跨视图保留**：生成/修订进度、当前 spec、每图运行态（成功数据/失败标注/刷新时间）迁移到模块级 persistent state——切 tab、切主视图（组件卸载）不中断不丢失，进行中的生成请求照常推进、回来即可见；不落盘（刷新页面重置），已保存看板仍在服务端持久化。
- **绑定工作区普通对话自动附带数据库工具**：严格模式下已绑定连接的工作区，直接在聊天里新建的任务（v4 createSession，无需经看板「对话」入口）由宿主信封自动附加 db_board MCP——问「数据库有多少张表」即调用 `mcp__db_board__list_tables` 作答而不再扫代码；legacy 模式/未绑定工作区不注入，面板入口与自动注入按服务名去重。真实 E2E：绑定后普通会话模型实际调用 list_tables 成功。

- 数据库看板新增第 4 个「知识库」tab：注册本地项目根目录（Web 经 DirectoryBrowser 选目录，支持多 git 仓库与多模块 Maven），自动探测技术栈并从 `application-*.yml` 发现 Nacos 配置（凭据掩码、可一键采用）。
- **构建流水线**（引导收集 + 复用 ZCode 模型链路，不自研代码解析器）：有界并发扫描代码证据（`*Entity.java` 的 @TableName + 字段中文 javadoc、Mapper XML 的 SQL/join、DDL COMMENT、Controller/Service 业务操作名）→ 数据库注释（Kingbase `all_tab_comments`/`all_col_comments` 实测可用，视图缺失自动降级）→ Nacos 服务清单与配置→数据源映射（登录须 POST 表单，不可达时降级跳过）→ 按业务域分片 LLM 蒸馏成表卡片（中文用途/关键字段含义/表关联）；单片失败重试一次后降级为纯抽取卡，仅数据库注释的表直接出卡不耗 LLM。单当前任务语义，`startBuild` 立即返回、进度经事件推送、可取消。
- **git 自动增量**：每 5 分钟比对各仓库 HEAD，变更时经「表→证据文件索引」反查受影响表，仅重蒸馏该批后合并落盘（`~/.zcode/v2/db-board-knowledge.json`，原子写；Nacos 密码走加密凭据）。
- **看板生成两步化（知识注入）**：知识库存在时先轻调用选表（域→表→用途索引 + 问题），再把选中表的知识卡片（含 JOIN 条件与示例 SQL）注入生成 prompt，全库裸元数据降为补充参考；无知识库/选表失败自动回退原行为。数据浏览表头同步展示列注释；生成 prompt 内置「字符串时间列需 ::timestamp 显式转换」提示（该项目时间列为 varchar，Kingbase date_trunc 需显式转换）。
- **前端证据接入（PC + H5 全栈）**：证据收集扩展到前端仓库——PC 多页站（`utils.ajax*` 调用点与同名页面 `<title>` 配对，产出"中文页面名 → 接口"）、`SYSTEM_MODULES_MAP.md` 菜单地图、H5 Vue（路由中文注释 / api.js 模块 / .vue 内联调用），按"URL 首段 ↔ 表业务前缀"（`doc/*` ↔ `oa_doc*`）挂载进蒸馏证据；项目根目录指向 `F:\masterCode\HJT` 即三仓库全栈构建；构建产物按目标库实际表清单过滤"幻影表"（其他库的表与解析噪声，实测剔除 38 张）。
- **数据库连接多实例 + 项目档案绑定**：连接配置升级为"列表 + 激活项"（v2 格式，旧单份自动迁移；密码按连接 id 加密隔离），页面顶部可下拉切换、连接对话框支持名称/环境标签（dev/test/prod）与新建/编辑；知识库 profile 升级为"项目档案"，可绑定数据库连接——保存即切换看板到该连接（多项目/多环境入口）；不进任务分组（任务管理维度）。
- **交互迭代**：表清单进程内缓存 + 手动强制刷新（打开面板不再每次查库）；数据浏览表列表卡片显示知识库中文名（回退数据库表注释），分页支持直接跳页；知识卡支持手动新增/编辑/删除（下次构建按证据覆盖）与 Markdown 文档导出；知识卡新增的表名为可筛选下拉（已有卡/无卡徽标区分），选中表自动带出字段（已有卡整卡 / 列注释预填），并支持单表「AI 蒸馏」手动触发（DB 注释 + 既有卡证据 → 草稿回填表单确认保存）；主视图 tab 调整为 知识库 / 数据浏览 / 操作日志 / 探索看板（默认知识库）；工具栏控件高度统一 `size="sm"`。
- 一次式模型调用链路统一放宽超时上限（agent 默认 60s 对 4096 token 蒸馏输出不足，真实构建实测 7 片超时降级后修复）；超时/预算参数经 `generateWorkspaceText` 既有 signal/maxOutputTokens 通道传入，不改 agent 官方逻辑。
- 行为规范：`specs/services/db-board-knowledge.md`；测试：services 包 `dbBoardKnowledge.test.ts` 12 用例（实体/Mapper/DDL 双方言抽取、Nacos 发现与解析、蒸馏输出校验、增量映射）。真实 E2E：对 `F:\masterCode\HJT\hbt-oa`（Spring Boot 2.1.3 + MyBatis-Plus）全量构建——188 表/38 业务域/89 张 LLM 蒸馏卡；「今年产生了多少收发文」生成命中 `oa_doc`/`oa_doc_transfer` 正确表与列（无知识库时误选 `archives_document`）。

#### 数据库看板（数据操作 + 探索看板）

- 新增「数据库看板」主视图（Web 与桌面同入口）：针对外部 PostgreSQL 兼容数据库（实测 KingbaseES V8R3，非 SSL 直连）提供「探索看板」「数据浏览」「操作日志」三个 tab，共享一份连接配置（host/port/库/用户名存 `~/.zcode/v2/db-board.json`，密码加密存本地凭据，不进仓库）。
- **数据浏览（增改查，禁止删除）**：通用表浏览器——自动列出业务表与列元数据（主键/非空/类型分族），分页查询 + 单列模糊搜索；新增/修改由元数据驱动表单完成（主键与二进制/数组列只读，留空按 NULL）；无主键表仅支持查询。接口层与 UI 均不存在删除数据行入口。
- **审计日志与回退**：每次增/改与审计日志同事务写入目标库 `zcode_db_board_op_log`（before/after 快照、operator、补偿链）；操作日志为独立 tab——日志列表可展开变更列 diff、按"全部表/仅当前表"筛选并一键回退：回退 update 恢复旧值（乐观校验当前值一致，被再次修改则拒绝）；回退 insert 移除该行（回退新增的唯一方式）；回退本身写补偿日志、可再回退（undo 的 undo = redo）。回退 insert 只被更新的非补偿日志阻挡（按行严格逆序，防跳过中间态），删行时残留补偿级联标记。真实库 E2E 30 项断言全过。
- **探索看板（Claude Dashboards 最小复刻，依据根目录需求文档）**：自然语言问题 → 模型生成只读 SQL + 图表定义 → 图表渲染（柱/折线/饼/KPI/表格，recharts）；每张图常驻查询抽屉（查看/复制 SQL、导出 CSV、要求模型解释口径）与独立刷新时间，失败保留上次成功数据并标注（不静默冒充新数据）；页内对话修订（"改成按周/加筛选"携带上一版重新生成）；看板定义持久化（custom-resources `resource_kv`）可回来编辑，删除仅删定义不动数据。生成走 `generateWorkspaceText` 一次式链路（与提交信息生成同源），模型复用当前选中模型，未选中明确报错。
- **只读与安全边界**：看板 SQL 强制只读——语句头校验 + 子查询外包装（多语句/`SELECT INTO` 必然语法错误）+ `READ ONLY` 事务 + `statement_timeout` + 1000 行上限；数据浏览标识符全部走元数据白名单 + 双引号插值，值一律参数化。Kingbase V8R3 适配：主键探测走 `information_schema`（该版本无 `pg_catalog.pg_index`）、类型分族兼容全大写 `data_type/udt_name` 与 `TINYINT`、时间类型保持原始文本（避免 node-pg 本地时区解析导致回退时间偏移）。
- 行为规范：`specs/services/db-board.md`；测试：services 包 `dbBoardSql.test.ts` / `dbBoardGeneration.test.ts` 共 19 用例（标识符白名单、SQL 构建、只读包装、模型输出解析与 spec 校验、修订历史推导）。

#### 本机会话消息投递（local session send）

- 新增 `zcode send "<消息>"` CLI 子命令与 zcode-server 三个 HTTP 端点（`POST /api/local-send`、`GET|POST /api/active-session`）：同一台机器上任意终端/脚本可向 Web 客户端当前活跃会话投递消息，语义等同用户亲自输入（空闲开新轮、忙碌排队、transcript 为普通用户消息）；显式 `--session` 可指定目标，投递前服务端自动预热任务索引并 resume 冷会话（server 重启后或会话从未打开过也可投递）。
- Web 客户端在活跃会话切换时自动上报目标（`syncActiveTaskSession` 从桌面专属扩展为两端生效，桌面端行为不变）。
- 对接文档：`docs/session-send-api.md`（供其他 agent/脚本集成）；行为规范：`specs/server/local-session-send.md`。桌面端接收链路为阶段二，未包含在本批改动中。

#### Paperclip 外部 agent 编排集成

- 新增「Paperclip 任务」主视图面板与设置分区：配置独立部署的 Paperclip server 地址（默认 `http://localhost:3100`，env `PAPERCLIP_SERVER_URL` 可覆盖）与可选 Bearer token（加密存储于本地凭据）后，可在 ZCode 内查看 Paperclip 的 agent 团队（Claude Code / Grok Build 等 CLI agent）、创建任务并指派（Paperclip heartbeat 引擎自动唤醒执行）、实时跟踪任务状态（live-events WebSocket 订阅，断连退避重连，WS 不可用时降级为手动刷新并在状态条如实展示）。
- 连接由服务层持有（桌面窗口 Host / Web server 进程），renderer 不直连 Paperclip：手机与远程 Web 场景同样可用，token 不进入浏览器上下文。ZCode 只读 agent、只写 issue，不镜像任务数据；agent 的雇佣与 adapter 配置仍在 Paperclip 自身 UI 完成。
- 行为规范：`specs/services/paperclip-integration.md`；测试：services 包 `paperclipClient.test.ts`（REST 宽容解析 / 错误归一化 / WS 认证拒绝不重试与退避重连）6 个用例，并经本地 `paperclipai test-drive` 实例完成真实 API 与事件流联调。
- 任务面板体验优化：首次加载展示骨架占位（不再用「暂无任务」冒充空态）；状态筛选补齐「受阻/已取消」并带各状态任务计数；已完成/已取消沉底、其余按更新时间倒序；优先级按紧急/高/中/低用语义色区分，任务编号等宽弱展示；agent 卡片显示职级，活跃/已暂停状态着色；连接状态条区分「连接中」（此前会被误标为手动刷新）。
- **面板内切换模型**：agent 卡片新增配置入口，弹窗内按该 agent 的 adapter 类型拉取可选模型并切换模型/推理力度（`PATCH /api/agents/{id}`，merge 语义，改动计入 Paperclip 配置修订历史）；effort 与模型不匹配被拒时弹窗如实展示原因。
- **主 Agent 自动分派**：创建任务对话框新增「主 Agent 自动分派」（公司内 `role=ceo` 的 agent 为调度负责人，存在时默认选中，缺失时可一键创建，默认 `claude_local` 复用本机 CLI 登录态）。分派决策由主 Agent 的 LLM 完成——评估任务规模后选择单个终端 agent 直接处理（允许其内部多 agent 协同）或拆解为多个子任务分别指派；ZCode 只在提交时附加分派指令模板（对话框中有提示，用户可见可预期），不做客户端侧判断。实测：Dispatcher 对「实现+自测」小任务判断为单 agent 即可，创建单个子任务指派给执行 agent，子任务完成后父任务经依赖自动汇总为 done。
- **面板与创建交互打磨**：卡片/任务行按设计规范改用 `rounded-xl` 容器层级与 `bg-card` 表面、hover 边框反馈、agent 头像底板与模型等宽徽章；任务行点击可展开描述全文（键盘可达，完成按钮独立动作不再联动展开）；创建对话框指派改为可视化选项组（自动分派置顶、显示调度人、agent 带 adapter 标识、可展开预览将附加的分派指令）、优先级改为分段选择、支持 ⌘/Ctrl+Enter 提交；创建成功 toast 反馈（自动分派时注明交给谁调度）；区标题带 agent/未结任务计数。
- **任务工作区绑定**：创建任务可选绑定 Paperclip 项目——「当前工作区」把当前 ZCode workspace 注册为 `local_path` 项目（按路径幂等，首次自动创建，已注册时默认选中），任务执行在项目工作区的 git worktree 中进行；也可选已有项目或不绑定。
- **本地 agent 注册**：面板新增「添加 agent」入口，探测本机已安装的 CLI（claude/kimi/grok/codex/gemini/opencode）一键注册为对应 local adapter 的 agent，复用 CLI 已有登录态；修复探测误报（`execFileSync` stdio ignore 时返回值恒为 null，改按是否抛错判定）。
- **第三方模型发现**：agent 配置弹窗的模型清单增加本机来源——读 Claude Code 的第三方网关配置（`~/.claude/settings.json`）直连 `/v1/models` 拉取真实可用模型（实测 11 个 GLM 模型，「本机网关」分组置顶展示），凭证不落日志；另支持手动输入模型 ID 优先生效。配置弹窗同时支持修改 agent 名称。
- **团队呈现优化**：主 Agent 置顶并以 info 描边强调；adapter 徽章改用各模型自身图标（Claude 星芒 / Gemini 四角星 / Grok 环箭头 / ChatGPT 花结 / Kimi 新月 / OpenCode）并去掉 `local` 后缀；agent 状态徽章带状态圆点并补全空闲/错误语义色；卡片底部按角色说明职责。修复 Radix Select 空值选项与 button 嵌套两类渲染报错。
- **本地服务启停（全平台原生运行，外置 PostgreSQL）**：`IPaperclipService` 新增 `startLocalServer` / `stopLocalServer` / `getLocalServerStatus`——以"发命令 + 健康探测"代管本机 Paperclip server，启动前探测保证幂等（多窗口/多宿主安全），轮询上限 300s（实测冷启动约 130s）。各平台均原生 `npx paperclipai@latest run`（Windows 经 `cmd.exe /c` 包裹 .cmd 并 detached，连接串持久化在实例配置；macOS/Linux setsid/nohup 守护独立存活），数据库一律外置 PostgreSQL 服务（Windows 内置 Administrator 全权令牌使内嵌 PG 无法原生运行，装 PostgreSQL 17 Windows 服务承载）；npx 解析覆盖 nvm4w/nvm/Homebrew 路径（GUI 启动无 PATH 也可用）。停止按进程命令行模式匹配终止（powershell Get-CimInstance / pkill，字符类技巧避免自匹配），外置 PG 服务不随 server 停止。UI：面板断连引导区「启动本地服务」+ 状态条「停止服务」+ 设置页「本地服务」块；启动成功后服务侧主动重连。Windows 实机全链路（停止→启动→detached 存活→幂等）验证通过。曾以 WSL 承载 Windows 侧 server（规避令牌问题），已废弃并全面移除 WSL 逻辑——WSL/Windows 双环境导致 CLI 检测与 agent 执行不一致。详见 spec「本地服务生命周期」节。
- **全新实例首连自举默认公司**：Paperclip `onboard` 不创建 company，全新实例 `/api/companies` 为空会导致 ZCode 永远停在 "no companies" 断连态（新部署实测踩中）；`ensureReady` 在公司列表为空时自动创建默认公司 "ZCode" 后正常连接。
- **面板交互迭代（主 Agent / 去重 / 服务启停 / agent 删除）**：连接状态条新增「停止服务」按钮（红色描边提示危险，点击直接执行；此前停止入口只在设置页，难发现）；修复停止服务后连接状态机停在黄色「手动刷新」轮询转圈的问题（WS 断开被解读为 polling 降级无限重试——现在用户主动停止会立即停掉 WS 重试链路并把状态置为 disconnected，面板回到断连引导态显示启动按钮）；面板操作按钮字号统一缩小一号（text-ui-sm）；团队新增第一个 agent 时默认成为主 Agent（role=ceo），主 Agent 标识可在 agent 配置弹窗手动切换（新 agent 置 ceo、原主 Agent 回落 general，即时生效）；新建任务指派默认值改为直接指派主 Agent（原为「自动分派」默认选中，仍可改选），主 Agent 行带标识徽章；每个 CLI（adapterType）只允许添加一个 agent（添加弹窗禁选已存在项并标注「已添加」，服务层重复创建直接拒绝）；agent 卡片支持删除（两步确认，主 Agent 删除有提示）；agent 配置弹窗样式重构为分区卡片（主 Agent 开关 / 名称 / 模型 / 推理力度）。
- **ZCode 自主执行模式**：ZCode 不作为被 Paperclip 驱动的 adapter，而是其自主执行端——公司在 Paperclip 侧有一个 http adapter 的 "ZCode" agent（`ensureZCodeAgent` 幂等创建并自动 pause 暂停心跳，防止 heartbeat 反复执行失败把任务标 blocked）；指派给它的任务在面板显示「在 ZCode 中执行」，点击后以 CAS checkout 原子认领（`expectedStatuses`，防双执行者冲突）→ 自动创建本地 ZCode 任务并切到聊天视图（prompt 由标题+描述拼装），执行全程可见可插话；完成后点「完成」回写 done + 摘要评论。ZCode 名下未结任务按「待 ZCode 执行」中性呈现并计入「等你」筛选、顶部横幅提示（含「执行下一个」）。实测依据与边界见 spec「ZCode 自主执行模式」节（agent key 直写需真实 run 上下文故 V1 由 board 代操作；无持久认领人字段，认领身份即 assignee）。
- **自动认领（`paperclipAutoClaim`）**：设置分区与待办横幅均有开关。开启后新指派给 ZCode 的任务自动认领，并在任务绑定项目的对应工作区（未打开则活动工作区）后台自动执行——复用 `zcode send` 打通的 `IZCodeTaskService.sendPrompt` admission 链（空闲开新轮、忙碌排队），不切视图、不抢活动标签；v4 预热超时或发送失败优雅降级为预填草稿。防重：内存 Set + sessionStorage，只处理差分新出现的任务。

#### 分组 / 项目独立数据源（`custom-resources.sqlite`）

- 任务分组（`task_groups` 等 4 张表）从 `tasks-index.sqlite` 拆到独立库 `~/.zcode/v2/custom-resources.sqlite`，`CustomResourcesRepo` 为唯一所有者；`IZCodeTaskService` 接口不变，UI 零改动。存量数据不迁移（从零开始），旧库分组表原样废弃。
- 项目会话三字段（`lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex`）从 `setting.json` 拆到新库 `resource_kv` 表；`settingService.get()/update()` 接口不变、内部按字段路由，`setting.json` 不再持久化这三个字段，其他配置存储不动。桌面主进程启动恢复改为只读新库（异常兜底空列表）。
- 任务生命周期分组钩子（cron / 闲时系统分组归属、删除任务清理、顶层排序初始化）经 `TaskGroupStorePort` 写入新库；跨库一致性由"任务行先提交 + 钩子失败告警 + 启动幂等收敛"保证。
- 详见 `specs/services/custom-resource-store.md`。

### 修复

- **连接编辑对话框（旧格式连接适配）**：编辑 v1 旧格式迁移来的连接时，「连接名称」用 `host/database` 派生标签预填（该连接此前从未存过名称/环境，字段为空属正常；保存后名称持久化，下次编辑正常回显）；「保存」按钮改为按必填项（host/端口/库/用户名）显式置灰，与「测试连接」同一套校验口径——只填名称/环境不会点亮保存。
- **数据库看板连接状态自愈**：服务重启/断连窗口期，挂载时的一次性调用失败会永久滞留——页头同时出现「尚未配置连接」与「已连接」徽标、数据浏览顶部滞留「尚未配置数据库连接」红色横幅，但表实际可查（服务端状态一致，纯粹是 UI 旧状态）。修复：面板打开期间每 15s 用内存态快照对账（服务端有激活连接而本地清单缺失时自动补拉连接清单）；页头选择器在清单暂缺时回退用快照合成条目，永不与状态徽标矛盾；表清单加载失败不再写入用户动作错误横幅，改为表列表内联错误 + 重试按钮（成功自动清除）。
- **数据库看板排版**：主视图去掉重复标题，line tabs 与连接切换/状态同一条工具栏；知识库默认让业务卡片占满剩余高度，项目档案与构建收进可折叠摘要；数据浏览表列表改为两行并纠正选中态 token；操作日志筛选并入面板头。
- **Web 端 server dev 不监听共享包源码**：`packages/server` 的 `tsup --watch` 默认只监听本包 `src`，修改 `packages/services`、`packages/shared` 等包后运行中的 server 不重建，表现为新增 RPC 通道 `Unknown channel` 超时。dev 脚本已显式追加共享包 `--watch` 列表（与桌面端 dev 同口径）。

### 移除

- **设置「引导(新)」功能整体废弃**（经架构调查确认：协议层无多根工作区支持，junction 聚合的 glob/grep/文件监听不穿透，遂放弃该方案；统一工作区规划另行推进，目录搬迁由用户手动处理）。已移除：`IGuideEntryService` / `GuideEntryStore` / `nativeDirectoryPicker`、migration `0002_guide_entries`（已应用过 0002 的库中残留账本行与空表不影响迁移判定）、`GuideNewPanel` 引导覆盖层及设置侧栏入口、相关 i18n 与 spec。历史提交见下方清单中 `dbc60bf` ~ `a83c2d7` 五条。

### 文档与工程

- `.gitignore`：新增工作区 `.zcode/plans/` 忽略（plan 模式按会话落盘的计划文档运行产物；`.zcode/commands/` 仍可跟踪）。
- `AGENTS.md`：新增「桌面端打包」分档说明（全量 / 快速）、「双端（Web / 桌面）开发与验证口径」（日常调试以 Web 端为主、共享层改动两端覆盖、Web 平台能力降级口径、发版前桌面端回归）与「Git 提交」规范（Conventional Commits + 每次提交同步维护 CHANGELOG.md）。
- 新增 spec：`specs/services/custom-resource-store.md`。
- `packages/web` vite dev 开启 `strictPort`：端口被占用时直接失败，避免端口顺延漂移。
- 测试：services 包新增 15 个单测（分组库 CRUD / 项目字段 KV 路由 / TaskIndexRepo 分组钩子接线 / Paperclip 本地服务控制器 9 例），累计 32 个全部通过；server 包新增 local-session-send 路由单测 9 个（目标解析 / 错误映射 / 预热），全部通过。

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
| `e9ca3d1` | revert: 移除已废弃的「引导(新)」功能 |
| `18ff19b` | feat(services): Paperclip 本地服务启停（Windows/WSL + macOS） |
| `b7d881c` | fix(services): 首连自动补建默认 Paperclip 公司 |
| `91f6746` | feat(paperclip): Windows 原生服务生命周期、lead-agent 体验与去重 |
| `69e7ac2` | feat(paperclip): ZCode 自主执行模式与自动认领 |
| 本次提交 | feat(db-board): 数据库看板三件套——数据操作+探索看板、项目业务知识库、数据库助手 Agent（MCP）+工作区绑定 |
