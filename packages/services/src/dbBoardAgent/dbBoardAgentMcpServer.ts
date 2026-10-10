import { randomBytes } from "node:crypto";
import * as http from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { createDbBoardAgentTools, type DbBoardAgentToolContext } from "./dbBoardAgentTools.js";

const logger = createServiceLogger("dbBoardAgent");

const SERVER_NAME = "db_board";
const SERVER_VERSION = "1.0.0";
const SERVER_INSTRUCTIONS =
  "数据库看板助手工具集：只读查询、审计制写入（insert/update）、项目业务知识库与探索看板。" +
  "没有删除/回退/连接管理能力。写入前必须先向用户展示变更预览并获得确认。";

const REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export interface DbBoardAgentMcpEndpoint {
  url: string;
  token: string;
}

export interface DbBoardAgentMcpServerHost {
  start(): Promise<DbBoardAgentMcpEndpoint>;
  dispose(): void;
}

/**
 * 宿主进程内的 db_board MCP server：Streamable HTTP（无会话状态）监听 127.0.0.1 随机端口，
 * Bearer token 鉴权。工具处理器直接闭包引用既有 service 实例——连接池、知识库、看板 store、
 * 模型链路全系统只有宿主这一份所有者。
 */
export function createDbBoardAgentMcpServerHost(toolContext: DbBoardAgentToolContext): DbBoardAgentMcpServerHost {
  const tools = createDbBoardAgentTools(toolContext);
  // stateless：每个请求一个 fresh Server 实例（同一工具分发闭包），避免单实例多 transport 的状态串扰。
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    server.setRequestHandler("tools/call", async (request) => {
      const name = request.params.name;
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          content: [{ type: "text", text: `未知工具：${name}` }],
          isError: true,
        };
      }
      try {
        const text = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        // 服务层错误信息已按「不含凭据」口径构造；此处原样转述给模型。
        return {
          content: [
            {
              type: "text",
              text: `工具 ${name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
    return server;
  });

  let endpoint: DbBoardAgentMcpEndpoint | null = null;
  let startPromise: Promise<DbBoardAgentMcpEndpoint> | null = null;
  let httpServer: http.Server | null = null;

  const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > REQUEST_BODY_LIMIT_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const token = endpoint?.token;
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = `http://127.0.0.1:${req.socket.localPort ?? 0}${req.url ?? "/"}`;
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());
    let webRequest: Request;
    try {
      webRequest = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(req.method === "POST" ? { body: await readBody(req) } : {}),
        signal: abortController.signal,
      });
    } catch (error) {
      res.writeHead(400);
      res.end(error instanceof Error ? error.message : "bad request");
      return;
    }
    let webResponse: Response;
    try {
      webResponse = await handler.fetch(webRequest);
    } catch (error) {
      logger.warn(undefined, "db_board MCP 请求处理失败", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(500);
      res.end("internal error");
      return;
    }
    const headers: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(webResponse.status, headers);
    if (!webResponse.body) {
      res.end();
      return;
    }
    // SSE/流式响应按 chunk 转发，避免等待整流结束。
    await Readable.fromWeb(webResponse.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  };

  return {
    start() {
      startPromise ??= (async () => {
        const server = http.createServer((req, res) => {
          void handleRequest(req, res).catch((error) => {
            logger.warn(undefined, "db_board MCP HTTP 异常", {
              errorMessage: error instanceof Error ? error.message : String(error),
            });
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
        });
        const bound = await new Promise<{ server: typeof server; port: number }>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("db_board MCP 监听地址异常"));
              return;
            }
            resolve({ server, port: address.port });
          });
        });
        httpServer = bound.server;
        endpoint = { url: `http://127.0.0.1:${bound.port}/mcp`, token: randomBytes(24).toString("base64url") };
        logger.info(undefined, "db_board MCP server 已启动", { port: bound.port });
        return endpoint;
      })().catch((error) => {
        startPromise = null;
        throw error;
      });
      return startPromise;
    },
    dispose() {
      void handler.close().catch(() => undefined);
      httpServer?.close();
      httpServer = null;
      endpoint = null;
      startPromise = null;
    },
  };
}
