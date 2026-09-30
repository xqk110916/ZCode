import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { TaskGroupStorePort } from "../src/customResources/customResourcesRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function makeTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "zcode-task-1",
    title: "Task 1",
    workspacePath: "/ws/project-a",
    createdAt: 1000,
    updatedAt: 1000,
    mode: "build",
    ...overrides,
  } as ZCodeTaskMeta;
}

function makeRecordingStore(calls: string[]): TaskGroupStorePort {
  return {
    async ensureCronGroupMembership(meta) {
      calls.push(`cron:${meta.taskId}`);
    },
    async ensureOffPeakGroupMembership(meta) {
      calls.push(`offpeak:${meta.taskId}`);
    },
    async initializeTaskAtTopIfAbsent(params) {
      calls.push(`top:${params.taskId}`);
      return true;
    },
    async deleteTaskGroupingReferences(workspaceKeyValue, taskId) {
      calls.push(`del:${taskId}`);
    },
    async cleanupTaskGroupingReferences(keys) {
      calls.push(`cleanup:${keys.length}`);
    },
  };
}

test("TaskIndexRepo 任务生命周期钩子经 port 写分组，旧库分组表不再被写入", async () => {
  const home = await mkdtemp(join(tmpdir(), "task-index-group-hooks-"));
  setDataBaseDir(home);
  const tasksDbPath = join(home, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(tasksDbPath);
  const calls: string[] = [];
  repo.bindTaskGroupStore(makeRecordingStore(calls));
  try {
    // 首次公开 + cron 标记：先落任务行，再触发 cron 归组与顶层排序钩子。
    const result = await repo.syncTaskMetaAtGroupedTop({
      meta: makeTaskMeta({ taskId: "task-cron", cronAutomationId: "auto-1" }),
    });
    assert.equal(result.meta.taskId, "task-cron");
    assert.equal(result.initializedGroupedOrder, true);
    assert.ok(calls.includes("cron:task-cron"), "cron 归组钩子应被调用");
    assert.ok(calls.includes("top:task-cron"), "顶层排序钩子应被调用");

    // 闲时标记：普通 sync 也会触发归组钩子。
    await repo.syncTaskMeta({
      meta: makeTaskMeta({ taskId: "task-off", offPeakTaskId: "op-1" }),
    });
    assert.ok(calls.includes("offpeak:task-off"), "闲时归组钩子应被调用");

    // 未绑定过 store 的钩子幂等（重复 sync 不重复归组：existing 已带标记）。
    const callsBefore = calls.length;
    await repo.syncTaskMeta({
      meta: makeTaskMeta({ taskId: "task-off", offPeakTaskId: "op-1", updatedAt: 2000 }),
    });
    assert.equal(
      calls.filter((call) => call.startsWith("offpeak:")).length,
      1,
      "已有标记的重复 sync 不应再次归组",
    );
    assert.ok(calls.length > callsBefore - 1);

    // 删除任务：tombstone 落库后触发分组引用清理钩子。
    await repo.updateTaskState({
      workspacePath: "/ws/project-a",
      taskId: "task-cron",
      patch: { deleted: true },
    });
    assert.ok(calls.includes("del:task-cron"), "删除任务应触发分组引用清理");

    // 手动公开入口（adapter createTask 流程）仍走 port。
    assert.equal(
      await repo.initializeGroupedTaskAtTop({
        workspacePath: "/ws/project-a",
        taskId: "task-off",
      }),
      true,
    );
  } finally {
    repo.close();
  }

  // 旧库分组表（schema 仍会创建）不再有业务写入。
  const db = new DatabaseSync(tasksDbPath, { readOnly: true });
  try {
    const memberCount = db.prepare("SELECT COUNT(1) AS n FROM task_group_members").get() as {
      n: number;
    };
    assert.equal(memberCount.n, 0, "tasks-index.sqlite 的分组成员表不应有写入");
    const orderCount = db.prepare("SELECT COUNT(1) AS n FROM task_group_view_node_orders").get() as {
      n: number;
    };
    assert.equal(orderCount.n, 0, "tasks-index.sqlite 的分组排序表不应有写入");
  } finally {
    db.close();
  }
  await rm(home, { recursive: true, force: true });
});
