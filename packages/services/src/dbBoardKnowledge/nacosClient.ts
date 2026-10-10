/**
 * Nacos 开放 API 轻客户端（只读：登录/服务清单/配置列表与读取）。
 * 全部容错：任何失败返回 null/空并由调用方降级（知识构建不因 Nacos 不可达而失败）。
 * 凭据只经请求传输，不落日志。
 */

export interface NacosClientConfig {
  serverAddr: string;
  namespace?: string;
  username?: string;
  password?: string;
}

export interface NacosConfigInfo {
  dataId: string;
  group: string;
}

function normalizeBase(serverAddr: string): string {
  const trimmed = serverAddr.trim().replace(/\/+$/u, "");
  return trimmed.startsWith("http") ? trimmed : `http://${trimmed}`;
}

async function nacosFetch(
  url: string,
  params: Record<string, string | undefined>,
  config: NacosClientConfig,
  accessToken?: string,
): Promise<unknown | null> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, value);
    }
  }
  if (config.namespace) {
    search.set("tenant", config.namespace);
    if (!("namespaceId" in params)) {
      search.set("namespaceId", config.namespace);
    }
  }
  if (accessToken) {
    search.set("accessToken", accessToken);
  }
  try {
    const response = await fetch(`${url}?${search.toString()}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json, text/plain, */*" },
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

async function login(config: NacosClientConfig): Promise<string | undefined> {
  if (!config.username || !config.password) {
    return undefined;
  }
  // Nacos v1 登录仅接受 POST 表单（实测 10.41.108.150:8848 GET 直接 405）。
  try {
    const body = new URLSearchParams({
      username: config.username,
      password: config.password,
    });
    const response = await fetch(
      `${normalizeBase(config.serverAddr)}/nacos/v1/auth/users/login`,
      {
        method: "POST",
        body,
        signal: AbortSignal.timeout(8_000),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      return undefined;
    }
    const parsed = (await response.json()) as { accessToken?: string } | null;
    return parsed?.accessToken ?? undefined;
  } catch {
    return undefined;
  }
}

/** 服务清单（分页拉全）；失败返回 null。 */
export async function nacosServiceList(config: NacosClientConfig): Promise<string[] | null> {
  const token = await login(config);
  const services: string[] = [];
  let pageNo = 1;
  for (;;) {
    const result = (await nacosFetch(
      `${normalizeBase(config.serverAddr)}/nacos/v1/ns/service/list`,
      { pageNo: String(pageNo), pageSize: "500" },
      config,
      token,
    )) as { count?: number; doms?: string[] } | null;
    if (!result || !Array.isArray(result.doms)) {
      return services.length > 0 ? services : null;
    }
    services.push(...result.doms);
    if (services.length >= (result.count ?? 0) || result.doms.length === 0 || pageNo > 20) {
      break;
    }
    pageNo += 1;
  }
  return services;
}

/** 配置清单（blur 搜索全量）；失败返回 null。 */
export async function nacosConfigList(config: NacosClientConfig): Promise<NacosConfigInfo[] | null> {
  const token = await login(config);
  const result = (await nacosFetch(
    `${normalizeBase(config.serverAddr)}/nacos/v1/cs/configs`,
    { search: "blur", dataId: "", group: "", pageNo: "1", pageSize: "200" },
    config,
    token,
  )) as { totalCount?: number; pageItems?: Array<{ dataId?: string; group?: string }> } | null;
  if (!result || !Array.isArray(result.pageItems)) {
    return null;
  }
  return result.pageItems
    .filter((item) => typeof item.dataId === "string")
    .map((item) => ({ dataId: item.dataId!, group: item.group ?? "DEFAULT_GROUP" }));
}

/** 读取单条配置内容（文本）；失败返回 null。 */
export async function nacosConfigGet(
  config: NacosClientConfig,
  dataId: string,
  group: string,
): Promise<string | null> {
  const token = await login(config);
  const result = await nacosFetch(
    `${normalizeBase(config.serverAddr)}/nacos/v1/cs/configs`,
    { search: "accurate", dataId, group },
    config,
    token,
  );
  return typeof result === "string" && result.trim() ? result : null;
}

/** 从配置内容中提取 jdbc url（服务↔数据源映射用）。 */
export function extractJdbcUrlsFromConfig(content: string): string[] {
  const urls = new Set<string>();
  for (const match of content.matchAll(/jdbc:[a-z0-9]+:\/\/[^\s"'#]+/giu)) {
    urls.add(match[0]);
  }
  return [...urls];
}

/** dataId → 服务名（去掉扩展名与 application 前缀的启发式）。 */
export function serviceNameFromDataId(dataId: string): string {
  return dataId.replace(/\.(ya?ml|properties|json)$/iu, "").replace(/^application[-.]?/iu, "");
}
