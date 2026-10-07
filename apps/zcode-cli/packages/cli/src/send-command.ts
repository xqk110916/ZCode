import { parseArgs } from "node:util";
import type { RunContext } from "@zcode/shared-types";

const USAGE = `Usage:
  zcode send <message> [--session <sessionId>] [--url <serverUrl>] [--token <authToken>] [--json]

Send a message to the current active session of a local zcode-server.
Defaults: --url http://localhost:3030 (env ZCODE_SERVER_URL), token from env ZCODE_SERVER_AUTH_TOKEN.
See docs/session-send-api.md for the HTTP integration.
`;

interface LocalSendResponse {
  ok?: boolean;
  sessionId?: string;
  error?: string;
  hint?: string;
}

export async function runSendCommand(ctx: RunContext): Promise<number> {
  let parsed: ReturnType<typeof parseSendArgs>;
  try {
    parsed = parseSendArgs(ctx.argv.slice(1));
  } catch (error) {
    return fail(ctx, error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) {
    ctx.stdout.write(USAGE);
    return 0;
  }

  const message = parsed.positionals[0];
  if (!message || parsed.positionals.length > 1) {
    return fail(ctx, "Exactly one <message> argument is required.");
  }

  const baseUrl =
    (parsed.values.url as string | undefined)?.trim() ||
    process.env["ZCODE_SERVER_URL"]?.trim() ||
    "http://localhost:3030";
  const token =
    (parsed.values.token as string | undefined)?.trim() ||
    process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() ||
    undefined;

  const url = new URL("/api/local-send", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (token) {
    // 服务端 token 语义与 /ws 一致：query 命中后回设 HttpOnly cookie。
    url.searchParams.set("token", token);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: message,
        ...((parsed.values.session as string | undefined)
          ? { sessionId: parsed.values.session as string }
          : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(
      `Cannot reach zcode-server at ${baseUrl}: ${reason}\n` +
        `Start it with \`pnpm dev:web\`, or pass --url / set ZCODE_SERVER_URL.\n`,
    );
    return 1;
  }

  const bodyText = await response.text();
  const body = parseLocalSendResponse(bodyText);
  if (!response.ok || !body?.ok) {
    const detail = body?.error ?? (bodyText.trim() || `HTTP ${response.status}`);
    ctx.stderr.write(`Error: ${detail}\n`);
    if (body?.error === "no_active_session" || body?.error === "session_not_found") {
      ctx.stderr.write(
        `${body.hint ?? "Open a session in the web client first, or pass --session <sessionId>."}\n`,
      );
    }
    return 1;
  }

  if (parsed.values.json) {
    ctx.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    ctx.stdout.write(`Delivered to session ${body.sessionId ?? "(unknown)"}\n`);
  }
  return 0;
}

function parseSendArgs(args: string[]) {
  return parseArgs({
    allowPositionals: true,
    args,
    options: {
      help: { short: "h", type: "boolean" },
      session: { type: "string" },
      token: { type: "string" },
      url: { type: "string" },
      json: { type: "boolean" },
    },
  });
}

function parseLocalSendResponse(text: string): LocalSendResponse | null {
  try {
    return JSON.parse(text) as LocalSendResponse;
  } catch {
    return null;
  }
}

function fail(ctx: RunContext, message: string): number {
  ctx.stderr.write(`${message}\n${USAGE}`);
  return 1;
}
