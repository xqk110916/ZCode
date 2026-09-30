import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GuideEntryStore } from "../src/customResources/guideEntryStore.js";
import { createGuideEntryService } from "../src/customResources/guideEntryService.js";
import { setDataBaseDir } from "../src/paths.js";

test("GuideEntryStore 建表迁移幂等且 CRUD 落在独立库", async () => {
  const home = await mkdtemp(join(tmpdir(), "guide-entry-store-"));
  setDataBaseDir(home);
  const dbPath = join(home, "custom-resources.sqlite");
  const store = new GuideEntryStore({ startupDbPath: dbPath });
  try {
    // 重复 ensureReady 幂等（迁移账本只应用一次）。
    await store.ensureReady();
    await store.ensureReady();

    const created = await store.create({
      name: "电商平台",
      remark: "PC + H5 双端",
      frontendPaths: ["/repo/pc-web", "/repo/h5-web"],
      backendPaths: ["/repo/api"],
    });
    assert.match(created.id, /^guide-entry-/);
    assert.equal(created.name, "电商平台");
    assert.deepEqual(created.frontendPaths, ["/repo/pc-web", "/repo/h5-web"]);

    const second = await store.create({
      name: "后台系统",
      frontendPaths: ["/repo/admin"],
      backendPaths: ["/repo/admin-api"],
    });

    let entries = await store.list();
    assert.equal(entries.length, 2);
    // 按创建时间倒序：后创建的在前。
    assert.equal(entries[0]!.id, second.id);
    assert.equal(entries[1]!.remark, "PC + H5 双端");

    await store.delete(created.id);
    entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, second.id);

    // 幂等删除。
    await store.delete(created.id);
    assert.equal((await store.list()).length, 1);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("guideEntryService 校验名称必填与前后端各至少一个文件夹", async () => {
  const home = await mkdtemp(join(tmpdir(), "guide-entry-service-"));
  setDataBaseDir(home);
  const store = new GuideEntryStore({ startupDbPath: join(home, "custom-resources.sqlite") });
  const service = createGuideEntryService(store);
  try {
    await assert.rejects(
      () =>
        service.create({
          name: "   ",
          frontendPaths: ["/fe"],
          backendPaths: ["/be"],
        }),
      /名称不能为空/,
    );
    await assert.rejects(
      () =>
        service.create({
          name: "缺后端",
          frontendPaths: ["/fe"],
          backendPaths: [],
        }),
      /至少需要选择一个项目文件夹/,
    );

    // 名称 trim、路径去重保序。
    const entry = await service.create({
      name: "  引导记录  ",
      frontendPaths: ["/fe", "/fe", " "],
      backendPaths: ["/be"],
    });
    assert.equal(entry.name, "引导记录");
    assert.deepEqual(entry.frontendPaths, ["/fe"]);
    assert.deepEqual(entry.backendPaths, ["/be"]);
    assert.deepEqual(await service.list(), [entry]);
    await service.delete({ entryId: entry.id });
    assert.deepEqual(await service.list(), []);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});
