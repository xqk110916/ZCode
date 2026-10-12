/* eslint-disable max-lines -- 提取器共享同一组正则常量与类型依赖；
 * 拆散会让模式定义与提取逻辑跨多文件拼装，与 dbBoardService.ts 同口径保留单文件。 */
/**
 * 代码知识图谱提取器：正则级纯函数，无 IO。
 *
 * 设计与 dbBoardKnowledgeExtract.ts 同口径：提取可靠的结构信号，
 * 语义理解交给 LLM 蒸馏。每个函数接受源码字符串，返回结构化数据。
 */

import type {
  CodeGraphNode,
  CodeGraphEdge,
  HardcodedKind,
} from "./codeGraphTypes.js";

// ============================================================================
// 硬编码检测
// ============================================================================

interface HardcodedMatch {
  value: string;
  kind: HardcodedKind;
  line: number;
  context: string;
}

const HARDCODED_PATTERNS: Array<{
  regex: RegExp;
  kind: HardcodedKind;
}> = [
  // 用户 ID（USER_ 前缀 + 32 位 hex）
  { regex: /\b(USER_[a-f0-9]{32})\b/g, kind: "userID" },
  // 部门 ID（HZ 前缀 + 20+ 位 hex）
  { regex: /\b(HZ[a-f0-9]{20,})\b/g, kind: "deptID" },
  // 字典 ID（DICTIONARIES_ID= 或作为参数传递的 32 位 hex）
  { regex: /\b(?:DICTIONARIES_ID[=:]\s*["']?|dictId[=(:]\s*["'])([a-f0-9]{32})/g, kind: "dictID" },
  // 角色 ID（roleId/ROLE_ID 相关的 32 位 hex）
  { regex: /\b(?:roleId[=:\s(]+|ROLE_ID\w*\s*=\s*["'])([a-f0-9]{32})/g, kind: "roleID" },
  // 通用 32 位 hex（可能是任何实体的 ID）
  { regex: /\b([a-f0-9]{32})\b/g, kind: "userID" },
];

const USERNAME_PATTERNS: Array<{
  regex: RegExp;
  kind: HardcodedKind;
}> = [
  // username === 'xxx' 或 username == 'xxx'
  { regex: /username\s*={2,3}\s*['"](\w+)['"]/g, kind: "username" },
  // localStorage.getItem('username') === 'xxx'
  { regex: /getItem\(['"]username['"]\)\s*={2,3}\s*['"](\w+)['"]/g, kind: "username" },
  // roleName / deptName 硬编码
  { regex: /(?:roleName|deptName|role\.name)\s*={2,3}\s*['"](.+?)['"]/g, kind: "roleID" },
];

const STATUS_CODE_PATTERN = /\bif\s*\(\s*(?:status|type|state|docStatus|flowStatus)\w*\s*={2,3}\s*['"]?(\d+)['"]?\s*\)/g;

const CONFIG_KEY_PATTERN = /@Value\("\$\{([^}]+)\}"\)/g;

function extractContext(lines: string[], lineIndex: number, radius = 3): string {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length, lineIndex + radius + 1);
  return lines.slice(start, end).join("\n");
}

function collectMatches(
  source: string,
  patterns: Array<{ regex: RegExp; kind: HardcodedKind }>,
): HardcodedMatch[] {
  const lines = source.split("\n");
  const results: HardcodedMatch[] = [];
  const seen = new Set<string>();

  for (const { regex, kind } of patterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const value = match[1] ?? match[0];
      const before = source.slice(0, match.index);
      const line = before.split("\n").length - 1;
      const key = `${value}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        value,
        kind,
        line: line + 1,
        context: extractContext(lines, line),
      });
    }
  }
  return results;
}

export function extractHardcoded(
  source: string,
  filePath: string,
): Array<{ node: CodeGraphNode; edge: CodeGraphEdge }> {
  const results: Array<{ node: CodeGraphNode; edge: CodeGraphEdge }> = [];
  const allMatches = collectMatches(source, [...HARDCODED_PATTERNS, ...USERNAME_PATTERNS]);

  // 状态码魔法数字
  const statusRegex = new RegExp(STATUS_CODE_PATTERN.source, "g");
  const lines = source.split("\n");
  let match: RegExpExecArray | null;
  while ((match = statusRegex.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    const line = before.split("\n").length - 1;
    allMatches.push({
      value: match[1] ?? "0",
      kind: "statusCode" as const,
      line: line + 1,
      context: extractContext(lines, line),
    });
  }

  for (const item of allMatches) {
    const nodeId = `hardcoded:${filePath}:${item.line}:${item.value}`;
    results.push({
      node: {
        id: nodeId,
        type: "hardcoded",
        name: item.value,
        qualifiedName: `${filePath}:${item.line}`,
        file: filePath,
        line: item.line,
        metadata: {
          value: item.value,
          kind: item.kind,
          context: item.context.slice(0, 500),
        },
      },
      edge: {
        from: nodeId,
        to: `file:${filePath}`,
        type: "LOCATED_IN",
      },
    });
  }
  return results;
}

// ============================================================================
// Java 结构提取
// ============================================================================

export interface JavaClassInfo {
  className: string;
  packageName: string;
  filePath: string;
  methods: JavaMethodInfo[];
  configInjections: Array<{ key: string; field: string }>;
}

export interface JavaMethodInfo {
  name: string;
  signature: string;
  returnType: string;
  line: number;
  annotations: string[];
  mapperCalls: Array<{ mapper: string; method: string }>;
  serviceCalls: Array<{ service: string; method: string }>;
}

const CLASS_PATTERN = /(?:public\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?\s*\{/;
const PACKAGE_PATTERN = /package\s+([\w.]+);/;
const METHOD_PATTERN = /(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?([\w<>\[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{/g;
const MAPPER_CALL_PATTERN = /(\w+Mapper)\.(\w+)\s*\(/g;
const SERVICE_CALL_PATTERN = /(\w+Service)\.(\w+)\s*\(/g;
const ANNOTATION_PATTERN = /@(\w+)(?:\(([^)]*)\))?/g;
const CONTROLLER_MAPPING_PATTERN = /@(GetMapping|PostMapping|PutMapping|DeleteMapping)(?:\(\s*(?:value\s*=\s*)?["']([^"']*)["'][^)]*\))?/g;

export function extractJavaStructure(
  source: string,
  filePath: string,
): JavaClassInfo | null {
  const packageMatch = source.match(PACKAGE_PATTERN);
  const packageName = packageMatch?.[1] ?? "";
  const classMatch = source.match(CLASS_PATTERN);
  if (!classMatch) return null;
  const className = classMatch[1] ?? "";

  const methods: JavaMethodInfo[] = [];
  const methodRegex = new RegExp(METHOD_PATTERN.source, "g");
  let methodMatch: RegExpExecArray | null;

  while ((methodMatch = methodRegex.exec(source)) !== null) {
    const before = source.slice(0, methodMatch.index);
    const line = before.split("\n").length;
    const returnType = (methodMatch[1] ?? "").trim();
    const name = methodMatch[2] ?? "";
    const params = (methodMatch[3] ?? "").trim();

    // 提取方法前的注解
    const annotationBlock = before.slice(Math.max(0, before.length - 300));
    const annotations: string[] = [];
    const annRegex = new RegExp(ANNOTATION_PATTERN.source, "g");
    let annMatch: RegExpExecArray | null;
    while ((annMatch = annRegex.exec(annotationBlock)) !== null) {
      annotations.push(annMatch[1] ?? "");
    }

    // 提取方法体内的 Mapper/Service 调用（截取方法后续 ~2000 字符）
    const bodyStart = methodMatch.index + methodMatch[0].length;
    const bodyChunk = source.slice(bodyStart, bodyStart + 2000);
    const mapperCalls: Array<{ mapper: string; method: string }> = [];
    const serviceCalls: Array<{ service: string; method: string }> = [];

    const mapperRegex = new RegExp(MAPPER_CALL_PATTERN.source, "g");
    let mapperMatch: RegExpExecArray | null;
    while ((mapperMatch = mapperRegex.exec(bodyChunk)) !== null) {
      mapperCalls.push({ mapper: mapperMatch[1] ?? "", method: mapperMatch[2] ?? "" });
    }
    const serviceRegex = new RegExp(SERVICE_CALL_PATTERN.source, "g");
    let serviceMatch: RegExpExecArray | null;
    while ((serviceMatch = serviceRegex.exec(bodyChunk)) !== null) {
      const svcName = serviceMatch[1] ?? "";
      if (!svcName.endsWith("Mapper")) {
        serviceCalls.push({ service: svcName, method: serviceMatch[2] ?? "" });
      }
    }

    methods.push({
      name,
      signature: `${returnType} ${name}(${params})`,
      returnType,
      line,
      annotations: [...new Set(annotations)],
      mapperCalls: [...new Set(mapperCalls.map((c) => `${c.mapper}.${c.method}`))].map((s) => {
        const [mapper = "", method = ""] = s.split(".");
        return { mapper, method };
      }),
      serviceCalls: [...new Set(serviceCalls.map((c) => `${c.service}.${c.method}`))].map((s) => {
        const [service = "", method = ""] = s.split(".");
        return { service, method };
      }),
    });
  }

  // 配置注入
  const configInjections: Array<{ key: string; field: string }> = [];
  const configRegex = new RegExp(CONFIG_KEY_PATTERN.source, "g");
  let configMatch: RegExpExecArray | null;
  while ((configMatch = configRegex.exec(source)) !== null) {
    const after = source.slice(configMatch.index + configMatch[0].length);
    const fieldMatch = after.match(/private\s+\w+\s+(\w+)/);
    configInjections.push({
      key: configMatch[1] ?? "",
      field: fieldMatch?.[1] ?? "",
    });
  }

  return { className, packageName, filePath, methods, configInjections };
}

// ============================================================================
// Controller 端点提取
// ============================================================================

export interface EndpointInfo {
  url: string;
  httpMethod: string;
  methodName: string;
  className: string;
  filePath: string;
  line: number;
}

export function extractEndpoints(
  source: string,
  filePath: string,
): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  const classMatch = source.match(CLASS_PATTERN);
  if (!classMatch) return endpoints;
  const className = classMatch[1] ?? "";

  // 类级 @RequestMapping 作为前缀
  let prefix = "";
  const prefixMatch = source.match(/@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']*)["']/);
  if (prefixMatch) prefix = prefixMatch[1] ?? "";

  const regex = new RegExp(CONTROLLER_MAPPING_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const annotation = match[1];
    const path = match[2] ?? "";
    const httpMethod =
      annotation === "GetMapping" ? "GET"
      : annotation === "PostMapping" ? "POST"
      : annotation === "PutMapping" ? "PUT"
      : annotation === "DeleteMapping" ? "DELETE"
      : "ANY";

    // 找注解后面的方法名
    const after = source.slice(match.index + match[0].length);
    const methodMatch = after.match(/(?:public\s+)?[\w<>[\]]+\s+(\w+)\s*\(/);
    const methodName = methodMatch?.[1] ?? "";
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;

    const fullUrl = `${prefix}${path}`.replace(/\/+/g, "/") || "/";
    endpoints.push({ url: fullUrl, httpMethod, methodName, className, filePath, line });
  }
  return endpoints;
}

// ============================================================================
// 前端 API 调用提取
// ============================================================================

export interface FrontendApiCall {
  url: string;
  httpMethod: string;
  filePath: string;
  line: number;
  context: string;
}

const FRONTEND_API_PATTERNS: Array<{
  regex: RegExp;
  httpMethod: string;
}> = [
  { regex: /utils\.ajaxPOST\(\s*['"]([^'"]+)['"]/g, httpMethod: "POST" },
  { regex: /utils\.ajaxGet\(\s*['"]([^'"]+)['"]/g, httpMethod: "GET" },
  { regex: /utils\.ajax\(\s*['"]([^'"]+)['"]/g, httpMethod: "POST" },
  { regex: /http\.(?:post|PUT|put)\(\s*['"]([^'"]+)['"]/g, httpMethod: "POST" },
  { regex: /http\.(?:get|GET)\(\s*['"]([^'"]+)['"]/g, httpMethod: "GET" },
  { regex: /request\(\s*\{\s*url\s*:\s*['"]([^'"]+)['"]/g, httpMethod: "ANY" },
  // HJT 常见模式：URL 先赋给变量再传给 ajax 调用（含三元表达式）
  { regex: /(?:var|let|const)\s+\w+\s*=\s*['"]([\w/?&=.-]+\/[\w/?&=.-]+)['"]\s*[;\n]/g, httpMethod: "ANY" },
  // 广义：任何含 / 的引号字符串且形如相对路径（兜底三元/拼接/对象属性等场景）
  { regex: /['"]([a-zA-Z][\w-]*\/[\w./?&=-]+)['"]/g, httpMethod: "ANY" },
];

export function extractFrontendApiCalls(
  source: string,
  filePath: string,
): FrontendApiCall[] {
  const lines = source.split("\n");
  const results: FrontendApiCall[] = [];
  const seen = new Set<string>();

  for (const { regex, httpMethod } of FRONTEND_API_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const url = match[1];
      // 过滤明显不是 API 路径的（如纯静态资源）
      if (!url || !url.includes("/") || url.startsWith("http") || url.endsWith(".js") || url.endsWith(".css") || url.endsWith(".png") || url.endsWith(".jpg")) {
        continue;
      }
      const before = source.slice(0, match.index);
      const line = before.split("\n").length - 1;
      const key = `${url}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        url,
        httpMethod,
        filePath,
        line: line + 1,
        context: extractContext(lines, line, 2),
      });
    }
  }
  return results;
}

// ============================================================================
// 特殊情况提取
// ============================================================================

export interface SpecialCaseInfo {
  description: string;
  filePath: string;
  line: number;
  kind: "special" | "todo" | "fixme" | "hack" | "temp";
}

const SPECIAL_CASE_PATTERNS: Array<{
  regex: RegExp;
  kind: SpecialCaseInfo["kind"];
}> = [
  { regex: /\/\/\s*(.*特殊.*)/g, kind: "special" },
  { regex: /\/\/\s*(?:TODO|todo)[:：]?\s*(.+)/g, kind: "todo" },
  { regex: /\/\/\s*(?:FIXME|fixme)[:：]?\s*(.+)/g, kind: "fixme" },
  { regex: /\/\/\s*(?:HACK|hack)[:：]?\s*(.+)/g, kind: "hack" },
  { regex: /\/\/\s*(.*临时.*)/g, kind: "temp" },
];

export function extractSpecialCases(
  source: string,
  filePath: string,
): SpecialCaseInfo[] {
  const results: SpecialCaseInfo[] = [];
  for (const { regex, kind } of SPECIAL_CASE_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const before = source.slice(0, match.index);
      const line = before.split("\n").length;
      results.push({
        description: (match[1] ?? "").trim().slice(0, 200),
        filePath,
        line,
        kind,
      });
    }
  }
  return results;
}

// ============================================================================
// 图构建：将提取结果转为节点 + 边
// ============================================================================

export function buildGraphFromClass(
  info: JavaClassInfo,
): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  const classId = `class:${info.packageName}.${info.className}`;

  nodes.push({
    id: classId,
    type: "class",
    name: info.className,
    qualifiedName: `${info.packageName}.${info.className}`,
    file: info.filePath,
    metadata: {},
  });

  for (const method of info.methods) {
    const methodId = `method:${info.packageName}.${info.className}.${method.name}`;
    nodes.push({
      id: methodId,
      type: "method",
      name: method.name,
      qualifiedName: `${info.packageName}.${info.className}.${method.name}`,
      file: info.filePath,
      line: method.line,
      metadata: {
        signature: method.signature,
        returnType: method.returnType,
        annotations: method.annotations,
      },
    });
    edges.push({ from: classId, to: methodId, type: "CONTAINS" });

    // Mapper 调用 → USES_TABLE 边（表名由调用方解析补充）
    for (const call of method.mapperCalls) {
      const targetId = `method:${info.packageName}.${call.mapper}.${call.method}`;
      edges.push({
        from: methodId,
        to: targetId,
        type: "CALLS",
        metadata: { callContext: `mapper call: ${call.mapper}.${call.method}` },
      });
    }

    // Service 调用 → CALLS 边
    for (const call of method.serviceCalls) {
      const targetId = `method:${info.packageName}.${call.service}.${call.method}`;
      edges.push({
        from: methodId,
        to: targetId,
        type: "CALLS",
        metadata: { callContext: `service call: ${call.service}.${call.method}` },
      });
    }
  }

  // 配置注入 → DEPENDS_ON_CONFIG 边
  for (const config of info.configInjections) {
    const configId = `hardcoded:config:${config.key}`;
    edges.push({
      from: classId,
      to: configId,
      type: "DEPENDS_ON_CONFIG",
      metadata: { callContext: `@Value(${config.key}) -> ${config.field}` },
    });
  }

  return { nodes, edges };
}

export function buildGraphFromEndpoints(
  endpoints: EndpointInfo[],
): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];

  for (const ep of endpoints) {
    const endpointId = `endpoint:${ep.httpMethod}:${ep.url}`;
    nodes.push({
      id: endpointId,
      type: "endpoint",
      name: `${ep.httpMethod} ${ep.url}`,
      qualifiedName: `${ep.className}.${ep.methodName}`,
      file: ep.filePath,
      line: ep.line,
      metadata: { url: ep.url, httpMethod: ep.httpMethod },
    });

    // endpoint ↔ Controller 方法
    const methodId = `method:${ep.className}.${ep.methodName}`;
    edges.push({ from: endpointId, to: methodId, type: "MAPS_TO" });
  }
  return { nodes, edges };
}

export function buildGraphFromApiCalls(
  calls: FrontendApiCall[],
  pageName: string,
): { nodes: CodeGraphNode[]; edges: CodeGraphEdge[] } {
  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  const pageId = `page:${pageName}`;

  for (const call of calls) {
    const callId = `apiCall:${call.filePath}:${call.line}:${call.url}`;
    nodes.push({
      id: callId,
      type: "apiCall",
      name: call.url,
      qualifiedName: `${call.filePath}:${call.line}`,
      file: call.filePath,
      line: call.line,
      metadata: { url: call.url, httpMethod: call.httpMethod },
    });
    edges.push({ from: pageId, to: callId, type: "RENDERS" });

    // apiCall → endpoint（按 URL 匹配）
    const endpointId = `endpoint:${call.httpMethod}:${call.url}`;
    edges.push({ from: callId, to: endpointId, type: "MAPS_TO" });
  }
  return { nodes, edges };
}
