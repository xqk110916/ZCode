import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingServiceWithMigrations } from "../src/setting/settingService.js";
import { setDataBaseDir } from "../src/paths.js";

async function writeLegacySettings(home: string, raw: Record<string, unknown>): Promise<void> {
  const dir = join(home, ".zcode", "v2");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "setting.json"), JSON.stringify(raw, null, 2), "utf-8");
}

async function readRawSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, ".zcode", "v2", "setting.json"), "utf-8")) as Record<
    string,
    unknown
  >;
}

test("项目会话三字段从 setting.json 拆到 custom-resources KV（从零开始）", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-session-routing-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  setDataBaseDir(home);
  try {
    // 预置旧 setting.json：含废弃项目字段与其他配置，验证零开始与配置不动。
    await writeLegacySettings(home, {
      startPlanRecommendationDismissed: true,
      recentProjects: ["/legacy-project"],
      lastWorkspaceSession: [{ kind: "local", workspacePath: "/legacy-ws" }],
      lastActiveTabIndex: 3,
    });

    const { service, close } = createSettingServiceWithMigrations();
    try {
      // get()：项目字段以 KV 为准（空 → 默认值），setting.json 旧值不透出。
      const initial = await service.get();
      assert.deepEqual(initial.recentProjects, []);
      assert.deepEqual(initial.lastWorkspaceSession, []);
      assert.equal(initial.lastActiveTabIndex, 0);
      assert.equal(initial.startPlanRecommendationDismissed, true);

      // update()：项目字段进 KV，其他字段进 setting.json。
      await service.update({
        recentProjects: ["/p1", "/p1", "/p2"],
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/p1" }],
        lastActiveTabIndex: 1,
        startPlanRecommendationDismissed: false,
      });

      const updated = await service.get();
      assert.deepEqual(updated.recentProjects, ["/p1", "/p2"]);
      assert.equal(updated.lastWorkspaceSession?.length, 1);
      assert.equal(updated.lastWorkspaceSession?.[0]?.kind, "local");
      assert.equal(updated.lastActiveTabIndex, 1);
      assert.equal(updated.startPlanRecommendationDismissed, false);

      // setting.json 不再持久化项目字段。
      const raw = await readRawSettings(home);
      assert.equal("recentProjects" in raw, false, "setting.json 不应再写 recentProjects");
      assert.equal("lastWorkspaceSession" in raw, false, "setting.json 不应再写 lastWorkspaceSession");
      assert.equal("lastActiveTabIndex" in raw, false, "setting.json 不应再写 lastActiveTabIndex");
      assert.equal(raw.startPlanRecommendationDismissed, false);
    } finally {
      close();
    }

    // KV 数据落在 custom-resources.sqlite，重启（新 service 实例）后仍可恢复。
    const secondInstance = createSettingServiceWithMigrations();
    try {
      const restored = await secondInstance.service.get();
      assert.deepEqual(restored.recentProjects, ["/p1", "/p2"]);
      assert.equal(restored.lastWorkspaceSession?.[0]?.workspacePath, "/p1");
      assert.equal(restored.lastActiveTabIndex, 1);
      assert.equal(restored.startPlanRecommendationDismissed, false, "其他字段仍来自 setting.json");
    } finally {
      secondInstance.close();
    }
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("setting.json 缺失时 get() 回退默认值且 update 正常路由", async () => {
  const home = await mkdtemp(join(tmpdir(), "project-session-fresh-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  setDataBaseDir(home);
  try {
    const { service, close } = createSettingServiceWithMigrations();
    try {
      const initial = await service.get();
      assert.deepEqual(initial.recentProjects, []);
      assert.deepEqual(initial.lastWorkspaceSession, []);

      await service.update({ recentProjects: ["/only-project"] });
      const after = await service.get();
      assert.deepEqual(after.recentProjects, ["/only-project"]);
    } finally {
      close();
    }

    // 只写项目字段时不应触碰 setting.json（本用例从未写过该文件）。
    await assert.rejects(() => readRawSettings(home), /ENOENT/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
});
