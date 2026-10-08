/* Claude Code 第三方网关的模型发现（从 paperclipService 拆出，控制文件行数）。
   Claude Code 走第三方代理时，Paperclip 的静态模型清单（官方 opus/sonnet 等）
   与实际可用模型不符；这里读本机 Claude Code 配置的网关端点，直接拉真实清单。
   凭证只用于向其配置的端点发起请求，不落日志、不持久化。 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaperclipAdapterModel } from "@zcode/shared";

/** 第三方模型发现缓存（60s TTL；存模型清单，不存凭证）。 */
let claudeModelDiscoveryCache: { models: PaperclipAdapterModel[]; expiresAt: number } | null =
  null;

/** 读取本机 Claude Code settings.json 的 env 段（失败返回空表）。 */
async function readClaudeCodeEnv(): Promise<Map<string, string>> {
  try {
    const raw = await readFile(join(homedir(), ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const env = parsed.env ?? {};
    const result = new Map<string, string>();
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && value.trim()) result.set(key, value.trim());
    }
    return result;
  } catch {
    return new Map();
  }
}

export async function discoverClaudeModels(): Promise<PaperclipAdapterModel[]> {
  const cached = claudeModelDiscoveryCache;
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const settings = await readClaudeCodeEnv();
  const baseUrl = settings.get("ANTHROPIC_BASE_URL");
  const token = settings.get("ANTHROPIC_AUTH_TOKEN") ?? settings.get("ANTHROPIC_API_KEY");
  if (!baseUrl || !token) return [];
  const authHeader = settings.has("ANTHROPIC_AUTH_TOKEN")
    ? { authorization: `Bearer ${token}` }
    : { "x-api-key": token };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01", ...authHeader },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { data?: unknown };
    const list = Array.isArray(payload.data) ? payload.data : [];
    const models = list.flatMap((item): PaperclipAdapterModel[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || !record.id.trim()) return [];
      return [
        {
          id: record.id,
          ...(typeof record.display_name === "string" && record.display_name.trim()
            ? { label: record.display_name }
            : {}),
        },
      ];
    });
    if (models.length === 0) return [];
    claudeModelDiscoveryCache = { models, expiresAt: Date.now() + 60_000 };
    return models;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
