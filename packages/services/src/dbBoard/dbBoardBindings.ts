/**
 * 工作区绑定（准入控制，轻量版）：纯逻辑，无 IO。
 *
 * 语义（见 specs/services/db-board.md「工作区绑定」）：
 * - 绑定表非空 = 严格模式：只有绑定了连接的工作区可用看板/助手；
 * - 绑定表为空 = legacy 模式：所有工作区可用（v1/v2 迁移后行为与旧版一致）。
 * workspaceKey 统一为 workspaceIdentity?.trim() || workspacePath。
 */

export type DbBoardBindingsMap = Record<string, string>;

export type DbBoardBindingMode = "legacy" | "strict";

export interface DbBoardBindingsState {
  mode: DbBoardBindingMode;
  bindings: DbBoardBindingsMap;
}

/** 快照上的工作区准入结论（UI 按此渲染；blocked 时面板为空态引导）。 */
export type DbBoardWorkspaceAccess = "legacy" | "bound" | "blocked";

export interface DbBoardWorkspaceAccessResolution {
  access: DbBoardWorkspaceAccess;
  /** access=bound 时该工作区绑定的连接 id。 */
  boundConnectionId?: string;
  /** access=bound 且与当前激活不一致时应切到的连接 id（调用方负责执行切换）。 */
  shouldActivateConnectionId?: string;
}

export function normalizeWorkspaceKey(workspaceKey: string | undefined | null): string | null {
  const trimmed = workspaceKey?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 绑定键归一化：统一正斜杠为反斜杠并小写（Windows 路径大小写/斜杠形态可能因添加入口
 * 不同而不同，绑定与查找两侧都用本函数，避免同一路径两种写法互不匹配）。
 */
export function workspaceBindingKey(workspaceKey: string): string {
  return workspaceKey.trim().replace(/\//g, "\\").toLowerCase();
}

export function resolveWorkspaceAccess(params: {
  bindings: DbBoardBindingsMap;
  workspaceKey: string | null;
  activeConnectionId: string | null;
}): DbBoardWorkspaceAccessResolution {
  const { bindings, workspaceKey, activeConnectionId } = params;
  const isStrict = Object.keys(bindings).length > 0;
  if (!workspaceKey) {
    // 未携带 workspaceKey 的调用（服务端脚本/测试）不做门控，保持 legacy 行为。
    return { access: "legacy" };
  }
  if (!isStrict) {
    return { access: "legacy" };
  }
  // 存储键可能是历史原样形态（含脏键）：按归一化后的键匹配，读取侧兼容。
  const wantedKey = workspaceBindingKey(workspaceKey);
  const boundConnectionId = Object.entries(bindings).find(
    ([storedKey]) => workspaceBindingKey(storedKey) === wantedKey,
  )?.[1];
  if (!boundConnectionId) {
    return { access: "blocked" };
  }
  return {
    access: "bound",
    boundConnectionId,
    ...(activeConnectionId !== boundConnectionId ? { shouldActivateConnectionId: boundConnectionId } : {}),
  };
}

/** 解析配置文件中的 bindings 字段（宽容解析：非字符串值/悬空 id 交给调用方校验）。 */
export function parseBindings(raw: unknown): DbBoardBindingsMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: DbBoardBindingsMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeWorkspaceKey(key);
    if (normalizedKey && typeof value === "string" && value.trim()) {
      result[normalizedKey] = value.trim();
    }
  }
  return result;
}
