import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { withInProcessMcp } from "../src/mcp/in-process";
import { createMcpToolsWithDiagnostics } from "../src/mcp/tools";
import { createMcpServerSettings } from "../src/mcp/settings";
import { mcpUrlProblem } from "../src/utils/host-policy";
import type { WebFetcher, WebHttpRequest } from "../src/tools/web-fetch";

const URL = "obsidian-plugin://tasks-query-mcp/agenticMcp";

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** Spec-shaped in-process server: initialize, tools/list, tools/call, -32601 otherwise. */
function fakeServer(seen: JsonRpc[] = []) {
  return {
    contractVersion: 1,
    async handle(message: JsonRpc) {
      seen.push(message);
      if (message.id === undefined) return null;
      if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25" } };
      if (message.method === "tools/list") {
        return { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "query_tasks", annotations: { readOnlyHint: true } }] } };
      }
      if (message.method === "tools/call") {
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `ran ${message.params?.arguments?.query}` }] } };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    },
  };
}

function app(exported: unknown, enabled = true): App {
  return {
    plugins: {
      enabledPlugins: new Set(enabled ? ["tasks-query-mcp"] : []),
      plugins: { "tasks-query-mcp": { agenticMcp: exported } },
    },
  } as unknown as App;
}

const network: WebFetcher = async () => ({ status: 200, headers: {}, text: "network" });
const post = (body: unknown, url = URL): WebHttpRequest => ({ url, method: "POST", headers: {}, body: JSON.stringify(body) });

describe("withInProcessMcp", () => {
  it("passes other URLs to the wrapped fetcher", async () => {
    const fetcher = withInProcessMcp(network, app(fakeServer()));
    await expect(fetcher({ url: "https://mcp.example.com/mcp", method: "POST", headers: {} })).resolves.toMatchObject({ text: "network" });
  });

  it("answers requests with JSON and notifications with 202", async () => {
    const fetcher = withInProcessMcp(network, app(fakeServer()));
    const reply = await fetcher(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toMatchObject({ id: 1, result: { tools: [{ name: "query_tasks" }] } });
    await expect(fetcher(post({ jsonrpc: "2.0", method: "notifications/initialized" }))).resolves.toEqual({ status: 202, headers: {}, text: "" });
  });

  it("hands the server a copy of the message", async () => {
    let received: unknown;
    const fetcher = withInProcessMcp(network, app({ contractVersion: 1, handle: async (message: unknown) => ((received = message), null) }));
    await fetcher(post({ jsonrpc: "2.0", method: "x", params: { a: { b: 1 } } }));
    expect(received).toEqual({ jsonrpc: "2.0", method: "x", params: { a: { b: 1 } } });
  });

  it("turns an exception in handle() into a JSON-RPC error for that request", async () => {
    const fetcher = withInProcessMcp(network, app({ contractVersion: 1, handle: async () => { throw new Error("boom"); } }));
    const reply = await fetcher(post({ jsonrpc: "2.0", id: 7, method: "tools/call" }));
    expect(JSON.parse(reply.text)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "in-process server threw: boom" } });
  });

  it("refuses non-POST requests", async () => {
    const fetcher = withInProcessMcp(network, app(fakeServer()));
    await expect(fetcher({ url: URL, method: "GET", headers: {} })).resolves.toMatchObject({ status: 405 });
  });

  it.each([
    ["a disabled plugin", app(fakeServer(), false), URL, /not installed or not enabled/],
    ["a missing export", app(undefined), URL, /has no "agenticMcp" in-process MCP server/],
    ["another contract version", app({ contractVersion: 2, handle: async () => null }), URL, /contract v1/],
    ["a server without handle()", app({ contractVersion: 1 }), URL, /contract v1/],
    ["a prototype export", app(fakeServer()), "obsidian-plugin://tasks-query-mcp/__proto__", /Invalid in-process MCP URL/],
    ["a malformed URL", app(fakeServer()), "obsidian-plugin://tasks-query-mcp/a/b", /Invalid in-process MCP URL/],
  ])("rejects %s", async (_label, appValue, url, message) => {
    await expect(withInProcessMcp(network, appValue)(post({ jsonrpc: "2.0", id: 1, method: "initialize" }, url))).rejects.toThrow(message);
  });

  it("serves discovery and tool calls through the regular MCP client", async () => {
    const seen: JsonRpc[] = [];
    const server = createMcpServerSettings({ id: "tasks", name: "Tasks", url: URL, enabled: true });
    const result = await createMcpToolsWithDiagnostics(
      { enabled: true, proxyUrl: "", noProxy: "", servers: [server] },
      withInProcessMcp(async () => {
        throw new Error("must not reach the network");
      }, app(fakeServer(seen))),
    );

    expect(result.diagnostics[0]).toMatchObject({ status: "ok", toolNames: ["query_tasks"] });
    expect(result.tools.map((tool) => tool.name)).toEqual(["mcp__tasks__query_tasks"]);
    const output = await result.tools[0]!.execute("call-1", { query: "not done" }, undefined);
    expect((output.content[0] as { text: string }).text).toContain("ran not done");
    expect(seen.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("reports an unavailable plugin as a discovery error without tools", async () => {
    const server = createMcpServerSettings({ id: "tasks", name: "Tasks", url: URL, enabled: true });
    const result = await createMcpToolsWithDiagnostics(
      { enabled: true, proxyUrl: "", noProxy: "", servers: [server] },
      withInProcessMcp(network, app(fakeServer(), false)),
    );
    expect(result.tools).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ status: "error", error: expect.stringMatching(/not installed or not enabled/) });
  });
});

describe("mcpUrlProblem for in-process URLs", () => {
  it("accepts obsidian-plugin://<plugin-id>/<export> and rejects other shapes", () => {
    expect(mcpUrlProblem(URL)).toBeNull();
    expect(mcpUrlProblem("obsidian-plugin://tasks-query-mcp/agenticMcp/extra")).toMatch(/obsidian-plugin:/);
    expect(mcpUrlProblem("obsidian-plugin://tasks-query-mcp")).toMatch(/obsidian-plugin:/);
    expect(mcpUrlProblem("ftp://example.com/mcp")).toMatch(/http/);
  });
});
