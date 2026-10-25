import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { loadPlugins, pluginMcpServerId, resolveMcpServers } from "../src/plugins/loader";
import { AGENT_PLUGINS_MCP_SCHEMA_ID, AGENT_PLUGINS_SCHEMA_ID, validateAgenticChatExtension } from "../src/plugins/manifest";
import { createMcpToolsWithDiagnostics, mcpServerIdFromToolName, probeMcpServer } from "../src/mcp/tools";
import { McpInProcessUnavailableError, type InProcessMcpServer, type JsonRpcMessage } from "../src/mcp/in-process";
import { createMcpServerState, type McpServerSettings } from "../src/mcp/settings";
import type { WebFetcher } from "../src/tools/web-fetch";
import { FakeApp } from "./helpers/fake-vault";

const TASKS_EXTENSION = {
  "agentic-chat": {
    inProcessMcpServers: {
      tasks: { type: "obsidian-plugin", pluginId: "tasks-query-mcp", export: "agenticMcp" },
    },
  },
};

function pluginJson(name: string, extensions?: unknown): string {
  return JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_ID, name, version: "0.1.0", ...(extensions ? { extensions } : {}) });
}

async function appWithPlugin(name: string, files: Record<string, string>): Promise<App> {
  const app = new FakeApp();
  await app.vault.createFolder(".agentic-plugins");
  await app.vault.createFolder(`.agentic-plugins/${name}`);
  for (const [path, content] of Object.entries(files)) await app.vault.create(`.agentic-plugins/${name}/${path}`, content);
  return app as unknown as App;
}

const noNetwork: WebFetcher = async () => {
  throw new Error("in-process discovery must not touch the network");
};

function fakeServer(tools: Array<Record<string, unknown>>): InProcessMcpServer & { seen: JsonRpcMessage[] } {
  const seen: JsonRpcMessage[] = [];
  return {
    contractVersion: 1,
    seen,
    async handle(message) {
      seen.push(message);
      if (message.id === undefined) return null;
      if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25" } };
      if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, result: { tools } };
      if (message.method === "tools/call") {
        return { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "3 tasks" }] } };
      }
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
    },
  };
}

async function tasksServer(overrides: Partial<McpServerSettings> = {}): Promise<McpServerSettings> {
  const app = await appWithPlugin("tasks-query", { "plugin.json": pluginJson("tasks-query", TASKS_EXTENSION) });
  const [plugin] = await loadPlugins(app);
  const server = plugin?.mcpServers[0];
  if (!server) throw new Error("no server derived");
  return { ...server, enabled: true, ...overrides };
}

describe("validateAgenticChatExtension", () => {
  it("reads in-process MCP servers", () => {
    expect(validateAgenticChatExtension(TASKS_EXTENSION)).toEqual({
      servers: [{ key: "tasks", pluginId: "tasks-query-mcp", exportName: "agenticMcp" }],
      reports: [],
    });
  });

  it("treats a missing extension or missing inProcessMcpServers as valid absence", () => {
    expect(validateAgenticChatExtension(undefined)).toEqual({ servers: [], reports: [] });
    expect(validateAgenticChatExtension({ other: {} })).toEqual({ servers: [], reports: [] });
    expect(validateAgenticChatExtension({ "agentic-chat": {} })).toEqual({ servers: [], reports: [] });
  });

  it("skips and reports invalid entries without dropping valid ones", () => {
    const result = validateAgenticChatExtension({
      "agentic-chat": {
        inProcessMcpServers: {
          ok: { type: "obsidian-plugin", pluginId: "a-plugin", export: "mcp", note: "x" },
          wrongType: { type: "streamable-http", url: "https://x" },
          badExport: { type: "obsidian-plugin", pluginId: "a-plugin", export: "__proto__" },
          self: { type: "obsidian-plugin", pluginId: "agentic-chat", export: "mcp" },
          notObject: "nope",
        },
      },
    });

    expect(result.servers).toEqual([{ key: "ok", pluginId: "a-plugin", exportName: "mcp" }]);
    expect(result.reports.map((report) => `${report.severity}: ${report.message}`)).toEqual([
      'warning: in-process MCP server "ok" has unknown field note; ignored.',
      'error: in-process MCP server "wrongType" has unsupported type "streamable-http"; skipped.',
      'error: in-process MCP server "badExport" has invalid export "__proto__"; skipped.',
      'error: in-process MCP server "self" has pluginId "agentic-chat" refers to Agentic Chat itself; skipped.',
      'error: in-process MCP server "notObject" is not an object; skipped.',
    ]);
  });

  it("reports a non-object extension or server map", () => {
    expect(validateAgenticChatExtension({ "agentic-chat": [] }).reports[0]?.message).toMatch(/is not an object/);
    expect(validateAgenticChatExtension({ "agentic-chat": { inProcessMcpServers: 1 } }).reports[0]?.message).toMatch(
      /inProcessMcpServers is not an object/,
    );
  });
});

