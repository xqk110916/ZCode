import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { ServiceCollection, IZCodeTaskService } from "@zcode/services";
import {
  activeSessionReportSchema,
  formatZodError,
  localSendSchema,
  type ServerRemoteWorkspaceInfo,
  type ZCodeTaskMeta,
} from "@zcode/shared";

export interface LocalSessionSendOptions {
  /** 预热 taskTargets 时遍历的 workspace 列表；与 /api/server-info 返回同源。 */
  getWorkspaces: () => ServerRemoteWorkspaceInfo[];
}

interface ActiveSessionRecord {
  sessionId: string;
  reportedAt: Date;
}

/**
 * 本机会话消息投递（specs/server/local-session-send.md）。
 * 「当前活跃会话」是 server 进程内存易失态，最近一次上报为准；
 * 投递事实由 CLI admission 裁决，这里不缓存会话状态、不重试。
 */
export function registerLocalSessionSendRoutes(
  app: Hono,
  services: ServiceCollection,
  options: LocalSessionSendOptions,
): void {
  let active: ActiveSessionRecord | null = null;

  app.post("/api/active-session", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = activeSessionReportSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    // 客户端切回草稿态上报 null，清空记录后 local-send 回退 no_active_session。
    active = parsedBody.data.sessionId
      ? { sessionId: parsedBody.data.sessionId, reportedAt: new Date() }
      : null;
    return c.json({ ok: true });
  });

  app.get("/api/active-session", (c) =>
    c.json({
      sessionId: active?.sessionId ?? null,
      reportedAt: active?.reportedAt.toISOString() ?? null,
    }),
  );

  app.post("/api/local-send", async (c) => {
    const rawBody = await c.req.json();
    const parsedBody = localSendSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    const taskService = services.getOptional(IZCodeTaskService);
    if (!taskService) {
      return c.json({ error: "Task service is not available." }, 503);
    }

    const sessionId = body.sessionId ?? active?.sessionId;
    if (!sessionId) {
      return c.json(
        {
          error: "no_active_session",
          hint: "Open a session in the web client, or pass an explicit sessionId.",
        },
        404,
      );
    }

    try {
      // server 重启后内存 taskTargets 为空，先按配置的 workspace 预热，
      // 否则 sendPrompt 会以 ZCODE_SESSION_TARGET_NOT_FOUND 拒绝。
      let targetMeta: ZCodeTaskMeta | undefined;
      for (const workspace of options.getWorkspaces()) {
        const listParams = {
          workspacePath: workspace.path,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        };
        const metas = [
          ...(await taskService.listTasks(listParams)),
          ...(await taskService.listPinnedTasks(listParams)),
          ...(await taskService.listArchivedTasks(listParams)),
        ];
        targetMeta ??= metas.find((meta) => meta.taskId === sessionId);
      }
      if (!targetMeta) {
        return c.json({ error: "session_not_found", sessionId }, 404);
      }

      // CLI 网关的 sendText 只对已加载会话生效；冷会话（server 重启后或从未在
      // 客户端打开）会以 proto.sessionNotFound 拒绝。先按磁盘装载，与 cron 派发
      // 的 resume→send 顺序保持一致。
      await taskService.resumeTask({
        taskId: targetMeta.taskId,
        workspacePath: targetMeta.workspacePath,
        ...(targetMeta.workspaceIdentity
          ? { workspaceIdentity: targetMeta.workspaceIdentity }
          : {}),
      });

      await taskService.sendPrompt({
        taskId: sessionId,
        traceId: randomUUID(),
        content: body.content,
      });
      return c.json({ ok: true, sessionId });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err as Error & { code?: string }).code === "ZCODE_SESSION_TARGET_NOT_FOUND"
      ) {
        return c.json({ error: "session_not_found", sessionId }, 404);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
}

