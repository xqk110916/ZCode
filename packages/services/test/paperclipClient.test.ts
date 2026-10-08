import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PAPERCLIP_SERVER_URL,
  derivePaperclipIssueProgress,
  formatPaperclipElapsed,
  filterPaperclipForest,
  groupPaperclipIssues,
  isPaperclipInteractionPending,
  latestPaperclipRunForIssue,
  mergePaperclipRuns,
  normalizePaperclipComments,
  normalizePaperclipInteractions,
  normalizePaperclipServerUrl,
  paperclipAgentWorkload,
  paperclipBlockerIds,
  paperclipIssueNeedsHuman,
  paperclipIssueSchema,
  paperclipOpenDescendantCount,
  paperclipRunsForIssue,
  parsePaperclipRunList,
  readPaperclipLiveExtras,
  resolvePaperclipServerUrl,
  selectPaperclipCommentIssueIds,
  upsertPaperclipRun,
  type PaperclipIssue,
  type PaperclipRunSnapshot,
} from "@zcode/shared";
import { createServiceLogger } from "../src/logger/serviceLogger.js";
import {
  createPaperclipRestClient,
  PaperclipApiError,
} from "../src/paperclip/paperclipRestClient.js";
import {
  createPaperclipLiveEvents,
  type PaperclipWebSocketLike,
} from "../src/paperclip/paperclipLiveEvents.js";

const logger = createServiceLogger("paperclip-test");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("resolvePaperclipServerUrl：settings 覆盖 > env > 默认", () => {
  assert.equal(
    resolvePaperclipServerUrl({ settingsValue: "http://paperclip.local:3100/" }),
    "http://paperclip.local:3100",
  );
  assert.equal(
    resolvePaperclipServerUrl({
      settingsValue: "http://paperclip.local:3100/api/",
      env: { PAPERCLIP_SERVER_URL: "http://env-host:3100" },
    }),
    "http://paperclip.local:3100",
  );
  assert.equal(
    resolvePaperclipServerUrl({ env: { PAPERCLIP_SERVER_URL: "http://env-host:3100" } }),
    "http://env-host:3100",
  );
  assert.equal(resolvePaperclipServerUrl({}), DEFAULT_PAPERCLIP_SERVER_URL);
  // 非法输入（缺协议）回落默认而不是抛错。
  assert.equal(resolvePaperclipServerUrl({ settingsValue: "not-a-url" }), DEFAULT_PAPERCLIP_SERVER_URL);
});

test("normalizePaperclipServerUrl：去尾斜杠与 /api 后缀", () => {
  assert.equal(normalizePaperclipServerUrl("http://a:3100/"), "http://a:3100");
  assert.equal(normalizePaperclipServerUrl("http://a:3100/api"), "http://a:3100");
  assert.equal(normalizePaperclipServerUrl("http://a:3100/api/"), "http://a:3100");
  assert.equal(normalizePaperclipServerUrl("ftp://a"), null);
  assert.equal(normalizePaperclipServerUrl(""), null);
});

test("paperclipRestClient：列表信封兼容与宽容解析", async () => {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), init: init ?? {} });
    const path = new URL(String(url)).pathname;
    if (path === "/api/health") return jsonResponse({ ok: true, version: "1.2.3" });
    if (path === "/api/companies") return jsonResponse([{ id: "c1", name: "Acme" }]);
    if (path === "/api/companies/c1/agents")
      return jsonResponse({
        agents: [{ id: "a1", name: "CEO", adapterType: "claude_local", unknownField: 1 }],
      });
    if (path === "/api/companies/c1/issues")
      return jsonResponse([{ id: "i1", title: "Do it", status: "todo", priority: "high" }]);
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;

  const client = createPaperclipRestClient({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => "secret-token",
    fetchImpl,
    logger,
  });

  const health = await client.health();
  assert.equal(health.version, "1.2.3");

  const companies = await client.listCompanies();
  assert.equal(companies[0]?.id, "c1");

  const agents = await client.listAgents("c1");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.adapterType, "claude_local");

  const issues = await client.listIssues("c1", { status: ["todo", "in_progress"] });
  assert.equal(issues[0]?.title, "Do it");
  assert.equal(issues[0]?.status, "todo");

  // Authorization 头只在 token 存在时携带（issues 请求带 query，用 pathname 匹配）。
  const issueCall = calls.find((call) =>
    new URL(call.url).pathname.endsWith("/companies/c1/issues"),
  );
  assert.ok(issueCall, "issues request should have been issued");
  const issueHeaders = issueCall.init.headers as Record<string, string>;
  assert.equal(issueHeaders.authorization, "Bearer secret-token");
});

