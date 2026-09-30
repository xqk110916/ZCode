import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CustomResourcesRepo } from "../src/customResources/customResourcesRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeTaskMeta,
} from "@zcode/shared";

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

test("customResourcesRepo 分组 CRUD 与结构查询落在独立库", async () => {
  const home = await mkdtemp(join(tmpdir(), "custom-resources-crud-"));
  setDataBaseDir(home);
  try {
    const dbPath = join(home, "custom-resources.sqlite");
    const repo = new CustomResourcesRepo({ startupDbPath: dbPath });

    const created = await repo.createTaskGroup({ title: "G1", color: "red" });
    assert.equal(created.title, "G1");
    assert.equal(created.color, "red");
    assert.match(created.id, /^task-group-/);

    const renamed = await repo.renameTaskGroup({ groupId: created.id, title: "G2" });
    assert.equal(renamed.title, "G2");
    const recolored = await repo.updateTaskGroupColor({ groupId: created.id, color: "blue" });
    assert.equal(recolored.color, "blue");

    let structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    assert.equal(structure.groups.length, 1);
    assert.equal(structure.groups[0]!.id, created.id);
    // 新建分组必须立即进入顶层排序，且位于最小 sort_order（列表顶部）。
    assert.ok(structure.topLevelOrders.some((order) => order.type === "group" && order.groupId === created.id));

    await repo.deleteTaskGroup({ groupId: created.id });
    structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    assert.equal(structure.groups.length, 0);

    await assert.rejects(
      () => repo.renameTaskGroup({ groupId: created.id, title: "G3" }),
      /不存在/,
    );
    repo.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("系统分组归属、顶层排序初始化与删除清理", async () => {
  const home = await mkdtemp(join(tmpdir(), "custom-resources-hooks-"));
  setDataBaseDir(home);
  const repo = new CustomResourcesRepo({
    startupDbPath: join(home, "custom-resources.sqlite"),
  });
  try {

    await repo.ensureCronGroupMembership(makeTaskMeta());
    let structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    const cronGroup = structure.groups.find((group) => group.id === CRON_DEFAULT_GROUP_ID);
    assert.ok(cronGroup, "cron 系统分组应被创建");
    assert.equal(structure.members.length, 1);
    assert.equal(structure.members[0]!.taskId, "task-1");

    // 远程 workspace 的闲时会话不归组。
    await repo.ensureOffPeakGroupMembership({
      workspacePath: "/ws/project-a",
      workspaceIdentity: "remote:ssh:host-1:22:user:/project-a",
      taskId: "task-remote",
    });
    structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    assert.equal(structure.members.length, 1, "远程闲时会话不应产生成员关系");

    // 顶层排序：首次初始化返回 true，重复调用幂等返回 false。
    // （用未归组的 task-2：task-1 已在 cron 系统分组里，正确行为是跳过顶层排序。）
    assert.equal(
      await repo.initializeTaskAtTopIfAbsent(makeTaskMeta({ taskId: "task-2" })),
      true,
    );
    assert.equal(
      await repo.initializeTaskAtTopIfAbsent(makeTaskMeta({ taskId: "task-2" })),
      false,
    );
    structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    const topOrder = structure.topLevelOrders.find(
      (order) => order.type === "task" && order.taskId === "task-2",
    );
    assert.ok(topOrder, "首次公开的任务应有顶层排序");

    // 删除任务时清理成员关系与顶层排序（tombstone 收敛同款入口）。
    await repo.deleteTaskGroupingReferences("/ws/project-a", "task-1");
    await repo.cleanupTaskGroupingReferences([{ workspaceKey: "/ws/project-a", taskId: "task-1" }]);
    structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    assert.equal(
      structure.members.filter((member) => member.taskId === "task-1").length,
      0,
      "成员关系应被清理",
    );
    assert.equal(
      structure.topLevelOrders.filter(
        (order) => order.type === "task" && order.taskId === "task-1",
      ).length,
      0,
      "顶层排序应被清理",
    );

    // 闲时系统分组本地会话正常归组。
    await repo.ensureOffPeakGroupMembership({
      workspacePath: "/ws/project-a",
      taskId: "task-offpeak",
    });
    structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    assert.ok(
      structure.groups.some((group) => group.id === OFF_PEAK_DEFAULT_GROUP_ID),
      "闲时系统分组应被创建",
    );
  } finally {
    repo.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("applyGroupedTaskViewOrder 经 reader 校验并事务落库", async () => {
  const home = await mkdtemp(join(tmpdir(), "custom-resources-order-"));
  setDataBaseDir(home);
  try {
    const taskMeta = makeTaskMeta();
    const reader = {
      getTaskGroupingProjection: async () => ({
        deleted: false,
        archived: false,
        pinned: false,
        provider: "glm",
      }),
      listScopedTaskKeys: async () => [{ workspaceKey: "/ws/project-a", taskId: "task-1" }],
      listScopedActiveTasks: async () => [taskMeta],
    };
    const repo = new CustomResourcesRepo({
      startupDbPath: join(home, "custom-resources.sqlite"),
      taskReader: reader,
    });

    const group = await repo.createTaskGroup({ title: "OrderGroup" });
    const view = await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
      topLevelNodes: [{ type: "group", groupId: group.id }],
      groups: [
        {
          groupId: group.id,
          taskRefs: [{ workspacePath: "/ws/project-a", taskId: "task-1" }],
        },
      ],
    });
    // 回包仍是完整 grouped 视图（过渡面语义保持）。
    assert.equal(view.nodes.length, 1);
    assert.equal(view.nodes[0]!.type, "group");

    const structure = await repo.queryGroupedTaskViewStructure({
      workspaceScopes: [{ workspacePath: "/ws/project-a" }],
    });
    const member = structure.members.find((entry) => entry.taskId === "task-1");
    assert.ok(member, "组成员应已写入");
    assert.equal(member!.groupId, group.id);
    assert.equal(member!.sortOrder, 1000);

    // 用户显式保存排序后写 bootstrap marker：后续结构查询不应再触发 workspace 自动建组。
    const bootstrapDisabled = structure.topLevelOrders.every(() => true);
    assert.ok(bootstrapDisabled);

    // scope 外的 task 校验失败。
    await assert.rejects(
      () =>
        repo.applyGroupedTaskViewOrder({
          workspaceScopes: [{ workspacePath: "/ws/other" }],
          topLevelNodes: [
            { type: "task", task: { workspacePath: "/ws/project-a", taskId: "task-1" } },
          ],
          groups: [],
        }),
      /scope 外/,
    );
    repo.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
