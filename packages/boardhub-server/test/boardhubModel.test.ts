import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOARDHUB_MODEL_PROVIDER_ID,
  createBoardhubModelRuntime,
  resolveBoardhubModelConfig,
  type BoardhubModelRuntimeDeps,
} from "../src/boardhubModel.js";
import type { AppSettings } from "@zcode/shared";

function createDeps(overrides?: {
  settings?: Partial<AppSettings>;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}): BoardhubModelRuntimeDeps {
  const settings: AppSettings = {
    ...({} as AppSettings),
    ...overrides?.settings,
  };
  return {
    settingService: { get: async () => settings },
    credentialService: { load: async () => overrides?.apiKey ?? null },
    ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  };
}

describe("resolveBoardhubModelConfig", () => {
  it("baseUrl 与 modelId 任一缺失 → null（apiKey 允许为空，本地网关可不鉴权）", async () => {
    assert.equal(await resolveBoardhubModelConfig(createDeps()), null);
    assert.equal(
      await resolveBoardhubModelConfig(
        createDeps({ settings: { boardhubModelBaseUrl: "https://api.example.com/v1" } }),
      ),
      null,
    );
    assert.equal(
      await resolveBoardhubModelConfig(createDeps({ settings: { boardhubModelId: "glm-4.7" } })),
      null,
    );
  });

  it("配置齐全 → 返回配置（含 credential 里的 apiKey）", async () => {
    const config = await resolveBoardhubModelConfig(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1/",
          boardhubModelId: "glm-4.7",
        },
        apiKey: "sk-test",
      }),
    );
    assert.deepEqual(config, {
      baseUrl: "https://api.example.com/v1/",
      modelId: "glm-4.7",
      apiKey: "sk-test",
    });
  });
});

describe("createBoardhubModelRuntime", () => {
  it("readCurrentModel：未配置 → null；已配置 → 合成 selection", async () => {
    const unconfigured = createBoardhubModelRuntime(createDeps());
    assert.equal(await unconfigured.readCurrentModel(), null);

    const configured = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1",
          boardhubModelId: "glm-4.7",
        },
      }),
    );
    assert.deepEqual(await configured.readCurrentModel(), {
      providerId: BOARDHUB_MODEL_PROVIDER_ID,
      modelId: "glm-4.7",
    });
  });

  it("generateText：请求打向 {baseUrl}/chat/completions 并透传 model / max_tokens / prompt", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const runtime = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1//",
          boardhubModelId: "glm-4.7",
        },
        apiKey: "sk-test",
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          capturedUrl = String(input);
          capturedInit = init;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "hello boardhub" } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
      }),
    );
    const result = await runtime.generateText({
      prompt: "生成看板",
      querySource: "db-board.dashboard.generate",
      selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
      maxOutputTokens: 1024,
    });
    assert.equal(result.text, "hello boardhub");
    assert.equal(capturedUrl, "https://api.example.com/v1/chat/completions");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer sk-test");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, "glm-4.7");
    assert.equal(body.max_tokens, 1024);
    assert.deepEqual(body.messages, [{ role: "user", content: "生成看板" }]);
  });

  it("generateText：无 apiKey 时不带 authorization；maxOutputTokens 缺省 4096", async () => {
    let capturedInit: RequestInit | undefined;
    const runtime = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1",
          boardhubModelId: "glm-4.7",
        },
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
          });
        }) as typeof fetch,
      }),
    );
    await runtime.generateText({
      prompt: "p",
      querySource: "test",
      selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
    });
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["authorization"], undefined);
    assert.equal(JSON.parse(String(capturedInit?.body)).max_tokens, 4096);
  });

  it("generateText：timeoutMs 提供时携带 AbortSignal", async () => {
    let capturedInit: RequestInit | undefined;
    const runtime = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1",
          boardhubModelId: "glm-4.7",
        },
        fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
            status: 200,
          });
        }) as typeof fetch,
      }),
    );
    await runtime.generateText({
      prompt: "p",
      querySource: "test",
      selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
      timeoutMs: 120_000,
    });
    assert.ok(capturedInit?.signal instanceof AbortSignal);
  });

  it("generateText：未配置 → 抛错；HTTP 非 200 → 抛错带状态码；空回复 → 抛错", async () => {
    const unconfigured = createBoardhubModelRuntime(createDeps());
    await assert.rejects(
      unconfigured.generateText({
        prompt: "p",
        querySource: "test",
        selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
      }),
      /未配置/,
    );

    const failRuntime = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1",
          boardhubModelId: "glm-4.7",
        },
        fetchImpl: (async () => new Response("boom", { status: 502 })) as typeof fetch,
      }),
    );
    await assert.rejects(
      failRuntime.generateText({
        prompt: "p",
        querySource: "test",
        selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
      }),
      /HTTP 502/,
    );

    const emptyRuntime = createBoardhubModelRuntime(
      createDeps({
        settings: {
          boardhubModelBaseUrl: "https://api.example.com/v1",
          boardhubModelId: "glm-4.7",
        },
        fetchImpl: (async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
            status: 200,
          })) as typeof fetch,
      }),
    );
    await assert.rejects(
      emptyRuntime.generateText({
        prompt: "p",
        querySource: "test",
        selection: { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: "glm-4.7" },
      }),
      /空回复/,
    );
  });
});
