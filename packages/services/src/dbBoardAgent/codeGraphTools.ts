/**
 * 代码知识图谱的 MCP 工具面：影响分析 / 硬编码搜索 / 图谱查询。
 *
 * 这些工具复用 db-board agent 的 MCP server，不新增 server 实例。
 * 输出统一为 markdown 文本（模型直接消费）。
 */

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/server";
import type { ICodeGraphService } from "../dbBoardKnowledge/codeGraphService.js";
import { traceImpact, searchGraph, findHardcoded } from "../dbBoardKnowledge/codeGraphImpact.js";

export interface CodeGraphToolContext {
  codeGraphService: ICodeGraphService;
}

export interface CodeGraphTool {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const graphUnavailable = "代码图谱尚未构建。请引导用户在数据库看板中构建代码图谱。";

export function createCodeGraphTools(ctx: CodeGraphToolContext): CodeGraphTool[] {
  const { codeGraphService } = ctx;

  return [
    {
      name: "trace_impact",
      description:
        "分析一个方法/类/端点的影响范围：沿调用链 BFS，返回受影响的前端页面、API 端点、数据库表、方法及硬编码依赖。" +
        "输入为节点的名称（如方法名 getUserList 或类名 FlowCommonServiceImpl），自动模糊匹配。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "方法名/类名/端点 URL（模糊匹配）" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = z.object({ name: z.string().min(1).max(200) }).strict().parse(raw);
        const graph = await codeGraphService.getGraph();
        if (!graph) return graphUnavailable;

        // 模糊匹配：先精确，再包含
        let node = graph.nodes.find((n) => n.name === args.name);
        if (!node) {
          const q = args.name.toLowerCase();
          node = graph.nodes.find(
            (n) =>
              n.name.toLowerCase().includes(q) ||
              n.qualifiedName.toLowerCase().includes(q),
          );
        }
        if (!node) return `未找到匹配「${args.name}」的节点。`;

        const impact = traceImpact(graph, node.id);
        if (!impact) return `影响分析失败：${node.id}`;

        const lines = [
          `## 影响分析：${node.qualifiedName} (${node.type})`,
          `文件：${node.file}${node.line ? `:${node.line}` : ""}`,
          "",
        ];
        if (impact.affectedTables.length > 0) {
          lines.push(`### 数据库表（${impact.affectedTables.length}）`);
          for (const t of impact.affectedTables) lines.push(`- ${t.name}`);
          lines.push("");
        }
        if (impact.affectedEndpoints.length > 0) {
          lines.push(`### API 端点（${impact.affectedEndpoints.length}）`);
          for (const e of impact.affectedEndpoints) lines.push(`- ${e.url} (${e.file})`);
          lines.push("");
        }
        if (impact.affectedPages.length > 0) {
          lines.push(`### 前端页面（${impact.affectedPages.length}）`);
          for (const p of impact.affectedPages) lines.push(`- ${p.name} (${p.file})`);
          lines.push("");
        }
        if (impact.affectedMethods.length > 0) {
          lines.push(`### 关联方法（${impact.affectedMethods.length}）`);
          for (const m of impact.affectedMethods.slice(0, 30)) {
            lines.push(`- ${m.name} (${m.file})`);
          }
          if (impact.affectedMethods.length > 30) {
            lines.push(`- ...共 ${impact.affectedMethods.length} 个`);
          }
          lines.push("");
        }
        if (impact.hardcodedDependencies.length > 0) {
          lines.push(`### 硬编码依赖（${impact.hardcodedDependencies.length}）`);
          for (const h of impact.hardcodedDependencies) {
            lines.push(`- [${h.kind}] ${h.value} (${h.file}:${h.line ?? "?"})`);
          }
        }
        return lines.join("\n");
      },
    },

    {
      name: "find_hardcoded",
      description:
        "搜索项目中的硬编码项（写死的用户名/用户ID/部门ID/角色ID/字典ID/状态码/配置键）。" +
        "可按类型（userID/deptID/roleID/dictID/username/statusCode/configKey）或值搜索。",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "硬编码类型：userID / deptID / roleID / dictID / username / statusCode / configKey",
          },
          value: { type: "string", description: "按值模糊搜索" },
          file: { type: "string", description: "按文件路径过滤" },
          limit: { type: "number", description: "最大返回数（默认 50）" },
        },
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = z
          .object({
            kind: z.string().optional(),
            value: z.string().optional(),
            file: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional(),
          })
          .strict()
          .parse(raw);
        const graph = await codeGraphService.getGraph();
        if (!graph) return graphUnavailable;

        const results = findHardcoded(graph, args);
        if (results.length === 0) {
          return "没有匹配的硬编码项。";
        }

        const lines = [`找到 ${results.length} 个硬编码项：`];
        for (const item of results) {
          const meta = item.metadata;
          lines.push(
            `- [${meta.kind}] \`${meta.value}\` — ${item.file}:${item.line ?? "?"}`,
          );
        }
        return lines.join("\n");
      },
    },

    {
      name: "query_code_graph",
      description:
        "查询代码知识图谱：按名称/类型/文件搜索节点（方法/类/端点/前端调用/页面/表/域）。" +
        "例如：查所有 Controller 端点、搜包含「doc」的方法。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "按名称/限定名/元数据模糊搜索" },
          type: {
            type: "string",
            description: "节点类型：method / class / endpoint / apiCall / page / table / domain / hardcoded",
          },
          file: { type: "string", description: "按文件路径过滤" },
          limit: { type: "number", description: "最大返回数（默认 30）" },
        },
        additionalProperties: false,
      },
      handler: async (raw) => {
        const args = z
          .object({
            query: z.string().optional(),
            type: z.string().optional(),
            file: z.string().optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .strict()
          .parse(raw);
        const graph = await codeGraphService.getGraph();
        if (!graph) return graphUnavailable;

        const results = searchGraph(graph, { ...args, limit: args.limit ?? 30 });
        if (results.length === 0) return "没有匹配的节点。";

        const lines = [`找到 ${results.length} 个节点：`];
        for (const node of results) {
          const meta = node.metadata;
          let detail = "";
          if (node.type === "method" && meta.signature) {
            detail = ` — ${meta.signature}`;
          } else if (node.type === "endpoint" && meta.url) {
            detail = ` — ${meta.httpMethod} ${meta.url}`;
          } else if (node.type === "hardcoded") {
            detail = ` — [${meta.kind}] ${meta.value}`;
          }
          lines.push(`- [${node.type}] ${node.qualifiedName}${detail} (${node.file})`);
        }
        return lines.join("\n");
      },
    },
  ];
}