test("paperclipRestClient：HTTP 错误与网络错误归一化为 PaperclipApiError", async () => {
  const fetchHttpError = (async () =>
    jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
  const client = createPaperclipRestClient({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => null,
    fetchImpl: fetchHttpError,
    logger,
  });
  await assert.rejects(
    () => client.listCompanies(),
    (error: unknown) => {
      assert.ok(error instanceof PaperclipApiError);
      assert.equal(error.httpStatus, 401);
      assert.match(error.message, /unauthorized/);
      return true;
    },
  );

  const fetchNetworkError = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const networkClient = createPaperclipRestClient({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => null,
    fetchImpl: fetchNetworkError,
    logger,
  });
  await assert.rejects(
    () => networkClient.listCompanies(),
    (error: unknown) => {
      assert.ok(error instanceof PaperclipApiError);
      // 网络层错误统一 httpStatus=0，调用方据此与配置错误区分。
      assert.equal(error.httpStatus, 0);
      return true;
    },
  );
});

test("paperclip 进度：心跳与评论投影", () => {
  const live = parsePaperclipRunList({
    runs: [
      {
        id: "r-live",
        status: "running",
        agentId: "a1",
        startedAt: "2026-10-08T01:00:00.000Z",
        contextSnapshot: { issueId: "i1" },
      },
    ],
  });
  const recent = parsePaperclipRunList([
    {
      id: "r-live",
      status: "queued",
      issueId: "i1",
      startedAt: "2026-10-08T01:00:00.000Z",
      invocationSource: "assignment",
    },
    {
      id: "r-old",
      status: "failed",
      issueId: "i2",
      error: "adapter exited",
      startedAt: "2026-10-08T00:00:00.000Z",
      invocationSource: "assignment",
    },
  ]);
  const merged = mergePaperclipRuns(live, recent);
  const running = merged.find((run) => run.id === "r-live");
  assert.equal(running?.status, "running");
  assert.equal(running?.issueId, "i1");

  const comments = normalizePaperclipComments({
    comments: [
      { id: "c1", body: "先看现状", createdAt: "2026-10-08T01:01:00.000Z", authorAgentId: "a1" },
      { id: "c2", body: "改完校验", createdAt: "2026-10-08T01:02:00.000Z", authorAgentId: "a1" },
    ],
  });
  assert.equal(comments[0]?.id, "c2");
  assert.equal(comments[0]?.authorKind, "agent");

  const progress = derivePaperclipIssueProgress({
    status: "in_progress",
    run: running ?? null,
    comments,
  });
  assert.equal(progress.phase, "running");
  assert.equal(progress.stageIndex, 1);
  assert.equal(progress.latestComment?.body, "改完校验");

  const failed = derivePaperclipIssueProgress({
    status: "in_progress",
    run: merged.find((run) => run.id === "r-old") ?? null,
    comments: [],
  });
  assert.equal(failed.phase, "failed");
  assert.equal(failed.run?.error, "adapter exited");

  const queuedTodo = derivePaperclipIssueProgress({
    status: "todo",
    run: { ...live[0]!, status: "queued" },
    comments: [],
  });
  assert.equal(queuedTodo.phase, "queued");
  assert.equal(queuedTodo.stageIndex, 0);

  const retry = derivePaperclipIssueProgress({
    status: "in_progress",
    run: { ...live[0]!, status: "scheduled_retry", startedAt: null },
    comments: [],
  });
  assert.equal(retry.phase, "queued");
  assert.equal(retry.stageIndex, 1);

  const genericTrigger = parsePaperclipRunList([
    {
      id: "r-sys",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId: "i1" },
    },
  ]);
  assert.equal(genericTrigger[0]?.detail, null);
  assert.equal(genericTrigger[0]?.issueId, "i1");

  assert.deepEqual(
    selectPaperclipCommentIssueIds(
      [
        { id: "old", status: "done", updatedAt: "2026-10-08T02:00:00.000Z" },
        { id: "hot", status: "in_progress", updatedAt: "2026-10-08T01:00:00.000Z" },
      ],
      live,
    ),
    ["i1", "hot"],
  );

  const extras = readPaperclipLiveExtras({
    issueId: "i9",
    run: { id: "r9", status: "running", startedAt: "2026-10-08T01:03:00.000Z" },
  });
  assert.equal(extras.run?.issueId, "i9");
  assert.equal(extras.run?.status, "running");

  // issue 行本身有 title，不能被误认成心跳。
  assert.equal(
    readPaperclipLiveExtras({ id: "i1", title: "Do it", status: "todo" }).run,
    null,
  );

  assert.equal(formatPaperclipElapsed("2026-10-08T01:00:00.000Z", Date.parse("2026-10-08T01:02:05.000Z"), "zh-CN"), "2 分 5 秒");
  assert.equal(formatPaperclipElapsed("2026-10-08T01:00:00.000Z", Date.parse("2026-10-08T01:02:05.000Z"), "en-US"), "2m 5s");
});

