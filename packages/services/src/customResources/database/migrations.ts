import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CUSTOM_RESOURCES_SCHEMA } from "#src/customResources/database/schema-v1.js";

// 与 tasksDatabase 相同的账本策略：冻结 checksum 输入，禁用 function.toString 哈希，
// 避免 Electron/SEA 打包改变函数文本导致已应用 migration 校验失败。
// 0002：设置「引导(新)」的项目引导记录（见 specs/ui/settings-guide-new.md）。
const GUIDE_ENTRIES_SCHEMA = `
      CREATE TABLE IF NOT EXISTS guide_entries (
        entry_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        remark TEXT NOT NULL DEFAULT '',
        frontend_paths_json TEXT NOT NULL,
        backend_paths_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_guide_entries_created
      ON guide_entries (created_at DESC);
    `;

const definitions = [
  {
    id: "0001_initial_custom_resources",
    checksumInput: [CUSTOM_RESOURCES_SCHEMA],
  },
  {
    id: "0002_guide_entries",
    checksumInput: [GUIDE_ENTRIES_SCHEMA],
  },
] as const;

export function runCustomResourcesMigrations(
  db: DatabaseSync,
  options: {
    transactionOpen?: boolean;
    migration?: DatabaseMigrationFacts;
    onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
  } = {},
): void {
  if (!options.transactionOpen) db.exec("BEGIN IMMEDIATE");
  const migrationFacts: DatabaseMigrationFacts = options.migration ?? {
    kind: "none",
    executedCount: 0,
    committedCount: 0,
  };
  let currentMigrationId: string | undefined;
  try {
    if (!options.migration) migrationFacts.kind = inspectCustomResourcesMigrationKind(db);
    db.exec(`CREATE TABLE IF NOT EXISTS custom_resources_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    const baseline = db
      .prepare("SELECT id FROM custom_resources_schema_migration ORDER BY id DESC LIMIT 1")
      .get();
    migrationFacts.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    for (const migration of definitions) {
      currentMigrationId = migration.id;
      const checksum = createHash("sha256")
        .update(JSON.stringify(migration.checksumInput))
        .digest("hex");
      const applied = db
        .prepare("SELECT checksum FROM custom_resources_schema_migration WHERE id=?")
        .get(migration.id);
      if (applied) {
        if (applied.checksum !== checksum)
          throw Object.assign(
            new Error(`Custom resources migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        continue;
      }
      if (migrationFacts.kind === "none") migrationFacts.kind = "initialize";
      options.onProgress?.("migrating", { ...migrationFacts });
      if (migration.id === "0001_initial_custom_resources") db.exec(CUSTOM_RESOURCES_SCHEMA);
      else db.exec(GUIDE_ENTRIES_SCHEMA);
      migrationFacts.executedCount++;
      db.prepare("INSERT INTO custom_resources_schema_migration VALUES(?,?,?)").run(
        migration.id,
        checksum,
        Date.now(),
      );
    }
    options.onProgress?.("committing", { ...migrationFacts });
    db.exec("COMMIT");
    migrationFacts.committedCount = migrationFacts.executedCount;
  } catch (error) {
    try {
      if (db.isTransaction) db.exec("ROLLBACK");
    } catch {
      /* 调用方关闭连接恢复。 */
    }
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

export function areCustomResourcesMigrationsApplied(db: DatabaseSync): boolean {
  if (
    !db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_resources_schema_migration'`,
      )
      .get()
  )
    return false;
  for (const migration of definitions) {
    const row = db
      .prepare("SELECT checksum FROM custom_resources_schema_migration WHERE id=?")
      .get(migration.id);
    if (!row) return false;
    const expected = createHash("sha256")
      .update(JSON.stringify(migration.checksumInput))
      .digest("hex");
    if (row.checksum !== expected)
      throw Object.assign(
        new Error(`Custom resources migration checksum mismatch: ${migration.id}`),
        { kind: "checksum_mismatch" },
      );
  }
  return true;
}

export function inspectCustomResourcesMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_resources_schema_migration'`,
    )
    .get();
  let pending = false;
  for (const migration of definitions) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM custom_resources_schema_migration WHERE id=?").get(
          migration.id,
        )
      : undefined;
    if (!row) pending = true;
    else if (
      row.checksum !==
      createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex")
    )
      throw Object.assign(
        new Error(`Custom resources migration checksum mismatch: ${migration.id}`),
        { kind: "checksum_mismatch" },
      );
  }
  if (!pending) return "none";
  return db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('custom_resources_schema_migration', 'sqlite_sequence') LIMIT 1`,
    )
    .get()
    ? "upgrade"
    : "initialize";
}
