import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeWorkspaceKey,
  parseBindings,
  resolveWorkspaceAccess,
} from "../src/dbBoard/dbBoardBindings.js";

describe("resolveWorkspaceAccess", () => {
  it("绑定表为空 → legacy（全员可用，v2 迁移后行为不变）", () => {
    const r = resolveWorkspaceAccess({
      bindings: {},
      workspaceKey: "F:/proj-a",
      activeConnectionId: "default",
    });
    assert.equal(r.access, "legacy");
    assert.equal(r.boundConnectionId, undefined);
    assert.equal(r.shouldActivateConnectionId, undefined);
  });

  it("严格模式下已绑定：不一致时给出应激活连接，一致时不触发切换", () => {
    const bindings = { "F:/proj-a": "conn-a", "F:/proj-b": "conn-b" };
    assert.deepEqual(
      resolveWorkspaceAccess({ bindings, workspaceKey: "F:/proj-a", activeConnectionId: "conn-b" }),
      { access: "bound", boundConnectionId: "conn-a", shouldActivateConnectionId: "conn-a" },
    );
    assert.deepEqual(
      resolveWorkspaceAccess({ bindings, workspaceKey: "F:/proj-a", activeConnectionId: "conn-a" }),
      { access: "bound", boundConnectionId: "conn-a" },
    );
  });

  it("严格模式下未绑定 → blocked", () => {
    const r = resolveWorkspaceAccess({
      bindings: { "F:/proj-a": "conn-a" },
      workspaceKey: "F:/other",
      activeConnectionId: "conn-a",
    });
    assert.equal(r.access, "blocked");
  });

  it("路径形态容错：正反斜杠与大小写互认（不同入口添加工作区不互斥）", () => {
    const r = resolveWorkspaceAccess({
      bindings: { "f:\\mastercode\\hjt": "conn-a" },
      workspaceKey: "F:/masterCode/HJT",
      activeConnectionId: "conn-a",
    });
    assert.equal(r.access, "bound");
    assert.equal(r.boundConnectionId, "conn-a");
  });

  it("未携带 workspaceKey → 不做门控（服务端脚本/测试路径）", () => {
    const r = resolveWorkspaceAccess({
      bindings: { "F:/proj-a": "conn-a" },
      workspaceKey: null,
      activeConnectionId: "conn-a",
    });
    assert.equal(r.access, "legacy");
  });
});

describe("normalizeWorkspaceKey / parseBindings", () => {
  it("空白 key 归一为 null", () => {
    assert.equal(normalizeWorkspaceKey("   "), null);
    assert.equal(normalizeWorkspaceKey(undefined), null);
    assert.equal(normalizeWorkspaceKey(" F:/p "), "F:/p");
  });

  it("宽容解析：丢弃非字符串值与空白键，trim 键值", () => {
    const parsed = parseBindings({
      " F:/proj-a ": " conn-a ",
      "": "conn-x",
      "F:/bad": 123,
      "F:/nil": null,
      "F:/proj-b": "conn-b",
    });
    assert.deepEqual(parsed, { "F:/proj-a": "conn-a", "F:/proj-b": "conn-b" });
  });

  it("非对象输入返回空绑定表", () => {
    assert.deepEqual(parseBindings(undefined), {});
    assert.deepEqual(parseBindings([1, 2]), {});
    assert.deepEqual(parseBindings("x"), {});
  });
});
