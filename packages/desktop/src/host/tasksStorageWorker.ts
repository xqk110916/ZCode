import { parentPort, workerData } from "node:worker_threads";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  prepareCustomResourcesStorage,
  prepareTasksIndexStorage,
} from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

const data = z
  .object({ path: z.string().min(1) })
  .strict()
  .parse(workerData);
try {
  await prepareTasksIndexStorage(data.path, (phase, migration) =>
    parentPort?.postMessage({ type: "progress", phase, migration }),
  );
  // 分组/项目自定义数据源与 tasks-index 同目录（~/.zcode/v2/custom-resources.sqlite）；
  // 同一 worker 串行准备，失败走同一启动错误通道。
  await prepareCustomResourcesStorage(join(dirname(data.path), "custom-resources.sqlite"));
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