test("paperclipRestClient：live runs 与评论", async () => {
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const { pathname } = new URL(String(url));
    if (pathname.endsWith("/live-runs")) {
      return jsonResponse([
        {
          id: "r1",
          status: "running",
          startedAt: "2026-10-08T01:00:00.000Z",
          contextSnapshot: { issueId: "i1" },
        },
      ]);
    }
    if (pathname.endsWith("/comments")) {
      return jsonResponse({ comments: [{ id: "c1", body: "doing it", createdAt: "2026-10-08T01:01:00.000Z" }] });
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  const client = createPaperclipRestClient({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => null,
    fetchImpl,
    logger,
  });
  const runs = await client.listLiveRuns("c1");
  assert.equal(runs[0]?.issueId, "i1");
  assert.equal(runs[0]?.status, "running");
  const comments = await client.listIssueComments("i1");
  assert.equal(comments[0]?.body, "doing it");
});

test("paperclipIssueSchema：未知状态/优先级宽容回落", () => {
  const parsed = paperclipIssueSchema.parse({
    id: "i2",
    title: "X",
    status: "some_new_status",
    priority: "cosmic",
  });
  assert.equal(parsed.status, "todo");
  assert.equal(parsed.priority, "medium");
});

test("paperclipRestClient：模型列表解析与 agent 更新/创建的 merge body", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (pathname === "/api/companies/c1/adapters/claude_local/models")
      return jsonResponse([{ id: "claude-opus-5", label: "Opus" }, { id: "claude-sonnet-5" }, { nope: 1 }]);
    if (pathname === "/api/agents/a1") return jsonResponse({ id: "a1", name: "Echo", role: "general" });
    if (pathname === "/api/companies/c1/agents")
      return jsonResponse({ id: "a2", name: "Dispatcher", role: "ceo" }, 201);
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;

  const client = createPaperclipRestClient({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => null,
    fetchImpl,
    logger,
  });

  // 模型列表：缺 id 的脏条目被丢弃，label 缺省回退 id。
  const models = await client.listAdapterModels("c1", "claude_local");
  assert.deepEqual(models, [
    { id: "claude-opus-5", label: "Opus" },
    { id: "claude-sonnet-5" },
  ]);

  // 更新 agent：只传要改的字段（merge 语义），不带 undefined 键。
  await client.updateAgent("a1", { model: "claude-sonnet-5" });
  const patchCall = calls.find((call) => call.method === "PATCH" && call.path === "/api/agents/a1");
  assert.deepEqual(patchCall?.body, { adapterConfig: { model: "claude-sonnet-5" } });

  await client.updateAgent("a1", { model: "claude-opus-5", effort: "high" });
  const patchCall2 = calls.filter((call) => call.method === "PATCH").at(-1);
  assert.deepEqual(patchCall2?.body, {
    adapterConfig: { model: "claude-opus-5", effort: "high" },
  });

  // 创建 agent：role 可选。
  const created = await client.createAgent("c1", { name: "Dispatcher", adapterType: "claude_local", role: "ceo" });
  assert.equal(created.role, "ceo");
  const createCall = calls.find((call) => call.method === "POST" && call.path === "/api/companies/c1/agents");
  assert.deepEqual(createCall?.body, { name: "Dispatcher", adapterType: "claude_local", role: "ceo" });
});

/** 可编程的假 WebSocket：手动触发 open/close/message。 */
class FakeSocket implements PaperclipWebSocketLike {
  readyState = 0;
  closeCode?: number;
  closeReason?: string;
  private listeners = new Map<string, Array<(...args: never[]) => void>>();
  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  emit(type: "open" | "close" | "error", arg?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (value: unknown) => void)(arg);
    }
  }
  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      (listener as (value: { data: unknown }) => void)({ data });
    }
  }
}

