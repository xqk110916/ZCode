/** 浏览器安全的连接 id 生成（避免在 browser-safe 模块里引 node:crypto）。 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
