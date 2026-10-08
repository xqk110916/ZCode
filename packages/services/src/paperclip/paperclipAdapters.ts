/* 本机 CLI → Paperclip local adapter 的候选表与探测（从 paperclipService 拆出）。 */
import { execFileSync } from "node:child_process";
import type { PaperclipLocalAdapterCandidate } from "@zcode/shared";

/** 本机 CLI → Paperclip local adapter 候选表（「添加本地 agent」入口）。 */
export const LOCAL_ADAPTER_CLI_CANDIDATES: ReadonlyArray<{
  adapterType: string;
  cliName: string;
}> = [
  { adapterType: "claude_local", cliName: "claude" },
  { adapterType: "kimi_local", cliName: "kimi" },
  { adapterType: "grok_local", cliName: "grok" },
  { adapterType: "codex_local", cliName: "codex" },
  { adapterType: "gemini_local", cliName: "gemini" },
  { adapterType: "opencode_local", cliName: "opencode" },
];

/**
 * PATH 探测：which/where 找不到命令时以非零退出码抛错、不抛即存在；不能用返回值
 * 判断——stdio ignore 时它恒为 null（曾因此把所有已装 CLI 误报为「未检测到」）。
 */
export function detectLocalAgentAdapters(): PaperclipLocalAdapterCandidate[] {
  const command = process.platform === "win32" ? "where" : "which";
  return LOCAL_ADAPTER_CLI_CANDIDATES.map((candidate) => {
    let available = false;
    try {
      execFileSync(command, [candidate.cliName], { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
    return { ...candidate, available };
  });
}
