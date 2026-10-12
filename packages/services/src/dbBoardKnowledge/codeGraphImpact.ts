/**
 * 代码知识图谱：影响范围分析（纯函数，无 IO）。
 *
 * 给定图 + 起点节点 ID，沿 CALLS/USES_TABLE/MAPS_TO/RENDERS 边 BFS，
 * 返回所有受影响的前端页面、API 端点、数据库表、方法及硬编码依赖。
 */

import type { CodeGraphDoc, CodeGraphNode, ImpactResult } from "./codeGraphTypes.js";

const IMPACT_EDGE_TYPES = new Set(["CALLS", "USES_TABLE", "MAPS_TO", "RENDERS", "LOCATED_IN"]);

/** 反向影响：谁调用了这个节点（upstream）+ 这个节点影响了什么（downstream）。 */
export function traceImpact(graph: CodeGraphDoc, nodeId: string): ImpactResult | null {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const origin = nodeMap.get(nodeId);
  if (!origin) return null;

  // 正向 BFS（downstream：这个方法影响什么）
  const downstream = bfs(graph, nodeId, "forward");
  // 反向 BFS（upstream：谁调用了这个方法 → 哪些页面最终受影响）
  const upstream = bfs(graph, nodeId, "backward");
  const all = new Map([...downstream, ...upstream]);

  const affectedMethods: ImpactResult["affectedMethods"] = [];
  const affectedEndpoints: ImpactResult["affectedEndpoints"] = [];
  const affectedPages: ImpactResult["affectedPages"] = [];
  const affectedTables: ImpactResult["affectedTables"] = [];
  const hardcodedDependencies: ImpactResult["hardcodedDependencies"] = [];

  for (const [id, node] of all) {
    if (id === nodeId) continue;
    switch (node.type) {
      case "method":
      case "class":
        affectedMethods.push({ id, name: node.name, file: node.file });
        break;
      case "endpoint":
        affectedEndpoints.push({
          id,
          url: (node.metadata.url as string) ?? node.name,
          file: node.file,
        });
        break;
      case "page":
        affectedPages.push({ id, name: node.name, file: node.file });
        break;
      case "table":
        affectedTables.push({ id, name: node.name });
        break;
      case "hardcoded":
        hardcodedDependencies.push({
          id,
          value: (node.metadata.value as string) ?? node.name,
          kind: (node.metadata.kind as ImpactResult["hardcodedDependencies"][number]["kind"]) ?? "configKey",
          file: node.file,
          line: node.line,
        });
        break;
    }
  }

  return {
    origin: nodeId,
    affectedMethods: dedupe(affectedMethods, (m) => m.id),
    affectedEndpoints: dedupe(affectedEndpoints, (e) => e.id),
    affectedPages: dedupe(affectedPages, (p) => p.id),
    affectedTables: dedupe(affectedTables, (t) => t.id),
    hardcodedDependencies: dedupe(hardcodedDependencies, (h) => h.id),
  };
}

function bfs(
  graph: CodeGraphDoc,
  startId: string,
  direction: "forward" | "backward",
): Map<string, CodeGraphNode> {
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([startId]);
  const queue = [startId];
  const result = new Map<string, CodeGraphNode>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const edges = graph.edges.filter((e) =>
      direction === "forward"
        ? e.from === current && IMPACT_EDGE_TYPES.has(e.type)
        : e.to === current && IMPACT_EDGE_TYPES.has(e.type),
    );
    for (const edge of edges) {
      const nextId = direction === "forward" ? edge.to : edge.from;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      const node = nodeMap.get(nextId);
      if (node) {
        result.set(nextId, node);
        queue.push(nextId);
      }
    }
  }
  return result;
}

function dedupe<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// 图搜索
// ============================================================================

export interface GraphSearchParams {
  query?: string;
  type?: string;
  file?: string;
  limit?: number;
}

export function searchGraph(
  graph: CodeGraphDoc,
  params: GraphSearchParams,
): CodeGraphNode[] {
  let results = graph.nodes;
  if (params.type) {
    results = results.filter((n) => n.type === params.type);
  }
  if (params.file) {
    const fileLower = params.file.toLowerCase();
    results = results.filter((n) => n.file.toLowerCase().includes(fileLower));
  }
  if (params.query) {
    const q = params.query.toLowerCase();
    results = results.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.qualifiedName.toLowerCase().includes(q) ||
        JSON.stringify(n.metadata).toLowerCase().includes(q),
    );
  }
  return results.slice(0, params.limit ?? 50);
}

export function findHardcoded(
  graph: CodeGraphDoc,
  params: { kind?: string; value?: string; file?: string; limit?: number },
): CodeGraphNode[] {
  let results = graph.nodes.filter((n) => n.type === "hardcoded");
  if (params.kind) {
    results = results.filter((n) => n.metadata.kind === params.kind);
  }
  if (params.value) {
    const v = params.value.toLowerCase();
    results = results.filter((n) =>
      String(n.metadata.value ?? "").toLowerCase().includes(v),
    );
  }
  if (params.file) {
    const f = params.file.toLowerCase();
    results = results.filter((n) => n.file.toLowerCase().includes(f));
  }
  return results.slice(0, params.limit ?? 100);
}
