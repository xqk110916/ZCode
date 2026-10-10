/** 知识本体 zod 校验（持久化读回时防损坏）。 */
import { z } from "zod";

export const dbBoardKnowledgeSchema = z.object({
  version: z.literal(1),
  builtAt: z.string().min(1),
  domains: z.record(z.string(), z.array(z.string())),
  tables: z.record(
    z.string(),
    z.object({
      table: z.string().min(1),
      domain: z.string().min(1),
      purpose: z.string().min(1),
      keyColumns: z.array(
        z.object({ name: z.string().min(1), meaning: z.string().min(1) }),
      ),
      relations: z.array(
        z.object({
          target: z.string().min(1),
          on: z.string().optional(),
          kind: z.string().optional(),
        }),
      ),
      notes: z.string().optional(),
      evidenceFiles: z.array(z.string()),
      source: z.enum(["distilled", "extracted", "db-comment"]),
    }),
  ),
  repoSnapshots: z.array(
    z.object({ path: z.string().min(1), head: z.string().min(1) }),
  ),
  stats: z.object({
    tableCount: z.number(),
    domainCount: z.number(),
    distilled: z.number(),
    extracted: z.number(),
    dbCommentOnly: z.number(),
    nacosServices: z.array(z.string()).optional(),
    datasourceMapping: z
      .array(z.object({ service: z.string(), url: z.string() }))
      .optional(),
    lastIncrementalAt: z.string().optional(),
  }),
});
