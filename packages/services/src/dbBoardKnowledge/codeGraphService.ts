/**
 * 代码知识图谱：服务层（构建编排 + 存储）。
 *
 * 复用 dbBoardKnowledge 的扫描并发模型（walkEvidenceFiles）与 git 增量机制。
 * 构建管线：扫描代码文件 → 提取结构/硬编码/特殊情况 → 合并图 → 持久化。
 * LLM 蒸馏按需触发（buildWithLLM），不阻塞结构图谱构建。
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { atomicWriteJson } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeGraphDoc, CodeGraphNode, CodeGraphEdge } from "./codeGraphTypes.js";
import {
  extractJavaStructure,
  extractEndpoints,
  extractFrontendApiCalls,
  extractHardcoded,
  buildGraphFromClass,
  buildGraphFromEndpoints,
  buildGraphFromApiCalls,
} from "./codeGraphExtract.js";

const execFileAsync = promisify(execFile);
const logger = createServiceLogger("codeGraph");

const WALK_CONCURRENCY = 8;
const MAX_FILES = 6_000;
const FILE_READ_LIMIT = 256 * 1024;
const SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", ".idea", ".vscode",
  "__pycache__", ".cache", "coverage", ".DS_Store",
]);
const CODE_EXTENSIONS = new Set([".java", ".js", ".ts", ".vue", ".jsx", ".tsx", ".xml", ".sql", ".yml", ".yaml"]);

// ============================================================================
// 存储
// ============================================================================

const CODE_GRAPH_FILE = "code-graph.json";

function graphFilePath(): string {
  return join(getAppConfigDir(), CODE_GRAPH_FILE);
}

async function loadGraph(): Promise<CodeGraphDoc | null> {
  try {
    const raw = await readFile(graphFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as CodeGraphDoc;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveGraph(doc: CodeGraphDoc): Promise<void> {
  await atomicWriteJson(graphFilePath(), doc as unknown as Record<string, unknown>);
}

// ============================================================================
// 扫描
// ============================================================================

interface ScannedFile {
  path: string;
  relPath: string;
  ext: string;
}

async function walkCodeFiles(
  root: string,
  onFile: (file: ScannedFile) => Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  let count = 0;
  const queue: string[] = [root];
  let active = 0;
  let pump: () => void;

  return new Promise((resolve, reject) => {
    const _fail = (error: unknown) => {
      queue.length = 0;
      reject(error);
    };
    pump = () => {
      if (signal?.aborted) {
        resolve(count);
        return;
      }
      while (queue.length > 0 && active < WALK_CONCURRENCY) {
        const dir = queue.shift()!;
        active += 1;
        readdir(dir, { withFileTypes: true })
          .then(async (entries) => {
            for (const entry of entries) {
              if (SKIP_DIRS.has(entry.name)) continue;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                queue.push(full);
              } else {
                const ext = extname(entry.name).toLowerCase();
                if (!CODE_EXTENSIONS.has(ext)) continue;
                if (count >= MAX_FILES) return;
                count += 1;
                const relPath = relative(root, full).replace(/\\/g, "/");
                await onFile({ path: full, relPath, ext });
              }
            }
          })
          .catch(() => {
            // best-effort：目录读取失败跳过
          })
          .finally(() => {
            active -= 1;
            if (queue.length === 0 && active === 0) {
              resolve(count);
            } else {
              pump();
            }
          });
      }
      if (queue.length === 0 && active === 0) {
        resolve(count);
      }
    };
    pump();
  });
}

// ============================================================================
// 构建管线
// ============================================================================

export interface CodeGraphBuildResult {
  doc: CodeGraphDoc;
  elapsedMs: number;
}

export async function buildCodeGraph(
  projectRoot: string,
  existingDoc?: CodeGraphDoc | null,
  signal?: AbortSignal,
): Promise<CodeGraphBuildResult> {
  const startedAt = Date.now();
  const nodes: CodeGraphNode[] = [];
  const edges: CodeGraphEdge[] = [];
  const nodeIds = new Set<string>();

  const addNodes = (newNodes: CodeGraphNode[]) => {
    for (const n of newNodes) {
      if (!nodeIds.has(n.id)) {
        nodeIds.add(n.id);
        nodes.push(n);
      }
    }
  };
  const addEdges = (newEdges: CodeGraphEdge[]) => {
    edges.push(...newEdges);
  };

  // 文件级节点（供硬编码 LOCATED_IN 边指向）
  const ensureFileNode = (filePath: string) => {
    const id = `file:${filePath}`;
    if (!nodeIds.has(id)) {
      nodeIds.add(id);
      nodes.push({
        id, type: "class", name: filePath.split("/").pop() ?? filePath,
        qualifiedName: filePath, file: filePath, metadata: {},
      });
    }
  };

  await walkCodeFiles(
    projectRoot,
    async (file) => {
      if (signal?.aborted) return;
      try {
        const content = await readFile(file.path, "utf-8").then((s) =>
          s.length > FILE_READ_LIMIT ? s.slice(0, FILE_READ_LIMIT) : s,
        );

        // Java 文件：结构 + 端点 + 硬编码 + 特殊情况
        if (file.ext === ".java") {
          const structInfo = extractJavaStructure(content, file.relPath);
          if (structInfo) {
            const graph = buildGraphFromClass(structInfo);
            addNodes(graph.nodes);
            addEdges(graph.edges);
          }
          if (file.relPath.includes("Controller")) {
            const endpoints = extractEndpoints(content, file.relPath);
            const epGraph = buildGraphFromEndpoints(endpoints);
            addNodes(epGraph.nodes);
            addEdges(epGraph.edges);
          }
        }

        // 前端文件：API 调用
        if ([".js", ".ts", ".vue", ".jsx", ".tsx"].includes(file.ext)) {
          const apiCalls = extractFrontendApiCalls(content, file.relPath);
          if (apiCalls.length > 0) {
            const pageName = file.relPath.split("/").slice(-2).join("/");
            const callGraph = buildGraphFromApiCalls(apiCalls, pageName);
            addNodes(callGraph.nodes);
            addEdges(callGraph.edges);
          }
        }

        // 硬编码检测（所有代码文件）
        if ([".java", ".js", ".ts", ".vue", ".jsx", ".tsx", ".xml"].includes(file.ext)) {
          ensureFileNode(file.relPath);
          const hardcoded = extractHardcoded(content, file.relPath);
          for (const { node, edge } of hardcoded) {
            addNodes([node]);
            addEdges([edge]);
          }
        }
      } catch {
        // 单文件提取失败跳过
      }
    },
    signal,
  );

  // 去重边
  const edgeKeys = new Set<string>();
  const dedupedEdges = edges.filter((e) => {
    const key = `${e.from}->${e.to}:${e.type}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });

  // repo 快照
  const repoSnapshots = await getRepoSnapshot(projectRoot);

  const doc: CodeGraphDoc = {
    version: 1,
    builtAt: new Date().toISOString(),
    nodes,
    edges: dedupedEdges,
    repoSnapshots,
    stats: {
      nodeCount: nodes.length,
      edgeCount: dedupedEdges.length,
      methodCount: nodes.filter((n) => n.type === "method").length,
      endpointCount: nodes.filter((n) => n.type === "endpoint").length,
      apiCallCount: nodes.filter((n) => n.type === "apiCall").length,
      hardcodedCount: nodes.filter((n) => n.type === "hardcoded").length,
      pageCount: nodes.filter((n) => n.type === "page").length,
    },
  };

  const elapsedMs = Date.now() - startedAt;
  logger.info(undefined, "代码图谱构建完成", {
    nodeCount: doc.stats.nodeCount,
    edgeCount: doc.stats.edgeCount,
    hardcodedCount: doc.stats.hardcodedCount,
    elapsedMs,
  });

  return { doc, elapsedMs };
}

async function getRepoSnapshot(root: string): Promise<Array<{ path: string; head: string }>> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    return [{ path: root, head: stdout.trim() }];
  } catch {
    return [];
  }
}

// ============================================================================
// 公开接口
// ============================================================================

export interface ICodeGraphService {
  getGraph(): Promise<CodeGraphDoc | null>;
  buildGraph(projectRoot: string): Promise<CodeGraphBuildResult>;
}

export function createCodeGraphService(): ICodeGraphService & { dispose(): void } {
  let cached: CodeGraphDoc | null = null;
  let loaded = false;

  async function ensureLoaded(): Promise<CodeGraphDoc | null> {
    if (!loaded) {
      cached = await loadGraph();
      loaded = true;
    }
    return cached;
  }

  return {
    async getGraph() {
      return ensureLoaded();
    },
    async buildGraph(projectRoot: string) {
      const existing = await ensureLoaded();
      const result = await buildCodeGraph(projectRoot, existing);
      cached = result.doc;
      await saveGraph(result.doc);
      return result;
    },
    dispose() {
      cached = null;
      loaded = false;
    },
  };
}
