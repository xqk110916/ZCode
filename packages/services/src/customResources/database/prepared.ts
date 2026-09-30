import type { DatabaseSync } from "node:sqlite";
import { areCustomResourcesMigrationsApplied } from "#src/customResources/database/migrations.js";
// 仅当前进程的启动交接凭据；不落盘、不代替 SQLite 账本，不影响不同路径的新库。
const migrated = new Set<string>();
const prepared = new Set<string>();
export function markCustomResourcesStorageMigrated(path: string): void {
  migrated.add(path);
}
export function markCustomResourcesStoragePrepared(path: string): void {
  migrated.add(path);
  prepared.add(path);
}
export function isCustomResourcesStorageMigrated(path: string, db: DatabaseSync): boolean {
  return migrated.has(path) && areCustomResourcesMigrationsApplied(db);
}
export function isCustomResourcesStoragePrepared(path: string, db: DatabaseSync): boolean {
  return prepared.has(path) && areCustomResourcesMigrationsApplied(db);
}
