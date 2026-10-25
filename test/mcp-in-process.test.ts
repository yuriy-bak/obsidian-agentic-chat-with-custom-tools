import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import {
  createObsidianPluginResolver,
  inProcessMcpUrl,
  inProcessTargetProblem,
  McpInProcessClient,
  McpInProcessUnavailableError,
  type InProcessMcpServer,
  type JsonRpcMessage,
} from "../src/mcp/in-process";
import { createMcpServerSettings, type McpServerSettings } from "../src/mcp/settings";

const TARGET = { pluginId: "tasks-query-mcp", exportName: "agenticMcp" };

function server(overrides: Partial<McpServerSettings> = {}): McpServerSettings {
  return {
    ...createMcpServerSettings({ id: "tasks", name: "Tasks MCP", url: inProcessMcpUrl(TARGET), enabled: true }),
    source: "plugin",
    transport: "obsidian-plugin",
    inProcess: TARGET,
    ...overrides,
  };
}

const TOOL = {
  name: "query_tasks",
  description: "Run a Tasks query",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};

/** Minimal spec-shaped server; records every message it sees. */
function fakeServer(
  overrides: Partial<Record<string, (message: JsonRpcMessage) => unknown>> = {},
): InProcessMcpServer & { seen: JsonRpcMessage[] } {
  const seen: JsonRpcMessage[] = [];
  const handlers: Record<string, (message: JsonRpcMessage) => unknown> = {
    initialize: () => ({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake" } }),
    "tools/list": () => ({ tools: [TOOL] }),
    "tools/call": (message) => ({
      content: [{ type: "text", text: `ran ${JSON.stringify((message.params as { arguments: unknown }).arguments)}` }],
    }),
    ...overrides,
  };
  return {
    contractVersion: 1,
    seen,
    async handle(message) {
      seen.push(message);
      if (message.id === undefined) return null;
      const handler = handlers[message.method ?? ""];
      if (!handler) return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
      return { jsonrpc: "2.0", id: message.id, result: handler(message) };
    },
  };
}

function clientFor(target: InProcessMcpServer, requestTimeoutMs?: number): McpInProcessClient {
  return new McpInProcessClient({ server: server(), resolve: () => target, requestTimeoutMs });
}

describe("McpInProcessClient", () => {
  it("initializes, sends notifications/initialized, then lists tools", async () => {
    const fake = fakeServer();
    const tools = await clientFor(fake).listTools();

    expect(tools).toEqual([
      expect.objectContaining({ name: "query_tasks", description: "Run a Tasks query", annotations: { readOnlyHint: true } }),
    ]);
    expect(fake.seen.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(fake.seen[0]).toMatchObject({ jsonrpc: "2.0", id: 1, params: { protocolVersion: "2025-11-25" } });
    expect(fake.seen[1].id).toBeUndefined();
  });

  it("follows tools/list pagination", async () => {
    const fake = fakeServer({
      "tools/list": (message) =>
        (message.params as { cursor?: string } | undefined)?.cursor === "p2"
          ? { tools: [{ ...TOOL, name: "second" }] }
          : { tools: [TOOL], nextCursor: "p2" },
    });
    const tools = await clientFor(fake).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["query_tasks", "second"]);
  });

  it("calls a tool with its arguments", async () => {
    const fake = fakeServer();
    const result = await clientFor(fake).callTool("query_tasks", { query: "not done" });

    expect(result.content).toEqual([{ type: "text", text: 'ran {"query":"not done"}' }]);
    expect(fake.seen.at(-1)).toMatchObject({ method: "tools/call", params: { name: "query_tasks", arguments: { query: "not done" } } });
  });

  it("passes copies of messages so the server cannot keep references to client objects", async () => {
    const args = { query: "done", nested: { a: 1 } };
    let received: JsonRpcMessage | undefined;
    const fake = fakeServer({
      "tools/call": (message) => {
        received = message;
        return { content: [] };
      },
    });
    await clientFor(fake).callTool("query_tasks", args);

    const receivedArgs = (received?.params as { arguments: Record<string, unknown> }).arguments;
    expect(receivedArgs).toEqual(args);
    expect(receivedArgs).not.toBe(args);
    expect(receivedArgs.nested).not.toBe(args.nested);
  });

  it("surfaces JSON-RPC errors as errors", async () => {
    const fake = fakeServer();
    fake.handle = async (message) =>
      message.method === "tools/call"
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool: nope" } }
        : fakeServer().handle(message);

    await expect(clientFor(fake).callTool("nope", {})).rejects.toThrow(/Tasks MCP tools\/call failed: Unknown tool: nope/);
  });

  it("turns an exception inside handle() into an error", async () => {
    const fake = fakeServer({
      "tools/call": () => {
        throw new Error("boom");
      },
    });

    await expect(clientFor(fake).callTool("query_tasks", {})).rejects.toThrow(/in-process server threw: boom/);
  });

  it("turns a synchronous throw from handle() into an error", async () => {
    const target = {
      contractVersion: 1,
      handle: () => {
        throw new Error("sync boom");
      },
    } as unknown as InProcessMcpServer;

    await expect(clientFor(target).listTools()).rejects.toThrow(/initialize failed: in-process server threw: sync boom/);
  });

  it("times out a handle() call that never settles", async () => {
    const target: InProcessMcpServer = { contractVersion: 1, handle: () => new Promise(() => undefined) };

    await expect(clientFor(target, 5).listTools()).rejects.toThrow(/timed out after 5 ms while Tasks MCP initialize/);
  });

  it("aborts a pending call when the signal fires", async () => {
    const fake = fakeServer();
    const controller = new AbortController();
    fake.handle = async (message) => {
      if (message.method === "tools/call") {
        controller.abort();
        return new Promise(() => undefined);
      }
      return fakeServer().handle(message);
    };

    await expect(clientFor(fake).callTool("query_tasks", {}, controller.signal)).rejects.toThrow("Aborted.");
  });

  it("rejects a missing response, a mismatched id, and a response without result", async () => {
    const noReply: InProcessMcpServer = { contractVersion: 1, handle: async () => null };
    await expect(clientFor(noReply).listTools()).rejects.toThrow(/returned no response/);

    const wrongId: InProcessMcpServer = {
      contractVersion: 1,
      handle: async () => ({ jsonrpc: "2.0", id: 999, result: {} }),
    };
    await expect(clientFor(wrongId).listTools()).rejects.toThrow(/response for another request/);

    const noResult: InProcessMcpServer = { contractVersion: 1, handle: async (message) => ({ jsonrpc: "2.0", id: message.id }) };
    await expect(clientFor(noResult).listTools()).rejects.toThrow(/invalid JSON-RPC response/);
  });

  it("propagates resolver failures (missing plugin, bad contract)", async () => {
    const client = new McpInProcessClient({
      server: server(),
      resolve: () => {
        throw new McpInProcessUnavailableError('Obsidian plugin "tasks-query-mcp" is not installed or not enabled.');
      },
    });

    await expect(client.listTools()).rejects.toBeInstanceOf(McpInProcessUnavailableError);
  });

  it("refuses to wrap a server without an in-process target", () => {
    expect(
      () => new McpInProcessClient({ server: server({ inProcess: undefined }), resolve: () => fakeServer() }),
    ).toThrow(/not an in-process server/);
  });
});

describe("createObsidianPluginResolver", () => {
  function appWith(registry: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } | undefined): App {
    return { plugins: registry } as unknown as App;
  }

  it("returns the export of an enabled, loaded plugin", () => {
    const fake = fakeServer();
    const resolve = createObsidianPluginResolver(
      appWith({ enabledPlugins: new Set(["tasks-query-mcp"]), plugins: { "tasks-query-mcp": { agenticMcp: fake } } }),
    );

    expect(resolve(TARGET)).toBe(fake);
  });

  it.each([
    ["missing registry", undefined, /not installed or not enabled/],
    ["plugin not enabled", { enabledPlugins: new Set<string>(), plugins: {} }, /not installed or not enabled/],
    ["enabled but not loaded", { enabledPlugins: new Set(["tasks-query-mcp"]), plugins: {} }, /not loaded yet/],
    [
      "no export",
      { enabledPlugins: new Set(["tasks-query-mcp"]), plugins: { "tasks-query-mcp": {} } },
      /has no "agenticMcp" export/,
    ],
    [
      "wrong contract version",
      {
        enabledPlugins: new Set(["tasks-query-mcp"]),
        plugins: { "tasks-query-mcp": { agenticMcp: { contractVersion: 2, handle: async () => null } } },
      },
      /contract version 2; expected 1/,
    ],
    [
      "no handle()",
      { enabledPlugins: new Set(["tasks-query-mcp"]), plugins: { "tasks-query-mcp": { agenticMcp: { contractVersion: 1 } } } },
      /has no handle\(\) function/,
    ],
  ])("reports %s", (_label, registry, message) => {
    const resolve = createObsidianPluginResolver(appWith(registry));

    expect(() => resolve(TARGET)).toThrow(McpInProcessUnavailableError);
    expect(() => resolve(TARGET)).toThrow(message);
  });

  it("rejects unsafe target names before touching the registry", () => {
    const resolve = createObsidianPluginResolver(appWith({ enabledPlugins: new Set(["x"]), plugins: { x: {} } }));

    expect(() => resolve({ pluginId: "x", exportName: "__proto__" })).toThrow(/invalid export/);
    expect(() => resolve({ pluginId: "x", exportName: "a.b" })).toThrow(/invalid export/);
    expect(() => resolve({ pluginId: "../x", exportName: "agenticMcp" })).toThrow(/invalid pluginId/);
    expect(() => resolve({ pluginId: "agentic-chat", exportName: "agenticMcp" })).toThrow(/Agentic Chat itself/);
  });
});

describe("inProcessTargetProblem", () => {
  it("accepts typical Obsidian plugin ids and identifier exports", () => {
    expect(inProcessTargetProblem(TARGET)).toBe("");
    expect(inProcessTargetProblem({ pluginId: "obsidian-tasks-plugin", exportName: "$mcp_1" })).toBe("");
  });

  it("rejects missing or malformed names", () => {
    expect(inProcessTargetProblem({})).toMatch(/invalid pluginId/);
    expect(inProcessTargetProblem({ pluginId: "ok", exportName: "constructor" })).toMatch(/invalid export/);
    expect(inProcessTargetProblem({ pluginId: "has space", exportName: "x" })).toMatch(/invalid pluginId/);
  });
});
