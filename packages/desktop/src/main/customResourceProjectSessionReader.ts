import { createRequire } from "node:module";
import { appSettingsSchema, type AppSettings } from "@zcode/shared";

// 与 services 侧一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

type StartupProjectSession = Pick<
  AppSettings,
  "lastWorkspaceSession" | "lastActiveTabIndex" | "recentProjects"
>;

const PROJECT_SESSION_KEYS = new Set([
  "lastWorkspaceSession",
  "recentProjects",
  "lastActiveTabIndex",
]);

/**
 * 主进程启动早期读取项目会话三字段（custom-resources.sqlite 的 resource_kv）。
 * 项目列表已从 setting.json 拆到独立数据源（specs/services/custom-resource-store.md），
 * 主进程不再经 setting.json 读取。任何异常（文件缺失 / 只读受限 / 模块不可用）
 * 回退 AppSettings 默认值，启动流程退化为"打开项目"起始页。
 */
export function readStartupProjectSessionState(dbPath: string): StartupProjectSession {
  const defaults = appSettingsSchema.parse({});
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 200");
      const rows = db
        .prepare("SELECT key, value_json FROM resource_kv")
        .all() as Array<{ key: string; value_json: string }>;
      const overlay: Record<string, unknown> = {};
      for (const row of rows) {
        if (!PROJECT_SESSION_KEYS.has(row.key)) {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(row.value_json);
          // 复用 AppSettings 字段校验，保证 KV 值与 schema 口径一致。
          const validated = appSettingsSchema.safeParse({ [row.key]: parsed });
          if (validated.success) {
            overlay[row.key] = (validated.data as Record<string, unknown>)[row.key];
          }
        } catch {
          // 单键损坏跳过，其余键仍可恢复。
        }
      }
      return { ...defaults, ...overlay };
    } finally {
      db.close();
    }
  } catch {
    return defaults;
  }
}
