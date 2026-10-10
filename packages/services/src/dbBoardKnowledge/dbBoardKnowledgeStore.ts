/**
 * 知识库持久化：单文件 JSON（profile + 知识本体），atomicWriteJson 原子写。
 * 大文档（数百 KB）不走 customResources KV，避免 listAll 全量解析放大。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "#src/paths.js";
import { atomicWriteJson } from "#src/fs/atomicFileUtils.js";
import type { DbBoardKnowledge, DbBoardKnowledgeProfile } from "./dbBoardKnowledge.js";
import { dbBoardKnowledgeSchema } from "./dbBoardKnowledgeSchema.js";

export interface DbBoardKnowledgeDoc {
  profile?: DbBoardKnowledgeProfile;
  knowledge?: DbBoardKnowledge;
}

export class DbBoardKnowledgeStore {
  constructor(private readonly options: { filePath?: string } = {}) {}

  private get path(): string {
    return this.options.filePath ?? join(getAppConfigDir(), "db-board-knowledge.json");
  }

  async load(): Promise<DbBoardKnowledgeDoc> {
    try {
      const raw = await readFile(this.path, "utf-8");
      const parsed = JSON.parse(raw) as DbBoardKnowledgeDoc;
      const doc: DbBoardKnowledgeDoc = {};
      if (parsed.profile?.projectRoot) {
        // 密码永不落盘；读到也忽略。
        doc.profile = {
          projectRoot: parsed.profile.projectRoot,
          ...(parsed.profile.nacos
            ? {
                nacos: {
                  serverAddr: parsed.profile.nacos.serverAddr,
                  ...(parsed.profile.nacos.namespace
                    ? { namespace: parsed.profile.nacos.namespace }
                    : {}),
                  ...(parsed.profile.nacos.username
                    ? { username: parsed.profile.nacos.username }
                    : {}),
                },
              }
            : {}),
          ...(parsed.profile.dbBinding ? { dbBinding: parsed.profile.dbBinding } : {}),
        };
      }
      if (parsed.knowledge) {
        const validated = dbBoardKnowledgeSchema.safeParse(parsed.knowledge);
        if (validated.success) {
          doc.knowledge = validated.data;
        }
      }
      return doc;
    } catch {
      return {};
    }
  }

  async saveProfile(profile: DbBoardKnowledgeProfile): Promise<void> {
    const doc = await this.load();
    // 剥离密码字段后落盘（dbBinding 只含连接 id，无敏感信息）
    const safeProfile: DbBoardKnowledgeProfile = {
      projectRoot: profile.projectRoot,
      ...(profile.nacos
        ? {
            nacos: {
              serverAddr: profile.nacos.serverAddr,
              ...(profile.nacos.namespace ? { namespace: profile.nacos.namespace } : {}),
              ...(profile.nacos.username ? { username: profile.nacos.username } : {}),
            },
          }
        : {}),
      ...(profile.dbBinding ? { dbBinding: profile.dbBinding } : {}),
    };
    await atomicWriteJson(this.path, { ...doc, profile: safeProfile });
  }

  async saveKnowledge(knowledge: DbBoardKnowledge): Promise<void> {
    const doc = await this.load();
    await atomicWriteJson(this.path, { ...doc, knowledge });
  }

  async deleteKnowledge(): Promise<void> {
    const doc = await this.load();
    await atomicWriteJson(this.path, { profile: doc.profile });
  }

  async deleteAll(): Promise<void> {
    await atomicWriteJson(this.path, {});
  }
}
