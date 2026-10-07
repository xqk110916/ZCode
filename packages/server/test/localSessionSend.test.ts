import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { IZCodeTaskService, ServiceCollection } from "@zcode/services";
import { registerLocalSessionSendRoutes } from "../src/localSessionSend.js";

interface PromptCall {
  taskId: string;
  content: string;
}

interface ResumeCall {
  taskId: string;
  workspacePath: string;
}

/**
 * 单测只覆盖 local-send 路由触达的方法子集；listTasks 返回带 workspace 的 meta，
 * 用于验证冷会话 resume 与 session_not_found 判定。
 */
function createTestServer(
  options: {
    indexedTasks?: Array<{ taskId: string; workspacePath: string; workspaceIdentity?: string }>;
    workspaces?: Array<{ path: string }>;
    registerTaskService?: boolean;
  } = {},
) {
  const prompts: PromptCall[] = [];
  const resumes: ResumeCall[] = [];
  const listedWorkspaces: string[] = [];
  let failWith: { code: string; message: string } | undefined;
  const app = new Hono();
  const services = new ServiceCollection();

  if (options.registerTaskService !== false) {
    const recordList = (workspacePath: string) => {
      listedWorkspaces.push(workspacePath);
      return (options.indexedTasks ?? []).map((meta) => ({
        title: `task ${meta.taskId}`,
        ...meta,
      }));
    };
    const fake = {
      listArchivedTasks: (params: { workspacePath: string }) => recordList(params.workspacePath),
      listPinnedTasks: (params: { workspacePath: string }) => recordList(params.workspacePath),
      listTasks: (params: { workspacePath: string }) => recordList(params.workspacePath),
      resumeTask: (params: ResumeCall) => {
        resumes.push({ taskId: params.taskId, workspacePath: params.workspacePath });
      },
      sendPrompt: (params: PromptCall) => {
        if (failWith) {
          throw Object.assign(new Error(failWith.message), { code: failWith.code });
        }
        prompts.push({ content: params.content, taskId: params.taskId });
      },
    };
    services.register(IZCodeTaskService, fake as unknown as IZCodeTaskService);
  }

  registerLocalSessionSendRoutes(app, services, {
    getWorkspaces: () => options.workspaces ?? [{ path: "/ws/default" }],
  });

  return {
    app,
    calls: {
      failWith: (value: { code: string; message: string }) => {
        failWith = value;
      },
      listedWorkspaces,
      prompts,
      resumes,
    },
    services,
  };
}

function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

test("GET /api/active-session 初始无活跃会话", async () => {
  const { app } = createTestServer();
  const response = await app.request("/api/active-session");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reportedAt: null, sessionId: null });
});

test("上报后可查询，上报 null 清空记录", async () => {
  const { app } = createTestServer();
  assert.equal((await postJson(app, "/api/active-session", { sessionId: "sess_a" })).status, 200);

  const query = await app.request("/api/active-session");
  const body = (await query.json()) as { sessionId: string | null; reportedAt: string | null };
  assert.equal(body.sessionId, "sess_a");
  assert.ok(body.reportedAt);

  await postJson(app, "/api/active-session", { sessionId: null });
  const cleared = await app.request("/api/active-session");
  assert.deepEqual(await cleared.json(), { reportedAt: null, sessionId: null });
});

test("无目标会话时 local-send 返回 404 no_active_session", async () => {
  const { app, calls } = createTestServer();
  const response = await postJson(app, "/api/local-send", { content: "hi" });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "no_active_session");
  assert.equal(calls.prompts.length, 0);
});

test("默认投递到最近上报的活跃会话，且先预热并 resume 冷会话", async () => {
  const { app, calls } = createTestServer({
    indexedTasks: [{ taskId: "sess_active", workspacePath: "/ws/a" }],
    workspaces: [{ path: "/ws/a" }, { path: "/ws/b" }],
  });
  await postJson(app, "/api/active-session", { sessionId: "sess_active" });

  const response = await postJson(app, "/api/local-send", { content: "hi" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sessionId: "sess_active" });
  assert.deepEqual(calls.prompts, [{ content: "hi", taskId: "sess_active" }]);
  assert.deepEqual(calls.resumes, [{ taskId: "sess_active", workspacePath: "/ws/a" }]);
  // 预热必须覆盖全部配置 workspace，否则 server 重启后首个显式投递会被拒。
  assert.deepEqual(calls.listedWorkspaces, [
    "/ws/a",
    "/ws/a",
    "/ws/a",
    "/ws/b",
    "/ws/b",
    "/ws/b",
  ]);
});

test("显式 sessionId 优先于上报值", async () => {
  const { app, calls } = createTestServer({
    indexedTasks: [
      { taskId: "sess_active", workspacePath: "/ws/default" },
      { taskId: "sess_explicit", workspacePath: "/ws/default" },
    ],
  });
  await postJson(app, "/api/active-session", { sessionId: "sess_active" });

  const response = await postJson(app, "/api/local-send", {
    content: "hi",
    sessionId: "sess_explicit",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.prompts, [{ content: "hi", taskId: "sess_explicit" }]);
});

test("任务索引中不存在该会话时返回 404 session_not_found 且不投递", async () => {
  const { app, calls } = createTestServer({
    indexedTasks: [{ taskId: "sess_other", workspacePath: "/ws/default" }],
  });
  const response = await postJson(app, "/api/local-send", {
    content: "hi",
    sessionId: "sess_gone",
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string; sessionId: string };
  assert.equal(body.error, "session_not_found");
  assert.equal(body.sessionId, "sess_gone");
  assert.equal(calls.resumes.length, 0);
  assert.equal(calls.prompts.length, 0);
});

test("非法 body 返回 400", async () => {
  const { app } = createTestServer();
  const empty = await postJson(app, "/api/local-send", { content: "" });
  assert.equal(empty.status, 400);

  const malformed = await postJson(app, "/api/local-send", { content: 42 });
  assert.equal(malformed.status, 400);

  const badReport = await postJson(app, "/api/active-session", { sessionId: "  " });
  assert.equal(badReport.status, 400);
});

test("task service 未注册时返回 503", async () => {
  const { app } = createTestServer({ registerTaskService: false });
  const response = await postJson(app, "/api/local-send", { content: "hi", sessionId: "sess_x" });
  assert.equal(response.status, 503);
});

test("目标会话未加载映射为 404 session_not_found", async () => {
  const { app, calls } = createTestServer({
    indexedTasks: [{ taskId: "sess_gone", workspacePath: "/ws/default" }],
  });
  calls.failWith({ code: "ZCODE_SESSION_TARGET_NOT_FOUND", message: "not loaded" });
  const response = await postJson(app, "/api/local-send", {
    content: "hi",
    sessionId: "sess_gone",
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string; sessionId: string };
  assert.equal(body.error, "session_not_found");
  assert.equal(body.sessionId, "sess_gone");
});

test("sendPrompt 其他失败透传为 500", async () => {
  const { app, calls } = createTestServer({
    indexedTasks: [{ taskId: "sess_x", workspacePath: "/ws/default" }],
  });
  calls.failWith({ code: "ZCODE_V4_COMMAND_REJECTED", message: "rejected by runtime" });
  const response = await postJson(app, "/api/local-send", { content: "hi", sessionId: "sess_x" });
  assert.equal(response.status, 500);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "rejected by runtime");
});
