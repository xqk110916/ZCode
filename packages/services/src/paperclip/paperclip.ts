import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  PaperclipAdapterModel,
  PaperclipAgent,
  PaperclipConnectionStateSnapshot,
  PaperclipCreateIssueInput,
  PaperclipIssue,
  PaperclipIssueEvent,
  PaperclipIssueFilter,
  PaperclipLocalAdapterCandidate,
  PaperclipLocalServerStatus,
  PaperclipProject,
  PaperclipTestConnectionResult,
  PaperclipUpdateAgentInput,
  PaperclipUpdateIssueInput,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Paperclip 外部编排服务（browser-safe 接口层）。
 *
 * Paperclip 是独立部署的 agent 编排平台（默认 http://localhost:3100），本服务是
 * 其 REST/WS 客户端：ZCode 不镜像任务，派单后由 Paperclip 的 heartbeat 引擎唤醒
 * 对应 adapter（Claude Code / Grok Build 等）执行。任务/进程事实归 Paperclip 所有；
 * 本机 server 的启动/停止仅为"发命令 + 健康探测"的代管（见 startLocalServer），
 * 进程本身独立于 ZCode 宿主生命周期。行为契约见 specs/services/paperclip-integration.md。
 */
export interface IPaperclipService {
  /** 当前连接状态快照（含生效 server 地址与最近错误）。 */
  getConnectionState(): Promise<PaperclipConnectionStateSnapshot>;

  /** 用给定地址/token 探活（设置页「测试连接」用；不影响当前生效配置）。 */
  testConnection(url: string, token?: string): Promise<PaperclipTestConnectionResult>;

  /** 列出 Paperclip 公司内的 agent（只读；雇佣/配置在 Paperclip UI 完成）。 */
  listAgents(): Promise<PaperclipAgent[]>;

  /** adapter 可选模型列表（面板 agent 配置弹窗用）。 */
  listAdapterModels(adapterType: string): Promise<PaperclipAdapterModel[]>;

  /**
   * 从本机 Claude Code 配置的第三方网关发现真实可用模型（读 ~/.claude/settings.json
   * 的 ANTHROPIC_BASE_URL/TOKEN，调 /v1/models；无配置或失败返回空）。凭证不落日志。
   */
  discoverClaudeModels(): Promise<PaperclipAdapterModel[]>;

  /** 更新 agent 的模型/推理力度（PATCH /api/agents/{id}，merge 语义）。 */
  updateAgent(agentId: string, patch: PaperclipUpdateAgentInput): Promise<PaperclipAgent>;

  /**
   * 确保公司存在 dispatcher（role="ceo"）agent：命中返回既有；无则创建
   * （默认 claude_local，复用宿主机 CLI 登录态）。幂等。
   */
  ensureDispatcherAgent(): Promise<PaperclipAgent>;

  /** 在公司内创建 agent（面板「添加本地 agent」入口；常规雇佣仍在 Paperclip UI）。 */
  createAgent(input: { name: string; adapterType: string; role?: string }): Promise<PaperclipAgent>;

  /** 检测本机可用的 CLI 与 Paperclip local adapter 的映射（PATH 上是否可见）。 */
  detectLocalAgentAdapters(): Promise<PaperclipLocalAdapterCandidate[]>;

  /** 项目列表（任务的工作区载体）。 */
  listProjects(): Promise<PaperclipProject[]>;

  /**
   * 确保存在绑定指定本地路径的项目（codebase.localFolder === cwd）：命中返回既有；
   * 无则创建（sourceType=local_path，任务执行时从该工作区解析 git worktree）。幂等。
   */
  ensureProjectForWorkspace(input: { name: string; cwd: string }): Promise<PaperclipProject>;

  /** 按筛选列任务；Paperclip 是任务事实源，每次调用都走当次 API 查询。 */
  listIssues(filter?: PaperclipIssueFilter): Promise<PaperclipIssue[]>;

  /** 创建任务并指派（Paperclip 收到后自动入唤醒队列）。 */
  createIssue(input: PaperclipCreateIssueInput): Promise<PaperclipIssue>;

  /** 更新任务（状态流转、优先级等）；comment 与状态变更同请求提交（审批门禁要求）。 */
  updateIssue(issueId: string, patch: PaperclipUpdateIssueInput): Promise<PaperclipIssue>;

  /** 在任务线程追加评论（会触发 Paperclip 侧对 assignee 的唤醒）。 */
  postComment(issueId: string, body: string): Promise<void>;

  /**
   * 启动本机 Paperclip server（Windows=WSL 启动脚本；macOS/Linux=原生 npx run）。
   * 已在运行时幂等返回 running；启动期间轮询健康直到就绪（最长 120s）。
   */
  startLocalServer(): Promise<PaperclipLocalServerStatus>;

  /** 停止本机 Paperclip server（按命令模式匹配进程，含内嵌 PostgreSQL）；未运行时幂等。 */
  stopLocalServer(): Promise<PaperclipLocalServerStatus>;

  /** 本机 server 进程状态（按健康探测合成）。 */
  getLocalServerStatus(): Promise<PaperclipLocalServerStatus>;

  /** 连接状态迁移（含 connected↔polling 的 WS 降级）。 */
  onDidChangeConnectionState: Event<PaperclipConnectionStateSnapshot>;

  /** live-events WS 归一化后的任务事件推送。 */
  onDidReceiveIssueEvent: Event<PaperclipIssueEvent>;
}

export const IPaperclipService = createServiceDescriptor<IPaperclipService>(
  ServiceChannels.Paperclip,
);
