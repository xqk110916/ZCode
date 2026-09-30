import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { runCustomResourcesMigrations } from "#src/customResources/database/migrations.js";
import {
  markCustomResourcesStorageMigrated,
  markCustomResourcesStoragePrepared,
} from "#src/customResources/database/prepared.js";

const LOCK_WAIT_MS = 60 * 60_000;

/**
 * 由 Host Worker 调用：准备 custom-resources.sqlite（WAL + 迁移账本）。
 * 与 prepareTasksIndexStorage 同一 worker 串行执行；本库无存量回填，准备完成后即标记 ready。
 */
export async function prepareCustomResourcesStorage(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  let failure: unknown;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const acquire = async (operation: string | (() => void)) => {
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Custom resources lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire("BEGIN IMMEDIATE");
    runCustomResourcesMigrations(db, { transactionOpen: true });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
  markCustomResourcesStorageMigrated(path);
  markCustomResourcesStoragePrepared(path);
}