test("paperclipLiveEvents：认证拒绝不重试、普通断开退避重连", async () => {
  const sockets: FakeSocket[] = [];
  const stateLog: Array<{ willRetry: boolean }> = [];
  const events: unknown[] = [];
  const retryDelays: number[] = [];

  const live = createPaperclipLiveEvents({
    resolveBaseUrl: () => "http://paperclip.test:3100",
    resolveToken: () => null,
    callbacks: {
      onOpen: () => {},
      onClose: (input) => stateLog.push(input),
      onEvent: (event) => events.push(event),
    },
    logger,
    connectImpl: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduleRetry: (delayMs, fn) => {
      retryDelays.push(delayMs);
      fn();
      return () => {};
    },
  });

  live.start("c1");
  // connect 是异步解析 URL 后才 attach，等一个宏任务让假 socket 建立完成。
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 首个连接建立后收到 issue 事件：归一化透出。
  sockets[0]?.emit("open");
  sockets[0]?.emitMessage(
    JSON.stringify({
      id: 1,
      companyId: "c1",
      type: "issue.updated",
      createdAt: new Date().toISOString(),
      payload: { issue: { id: "i1", title: "T", status: "done", priority: "high" } },
    }),
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as { kind: string }).kind, "updated");

  // 非 issue 事件被过滤。
  sockets[0]?.emitMessage(JSON.stringify({ type: "agent.paused", payload: {} }));
  assert.equal(events.length, 1);

  // 普通断开：willRetry=true，退避延时会递增（mock 定时器同步触发，attach 异步完成）。
  sockets[0]?.emit("close", { code: 1006, reason: "abnormal" });
  assert.equal(stateLog.at(-1)?.willRetry, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sockets.length, 2);
  assert.deepEqual(retryDelays, [1000]);

  // 认证拒绝（1008）：不再重试，交由上层降级 polling。
  sockets[1]?.emit("open");
  sockets[1]?.emit("close", { code: 1008, reason: "unauthorized" });
  assert.equal(stateLog.at(-1)?.willRetry, false);
  assert.equal(sockets.length, 2);
  assert.equal(retryDelays.length, 1);

  live.stop();
});

function issue(partial: {
  id: string;
  title?: string;
  status?: PaperclipIssue["status"];
  parentId?: string | null;
  assigneeAgentId?: string | null;
  blockedByIssueIds?: string[];
  blockedBy?: PaperclipIssue["blockedBy"];
  blockerAttention?: PaperclipIssue["blockerAttention"];
}): PaperclipIssue {
  return paperclipIssueSchema.parse({
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? "todo",
    priority: "medium",
    parentId: partial.parentId ?? null,
    assigneeAgentId: partial.assigneeAgentId ?? null,
    ...(partial.blockedByIssueIds ? { blockedByIssueIds: partial.blockedByIssueIds } : {}),
    ...(partial.blockedBy ? { blockedBy: partial.blockedBy } : {}),
    ...(partial.blockerAttention ? { blockerAttention: partial.blockerAttention } : {}),
  });
}

function run(partial: Pick<PaperclipRunSnapshot, "id" | "status"> & Partial<PaperclipRunSnapshot>): PaperclipRunSnapshot {
  return {
    issueId: partial.issueId ?? null,
    agentId: partial.agentId ?? null,
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    createdAt: partial.createdAt ?? null,
    error: partial.error ?? null,
    detail: partial.detail ?? null,
    ...partial,
  };
}

test("任务树：子任务挂在父任务下，缺父节点和环不会丢任务", () => {
  const issues = [
    issue({ id: "root", status: "in_progress" }),
    issue({ id: "child", parentId: "root", status: "todo" }),
    issue({ id: "done-child", parentId: "root", status: "done" }),
    issue({ id: "grand", parentId: "child", status: "in_progress" }),
    issue({ id: "orphan", parentId: "missing", status: "todo" }),
    issue({ id: "a", parentId: "b", status: "todo" }),
    issue({ id: "b", parentId: "a", status: "in_progress" }),
  ];
  const forest = groupPaperclipIssues(issues);
  const ids = forest.map((node) => node.issue.id);
  assert.deepEqual(ids, ["root", "orphan", "a"]);
  const root = forest[0];
  assert.equal(root?.children[0]?.issue.id, "child");
  assert.equal(root?.children[0]?.children[0]?.issue.id, "grand");
  assert.equal(root?.children[1]?.issue.id, "done-child");
  assert.equal(forest.find((node) => node.issue.id === "a")?.children[0]?.issue.id, "b");
  assert.equal(paperclipOpenDescendantCount("root", issues), 2);
  assert.equal(paperclipOpenDescendantCount("child", issues), 1);
  assert.equal(paperclipOpenDescendantCount("a", issues), 1);
  const todos = filterPaperclipForest(forest, (entry) => entry.status === "todo");
  assert.deepEqual(
    todos.map((node) => node.issue.id),
    ["root", "orphan", "a"],
  );
  assert.equal(todos[0]?.children[0]?.issue.id, "child");
  assert.deepEqual(todos[0]?.children[0]?.children, []);
});