describe("loadPlugins with in-process MCP servers", () => {
  it("derives a disabled, ask-by-default plugin server with a stable id", async () => {
    const server = await tasksServer({ enabled: false });

    expect(server).toMatchObject({
      id: pluginMcpServerId("tasks-query", "tasks"),
      name: "tasks-query: tasks",
      url: "obsidian-plugin://tasks-query-mcp/agenticMcp",
      enabled: false,
      approval: "ask",
      authType: "none",
      source: "plugin",
      pluginRoot: ".agentic-plugins/tasks-query",
      transport: "obsidian-plugin",
      inProcess: { pluginId: "tasks-query-mcp", exportName: "agenticMcp" },
    });
  });

  it("keeps the package ok and mcp.json-free", async () => {
    const app = await appWithPlugin("tasks-query", { "plugin.json": pluginJson("tasks-query", TASKS_EXTENSION) });
    const [plugin] = await loadPlugins(app);

    expect(plugin?.auditStatus).toBe("ok");
    expect(plugin?.mcpValidation).toBeNull();
    expect(plugin?.reports).toEqual([]);
  });

  it("combines mcp.json servers with in-process ones and skips a key collision", async () => {
    const app = await appWithPlugin("mixed", {
      "plugin.json": pluginJson("mixed", {
        "agentic-chat": {
          inProcessMcpServers: {
            docs: { type: "obsidian-plugin", pluginId: "p", export: "mcp" },
            local: { type: "obsidian-plugin", pluginId: "p", export: "mcp" },
          },
        },
      }),
      "mcp.json": JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA_ID,
        mcpServers: { docs: { type: "streamable-http", url: "https://mcp.example.com/mcp" } },
      }),
    });
    const [plugin] = await loadPlugins(app);

    expect(plugin?.mcpServers.map((server) => [server.name, server.transport ?? "streamable-http"])).toEqual([
      ["mixed: docs", "streamable-http"],
      ["mixed: local", "obsidian-plugin"],
    ]);
    expect(plugin?.auditStatus).toBe("partial");
    expect(plugin?.reports.map((report) => report.message)).toContain(
      'in-process MCP server "docs" uses a key already declared in mcp.json; skipped.',
    );
  });

  it("applies client-owned state from plugins.mcpState like any plugin server", async () => {
    const server = await tasksServer({ enabled: false });
    const state = createMcpServerState(server.id, { enabled: true, approval: "allow", disabledTools: ["dangerous_*"] });
    const [resolved] = resolveMcpServers({ mcp: { servers: [] }, plugins: { mcpState: { [server.id]: state } } }, [server]);

    expect(resolved).toMatchObject({ enabled: true, approval: "allow", disabledTools: ["dangerous_*"], transport: "obsidian-plugin" });
  });
});

describe("in-process MCP discovery", () => {
  const settings = (server: McpServerSettings) => ({ enabled: true, proxyUrl: "", noProxy: "", servers: [server] });

  it("registers mcp__<serverId>__<tool> tools without touching the network", async () => {
    const server = await tasksServer();
    const fake = fakeServer([
      { name: "query_tasks", description: "Run a Tasks query", annotations: { readOnlyHint: true } },
    ]);
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork, { inProcessResolver: () => fake });

    expect(result.tools.map((tool) => tool.name)).toEqual([`mcp__${server.id}__query_tasks`]);
    expect(mcpServerIdFromToolName(result.tools[0]!.name)).toBe(server.id);
    expect(result.tools[0]?.description).toContain('Handled on this device by the Obsidian plugin "tasks-query-mcp"');
    expect(result.tools[0]?.description).not.toContain("Sends the tool arguments");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ serverId: server.id, status: "ok", toolCount: 1, toolNames: ["query_tasks"] }),
    ]);
  });

  it("applies enabledTools / disabledTools filters", async () => {
    const server = await tasksServer({ enabledTools: ["query_*"], disabledTools: ["query_secret"] });
    const fake = fakeServer([{ name: "query_tasks" }, { name: "query_secret" }, { name: "toggle_task" }]);
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork, { inProcessResolver: () => fake });

    expect(result.tools.map((tool) => tool.name)).toEqual([`mcp__${server.id}__query_tasks`]);
  });

  it("executes calls in-process and wraps the output as untrusted tool output", async () => {
    const server = await tasksServer();
    const fake = fakeServer([{ name: "query_tasks" }]);
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork, { inProcessResolver: () => fake });
    const output = await result.tools[0]!.execute("call-1", { query: "not done" }, undefined);

    expect(fake.seen.at(-1)).toMatchObject({ method: "tools/call", params: { name: "query_tasks", arguments: { query: "not done" } } });
    const text = (output.content[0] as { text: string }).text;
    expect(text).toContain("3 tasks");
    expect(text).not.toBe("3 tasks");
    expect(output.details).toMatchObject({ serverId: server.id, remoteToolName: "query_tasks", isError: false });
  });

  it("reports an unavailable plugin as a 'plugin' diagnostic and registers no tools", async () => {
    const server = await tasksServer();
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork, {
      inProcessResolver: () => {
        throw new McpInProcessUnavailableError('Obsidian plugin "tasks-query-mcp" is not installed or not enabled.');
      },
    });

    expect(result.tools).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        status: "error",
        errorCategory: "plugin",
        error: 'Obsidian plugin "tasks-query-mcp" is not installed or not enabled.',
      }),
    ]);
  });

  it("reports a missing resolver instead of falling back to HTTP", async () => {
    const server = await tasksServer();
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork);

    expect(result.diagnostics[0]).toMatchObject({ status: "error", errorCategory: "plugin" });
  });

  it("keeps a disabled in-process server out of discovery", async () => {
    const server = await tasksServer({ enabled: false });
    let resolved = false;
    const result = await createMcpToolsWithDiagnostics(settings(server), noNetwork, {
      inProcessResolver: () => {
        resolved = true;
        return fakeServer([]);
      },
    });

    expect(resolved).toBe(false);
    expect(result.diagnostics[0]?.status).toBe("disabled");
  });

  it("probes an in-process server for Test connection", async () => {
    const server = await tasksServer();
    const probe = await probeMcpServer(server, noNetwork, {
      inProcessResolver: () => fakeServer([{ name: "query_tasks", annotations: { readOnlyHint: true } }]),
    });

    expect(probe).toEqual({
      toolCount: 1,
      toolNames: ["query_tasks"],
      tools: [{ name: "query_tasks", localName: `mcp__${server.id}__query_tasks`, title: "query_tasks", readOnlyHint: true }],
    });
  });
});
