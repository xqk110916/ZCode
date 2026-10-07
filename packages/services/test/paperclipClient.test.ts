import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PAPERCLIP_SERVER_URL,
  normalizePaperclipServerUrl,
  paperclipIssueSchema,
  resolvePaperclipServerUrl,
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