test("阻塞字段合并两条来源，并丢掉自己", () => {
  const parsed = issue({
    id: "i",
    status: "blocked",
    blockedByIssueIds: ["a", "i"],
    blockedBy: ["b", { id: "c", identifier: "ZCO-3" }, { id: "a" }],
  });
  assert.deepEqual(paperclipBlockerIds(parsed), ["a", "b", "c"]);
  const fromList = issue({
    id: "blocked",
    status: "blocked",
    blockerAttention: {
      directBlockerIssueId: "child",
      terminalBlocker: { id: "child", identifier: "ZCO-4", title: "Child open" },
      sampleBlockerIdentifier: "ZCO-4",
    },
  });
  assert.deepEqual(paperclipBlockerIds(fromList), ["child"]);
});

test("交互：待处理的提问排在前面，连接意图不算等人", () => {
  const list = normalizePaperclipInteractions({
    interactions: [
      { id: "a", status: "accepted", kind: "request_confirmation", payload: {} },
      {
        id: "b",
        status: "pending",
        kind: "ask_user_questions",
        payload: {
          questions: [
            { id: "q1", prompt: "Go?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] },
          ],
        },
      },
      { id: "c", status: "pending", kind: "connection_intent" },
    ],
  });
  assert.equal(list[0]?.id, "b");
  assert.equal(isPaperclipInteractionPending(list[0]!), true);
  assert.equal(list[0]?.questions[0]?.options[0]?.label, "Yes");
  assert.equal(isPaperclipInteractionPending(list.find((item) => item.id === "c")!), false);
  assert.equal(paperclipIssueNeedsHuman(list), true);
  assert.equal(paperclipIssueNeedsHuman([list[1]!]), false);
});

test("等人处理覆盖进行中，不覆盖已完成", () => {
  const waiting = derivePaperclipIssueProgress({
    status: "in_progress",
    run: null,
    comments: [],
    needsHuman: true,
  });
  assert.equal(waiting.phase, "needs_you");
  assert.equal(waiting.stageIndex, 1);
  const review = derivePaperclipIssueProgress({
    status: "in_review",
    run: null,
    comments: [],
    needsHuman: true,
  });
  assert.equal(review.phase, "needs_you");
  assert.equal(review.stageIndex, 2);
  const done = derivePaperclipIssueProgress({
    status: "done",
    run: null,
    comments: [],
    needsHuman: true,
  });
  assert.equal(done.phase, "done");
});

test("心跳历史保留失败记录，进度条仍用更新的重试", () => {
  const failed = run({
    id: "fail",
    issueId: "i1",
    status: "failed",
    startedAt: "2026-10-08T03:00:00.000Z",
    error: "boom",
    detail: "boom",
  });
  const retry = run({
    id: "retry",
    issueId: "i1",
    status: "scheduled_retry",
    startedAt: "2026-10-08T02:00:00.000Z",
  });
  const runs = upsertPaperclipRun(upsertPaperclipRun([], failed), retry);
  assert.deepEqual(
    paperclipRunsForIssue(runs, "i1").map((item) => item.id),
    ["fail", "retry"],
  );
  assert.equal(paperclipRunsForIssue(runs, "i1")[0]?.error, "boom");
  assert.equal(latestPaperclipRunForIssue(runs, "i1")?.id, "retry");
});

test("agent 负载：正在跑的任务优先，待办和受阻进队列", () => {
  const issues = [
    issue({ id: "run", assigneeAgentId: "agent", status: "todo" }),
    issue({ id: "prog", assigneeAgentId: "agent", status: "in_progress" }),
    issue({ id: "todo", assigneeAgentId: "agent", status: "todo" }),
    issue({ id: "blocked", assigneeAgentId: "agent", status: "blocked" }),
    issue({ id: "review", assigneeAgentId: "agent", status: "in_review" }),
    issue({ id: "done", assigneeAgentId: "agent", status: "done" }),
    issue({ id: "other", assigneeAgentId: "other", status: "todo" }),
  ];
  const running = paperclipAgentWorkload("agent", issues, {
    run: run({ id: "r", issueId: "run", status: "running" }),
  });
  assert.equal(running.current?.id, "run");
  assert.deepEqual(
    running.queue.map((item) => item.id),
    ["todo", "blocked"],
  );
  const reviewing = paperclipAgentWorkload(
    "agent",
    issues.filter((item) => item.id === "review"),
    {},
  );
  assert.equal(reviewing.current?.id, "review");
  assert.deepEqual(reviewing.queue, []);
});
