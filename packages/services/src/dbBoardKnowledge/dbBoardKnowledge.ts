import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 数据库看板 · 项目业务知识库（browser-safe 接口层）。
 *
 * 引导收集 + 复用 ZCode 模型链路：只做轻量代码证据收集（文本定位/切片），
 * 语义理解交给 generateWorkspaceText；不实现写代码/调服务能力。
 * 行为契约见 specs/services/db-board-knowledge.md。
 */

// ============================================================================
// 项目注册与探测
// ============================================================================

export interface DbBoardKnowledgeNacosConfig {
  serverAddr: string;
  namespace?: string;
  username?: string;
  /** 保存时写 credentialService；接口返回时恒为空。 */
  password?: string;
}

export interface DbBoardKnowledgeProfile {
  /** 项目根目录（可包含多个 git 仓库；也允许单仓库根）。 */
  projectRoot: string;
  nacos?: DbBoardKnowledgeNacosConfig;
  /** 项目档案绑定的数据库连接（保存时同步激活为看板当前连接）。 */
  dbBinding?: { connectionId: string };
}

export interface DbBoardKnowledgeRepoInfo {
  /** 仓库绝对路径。 */
  path: string;
  /** 相对项目根目录的显示名。 */
  name: string;
  stack: "maven" | "node" | "other";
}

export interface DbBoardKnowledgeProbeResult {
  root: string;
  repos: DbBoardKnowledgeRepoInfo[];
  /** 从 application-*.yml / bootstrap.yml 自动发现的 Nacos 配置（密码掩码）。 */
  discoveredNacos?: DbBoardKnowledgeNacosConfig;
  discoveredDatasourceUrls?: string[];
  error?: string;
}

// ============================================================================
// 知识本体
// ============================================================================

export interface DbBoardKnowledgeColumnMeaning {
  name: string;
  meaning: string;
}

export interface DbBoardKnowledgeRelation {
  target: string;
  on?: string;
  kind?: string;
}

/** 单张表的业务知识卡片（蒸馏产物；失败时为纯抽取降级卡）。 */
export interface DbBoardKnowledgeTableCard {
  table: string;
  domain: string;
  /** 表的中文业务用途（一句话）。 */
  purpose: string;
  keyColumns: DbBoardKnowledgeColumnMeaning[];
  relations: DbBoardKnowledgeRelation[];
  notes?: string;
  /** 该表知识来自哪些证据文件（相对项目根），增量反查用。 */
  evidenceFiles: string[];
  /** LLM 蒸馏 | 纯抽取降级 | DB 注释。 */
  source: "distilled" | "extracted" | "db-comment";
}

export interface DbBoardKnowledgeRepoSnapshot {
  path: string;
  head: string;
}

export interface DbBoardKnowledge {
  version: 1;
  builtAt: string;
  /** 域名 → 表名列表。 */
  domains: Record<string, string[]>;
  tables: Record<string, DbBoardKnowledgeTableCard>;
  repoSnapshots: DbBoardKnowledgeRepoSnapshot[];
  /** 构建摘要：表数/域数/各来源计数/Nacos 概要。 */
  stats: {
    tableCount: number;
    domainCount: number;
    distilled: number;
    extracted: number;
    dbCommentOnly: number;
    nacosServices?: string[];
    datasourceMapping?: Array<{ service: string; url: string }>;
    lastIncrementalAt?: string;
  };
}

// ============================================================================
// 构建任务
// ============================================================================

export type DbBoardKnowledgeBuildStage =
  | "probe"
  | "scan"
  | "db-comments"
  | "nacos"
  | "distill"
  | "persist"
  | "done";

export type DbBoardKnowledgeBuildStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DbBoardKnowledgeBuildProgress {
  status: DbBoardKnowledgeBuildStatus;
  stage: DbBoardKnowledgeBuildStage;
  /** 当前阶段内的进度：done/total；无量化时 total=0。 */
  done: number;
  total: number;
  /** 人类可读的阶段描述（中文，含计数）。 */
  detail: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** 本次构建为增量时列出受影响的表。 */
  incrementalTables?: string[];
}

export type DbBoardKnowledgeBuildEvent = DbBoardKnowledgeBuildProgress;

// ============================================================================
// 服务接口
// ============================================================================

export interface IDbBoardKnowledgeService {
  getProfile(): Promise<DbBoardKnowledgeProfile | null>;
  /** nacosPassword 存 credentialService，不落知识文件。 */
  saveProfile(profile: DbBoardKnowledgeProfile, nacosPassword?: string): Promise<void>;

  /** 探测项目根目录（只读，不落盘）：仓库列表 + 技术栈 + Nacos/数据源线索。 */
  probeProject(root: string): Promise<DbBoardKnowledgeProbeResult>;

  /** 全量构建知识库（单当前任务语义：新构建会取消旧构建）。 */
  startBuild(): Promise<void>;
  cancelBuild(): Promise<void>;
  getBuildState(): Promise<DbBoardKnowledgeBuildProgress>;
  onBuildProgress: import("@zcode/rpc").Event<DbBoardKnowledgeBuildEvent>;

    getKnowledge(): Promise<DbBoardKnowledge | null>;
    /** 手动新增/编辑一张表卡片（按 card.table upsert，域分组与统计同步重算）。 */
    saveTableCard(card: DbBoardKnowledgeTableCard): Promise<void>;
    /** 手动删除一张表卡片。 */
    deleteTableCard(table: string): Promise<void>;
    /**
     * 手动蒸馏单张表卡（不落盘）：汇集 DB 表/列注释与既有卡片字段作为证据，
     * 一次 LLM 调用产出草稿卡，供前端表单填充后由用户确认保存。
     */
    distillTableCard(input: { schema: string; table: string }): Promise<DbBoardKnowledgeTableCard>;
    deleteKnowledge(): Promise<void>;
}

export const IDbBoardKnowledgeService = createServiceDescriptor<IDbBoardKnowledgeService>(
  ServiceChannels.DbBoardKnowledge,
);
