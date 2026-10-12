/**
 * 代码知识图谱：类型定义（browser-safe，纯类型无 IO）。
 *
 * 图谱 = 节点（方法/类/端点/前端调用/页面/表/域/硬编码项）+ 边（包含/调用/映射/用表/渲染/写死于/属域）。
 * 行为规范见 specs/services/code-graph.md。
 */

// ============================================================================
// 节点
// ============================================================================

export type CodeGraphNodeType =
  | "method"
  | "class"
  | "endpoint"
  | "apiCall"
  | "page"
  | "table"
  | "domain"
  | "hardcoded";

/** 硬编码项的具体类型。 */
export type HardcodedKind =
  | "userID"
  | "deptID"
  | "roleID"
  | "dictID"
  | "username"
  | "statusCode"
  | "configKey"
  | "url";

export interface CodeGraphNode {
  /** 全局唯一："{type}:{qualifiedName}"。 */
  id: string;
  type: CodeGraphNodeType;
  /** 短名（方法名/类名/URL 路径段）。 */
  name: string;
  /** 完整限定名（包名.类名.方法名 或 文件路径:行号）。 */
  qualifiedName: string;
  /** 仓库相对路径。 */
  file: string;
  line?: number;
  metadata: {
    // method: { signature, returnType, annotations[] }
    // endpoint: { url, httpMethod }
    // apiCall: { url, httpMethod }
    // page: { title }
    // table: { comment }
    // hardcoded: { value, kind, context }
    // domain: { description }
    [key: string]: unknown;
  };
}

// ============================================================================
// 边
// ============================================================================

export type CodeGraphEdgeType =
  | "CONTAINS"       // class → method
  | "CALLS"          // method → method（同文件或按方法名匹配）
  | "MAPS_TO"        // endpoint ↔ method（Controller 方法）
  | "USES_TABLE"     // method → table（经 Mapper 调用）
  | "RENDERS"        // page → apiCall（前端页面调用 API）
  | "LOCATED_IN"     // hardcoded → method/class/page（硬编码所在位置）
  | "BELONGS_TO_DOMAIN" // class/page → domain
  | "DEPENDS_ON_CONFIG";  // method → hardcoded(configKey)

export interface CodeGraphEdge {
  from: string;
  to: string;
  type: CodeGraphEdgeType;
  metadata?: {
    sqlFragment?: string;
    callContext?: string;
  };
}

// ============================================================================
// 文档
// ============================================================================

export interface CodeGraphDoc {
  version: 1;
  builtAt: string;
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  repoSnapshots: Array<{ path: string; head: string }>;
  stats: {
    nodeCount: number;
    edgeCount: number;
    methodCount: number;
    endpointCount: number;
    apiCallCount: number;
    hardcodedCount: number;
    pageCount: number;
  };
}

// ============================================================================
// LLM 蒸馏结果
// ============================================================================

export interface MethodKnowledge {
  methodId: string;
  /** 中文业务逻辑描述。 */
  purpose: string;
  /** 影响范围（中文描述，图遍历结果供 LLM 参考）。 */
  impactScope: string;
  /** 硬编码说明（如「角色ID CSLD 对应测量大队」）。 */
  hardcodedNotes?: string[];
  /** 特殊情况（如「jiyaosw 用户有特殊处理」）。 */
  specialCases?: string[];
}

export interface HardcodedAnalysis {
  value: string;
  /** 中文含义（如「流转进度-人员过滤角色ID」）。 */
  meaning: string;
  /** 风险说明（如「角色删除后权限过滤会静默失效」）。 */
  risk: string;
}

// ============================================================================
// 影响分析结果（图遍历，无需 LLM）
// ============================================================================

export interface ImpactResult {
  origin: string;
  affectedMethods: Array<{ id: string; name: string; file: string }>;
  affectedEndpoints: Array<{ id: string; url: string; file: string }>;
  affectedPages: Array<{ id: string; name: string; file: string }>;
  affectedTables: Array<{ id: string; name: string }>;
  hardcodedDependencies: Array<{
    id: string;
    value: string;
    kind: HardcodedKind;
    file: string;
    line?: number;
  }>;
}
