/**
 * BoardHub server 文件日志：console 输出同步 tee 到数据根下的日志文件。
 * 桌面打包形态没有终端可看（错误页指引的是该文件路径），落盘是唯一持久排查渠道；
 * 简单轮转（超 5MB 保留一份旧档），写失败静默——日志基础设施不能阻断服务。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;

export function boardhubServerLogFilePath(logDir: string): string {
  return join(logDir, "boardhub-server.log");
}

function formatArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function installBoardhubFileLogSink(logDir: string): void {
  mkdirSync(logDir, { recursive: true });
  const logFile = boardhubServerLogFilePath(logDir);
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // 文件不存在或轮转失败都不阻断启动。
  }
  const append = (level: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map(formatArg)
      .join(" ")
      .slice(0, MAX_LINE_CHARS)}`;
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // 磁盘满/权限问题时静默丢弃，不影响 console 输出。
    }
  };
  // debug 按 AGENTS.md 语义仅开发态打印，不落盘。
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      append(method, args);
    };
  }
}
