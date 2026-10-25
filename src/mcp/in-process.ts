import type { App } from "obsidian";
import type { WebFetcher } from "../tools/web-fetch";

/**
 * In-process MCP: a server URL obsidian-plugin://<plugin-id>/<export> is answered by
 * the object another enabled Obsidian plugin exports, instead of the network.
 * Contract v1: { contractVersion: 1, handle(message): Promise<message | null> }.
 * Everything else (naming, approval gate, output wrapping) is the regular HTTP MCP path.
 */
const IN_PROCESS_URL = /^obsidian-plugin:\/\/([a-z0-9][a-z0-9._-]*)\/([A-Za-z_$][\w$]*)$/;

interface InProcessMcpServer {
  contractVersion: number;
  handle(message: unknown): Promise<unknown>;
}

export function withInProcessMcp(fetcher: WebFetcher, app: App): WebFetcher {
  return async (request, signal) => {
    if (!request.url.startsWith("obsidian-plugin:")) return fetcher(request, signal);
    const server = resolveServer(app, request.url);
    if (request.method !== "POST") return { status: 405, headers: {}, text: "" };
    const message = JSON.parse(request.body ?? "null") as { id?: unknown } | null;
    let reply: unknown;
    try {
      reply = await server.handle(JSON.parse(JSON.stringify(message)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reply = { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: `in-process server threw: ${detail}` } };
    }
    if (reply === null || reply === undefined) return { status: 202, headers: {}, text: "" };
    return { status: 200, headers: { "content-type": "application/json" }, text: JSON.stringify(reply) };
  };
}

function resolveServer(app: App, url: string): InProcessMcpServer {
  const match = IN_PROCESS_URL.exec(url);
  if (!match || match[2] === "__proto__" || match[2] === "constructor") throw new Error(`Invalid in-process MCP URL: ${url}`);
  const [, pluginId, exportName] = match;
  const plugins = (app as unknown as { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } }).plugins;
  if (!plugins?.enabledPlugins?.has(pluginId)) throw new Error(`Obsidian plugin "${pluginId}" is not installed or not enabled.`);
  const server = (plugins.plugins?.[pluginId] as Record<string, unknown> | undefined)?.[exportName] as
    | Partial<InProcessMcpServer>
    | undefined;
  if (server?.contractVersion !== 1 || typeof server.handle !== "function") {
    throw new Error(`Obsidian plugin "${pluginId}" has no "${exportName}" in-process MCP server (contract v1).`);
  }
  return server as InProcessMcpServer;
}
