/**
 * BoardHub 模型运行时：OpenAI 兼容 API 直连，替换 ZCode 主应用的
 * zcodeAgentService.generateWorkspaceText 模型链路（见 specs/boardhub/standalone-app.md）。
 * 配置存 ISettingService（boardhubModelBaseUrl/Id），API key 存 ICredentialService；
 * 三项中 baseUrl 与 modelId 缺任一即视为未配置，dbBoard 侧报 model-unavailable。
 */
import type { AppSettings, ModelSelection } from "@zcode/shared";

/** API key 在 ICredentialService 的存储键。 */
export const BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY = "boardhub-model-api-key";
/** 合成 selection 的 providerId；仅用于 dbBoard 展示与内部传递，不参与网络请求。 */
export const BOARDHUB_MODEL_PROVIDER_ID = "boardhub-openai-compat";

/** generateText 未显式给预算时的默认输出上限，对齐 dbBoard 的 DASHBOARD_MAX_OUTPUT_TOKENS。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface BoardhubModelConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string | null;
}

export interface BoardhubModelRuntimeDeps {
  settingService: Pick<ISettingServiceLike, "get">;
  credentialService: Pick<ICredentialServiceLike, "load">;
  fetchImpl?: typeof fetch;
}

/** 仅引用用到的服务方法面，避免整包类型耦合。 */
interface ISettingServiceLike {
  get(): Promise<AppSettings>;
}

interface ICredentialServiceLike {
  load(key: string): Promise<string | null>;
}

/** dbBoardService 构造注入的 generateText 参数（与 DbBoardServiceOptions 对齐）。 */
export interface BoardhubGenerateTextParams {
  prompt: string;
  querySource: string;
  selection: ModelSelection;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export async function resolveBoardhubModelConfig(
  deps: BoardhubModelRuntimeDeps,
): Promise<BoardhubModelConfig | null> {
  const settings = await deps.settingService.get();
  const baseUrl = settings.boardhubModelBaseUrl?.trim();
  const modelId = settings.boardhubModelId?.trim();
  if (!baseUrl || !modelId) {
    return null;
  }
  const apiKey = await deps.credentialService.load(BOARDHUB_MODEL_API_KEY_CREDENTIAL_KEY);
  return { baseUrl, modelId, apiKey: apiKey?.trim() || null };
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export function createBoardhubModelRuntime(deps: BoardhubModelRuntimeDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function readCurrentModel(): Promise<ModelSelection | null> {
    const config = await resolveBoardhubModelConfig(deps);
    if (!config) {
      return null;
    }
    return { providerId: BOARDHUB_MODEL_PROVIDER_ID, modelId: config.modelId };
  }

  async function generateText(params: BoardhubGenerateTextParams): Promise<{ text: string }> {
    const config = await resolveBoardhubModelConfig(deps);
    if (!config) {
      throw new Error("BoardHub 模型未配置：请在设置页填写 base URL 与模型 id");
    }
    const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: [{ role: "user", content: params.prompt }],
          max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          stream: false,
        }),
        // timeoutMs 由 dbBoard 蒸馏/生成链路按需放宽（默认无超时，跟随 fetch 实现）。
        ...(params.timeoutMs ? { signal: AbortSignal.timeout(params.timeoutMs) } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`BoardHub 模型请求超时（${params.timeoutMs}ms）`);
      }
      throw new Error(`BoardHub 模型请求失败：${String(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `BoardHub 模型请求失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const payload = (await response.json()) as ChatCompletionsResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("BoardHub 模型返回空回复");
    }
    return { text: content };
  }

  return { readCurrentModel, generateText };
}
