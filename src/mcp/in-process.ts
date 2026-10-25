import type { App } from "obsidian";
import {
  parseTools,
  type McpCallToolResult,
  type McpClient,
  type McpToolDefinition,
} from "./client";
import { DEFAULT_MCP_HTTP_TIMEOUT_MS, withMcpTimeout } from "./http";
import type { McpServerSettings } from "./settings";

/**
 * In-process MCP transport: JSON-RPC messages are handed to an object exported
 * by another enabled Obsidian plugin instead of being POSTed over HTTP.
 * Nothing leaves the device; the other plugin is still treated as untrusted
 * (annotations ignored, results wrapped, every call gated like HTTP MCP).
 */

export const IN_PROCESS_MCP_CONTRACT_VERSION = 1;
export const IN_PROCESS_MCP_URL_SCHEME = "obsidian-plugin:";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const JSON_RPC = "2.0";
const SELF_PLUGIN_ID = "agentic-chat";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const EXPORT_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FORBIDDEN_EXPORT_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Contract an Obsidian plugin exports to act as an in-process MCP server. */
export interface InProcessMcpServer {
  contractVersion: 1;
  /** Handles one JSON-RPC 2.0 message. Returns null for notifications. */
  handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
}

export interface InProcessMcpTarget {
  /** Obsidian plugin id, e.g. "tasks-query-mcp". */
  pluginId: string;
  /** Property of the plugin instance holding the server, e.g. "agenticMcp". */
  exportName: string;
}

/** Looks up the server object for a target; throws McpInProcessUnavailableError. */
export type InProcessMcpResolver = (target: InProcessMcpTarget) => InProcessMcpServer;

/** The target plugin is missing, disabled, has no export, or speaks another contract. */
export class McpInProcessUnavailableError extends Error {}

class McpInProcessJsonRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Synthetic display URL for an in-process server; never fetched. */
export function inProcessMcpUrl(target: InProcessMcpTarget): string {
  return `${IN_PROCESS_MCP_URL_SCHEME}//${target.pluginId}/${target.exportName}`;
}

/** Validates a target's names; returns a problem description or "". */
export function inProcessTargetProblem(target: Partial<InProcessMcpTarget>): string {
  const pluginId = typeof target.pluginId === "string" ? target.pluginId : "";
  const exportName = typeof target.exportName === "string" ? target.exportName : "";
  if (!PLUGIN_ID_PATTERN.test(pluginId)) return `invalid pluginId "${pluginId}"`;
  if (pluginId === SELF_PLUGIN_ID) return `pluginId "${pluginId}" refers to Agentic Chat itself`;
  if (!EXPORT_NAME_PATTERN.test(exportName) || FORBIDDEN_EXPORT_NAMES.has(exportName)) {
    return `invalid export "${exportName}"`;
  }
  return "";
}

interface ObsidianPluginRegistry {
  enabledPlugins?: Set<string>;
  plugins?: Record<string, unknown>;
}

/**
 * Resolves targets against `app.plugins`: only an enabled, loaded plugin's own
 * export is used. No eval, no dynamic loading, no arbitrary property paths.
 */
export function createObsidianPluginResolver(app: App): InProcessMcpResolver {
  return (target) => {
    const problem = inProcessTargetProblem(target);
    if (problem) throw new McpInProcessUnavailableError(`In-process MCP target rejected: ${problem}.`);
    const registry = (app as unknown as { plugins?: ObsidianPluginRegistry }).plugins;
    const { pluginId, exportName } = target;
    if (!registry?.enabledPlugins?.has(pluginId)) {
      throw new McpInProcessUnavailableError(
        `Obsidian plugin "${pluginId}" is not installed or not enabled.`,
      );
    }
    const instance = registry.plugins?.[pluginId];
    if (!instance || typeof instance !== "object") {
      throw new McpInProcessUnavailableError(`Obsidian plugin "${pluginId}" is enabled but not loaded yet.`);
    }
    const exported: unknown = (instance as Record<string, unknown>)[exportName];
    if (!exported || typeof exported !== "object") {
      throw new McpInProcessUnavailableError(`Obsidian plugin "${pluginId}" has no "${exportName}" export.`);
    }
    const server = exported as Partial<InProcessMcpServer>;
    if (server.contractVersion !== IN_PROCESS_MCP_CONTRACT_VERSION) {
      throw new McpInProcessUnavailableError(
        `Obsidian plugin "${pluginId}" export "${exportName}" uses contract version ` +
          `${String(server.contractVersion)}; expected ${IN_PROCESS_MCP_CONTRACT_VERSION}.`,
      );
    }
    if (typeof server.handle !== "function") {
      throw new McpInProcessUnavailableError(
        `Obsidian plugin "${pluginId}" export "${exportName}" has no handle() function.`,
      );
    }
    return server as InProcessMcpServer;
  };
}

export interface McpInProcessClientOptions {
  server: McpServerSettings;
  resolve: InProcessMcpResolver;
  requestTimeoutMs?: number;
}

export class McpInProcessClient implements McpClient {
  private readonly server: McpServerSettings;
  private readonly resolve: InProcessMcpResolver;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private initialized = false;

  constructor(options: McpInProcessClientOptions) {
    if (!options.server.inProcess) throw new Error(`MCP ${options.server.name} is not an in-process server.`);
    this.server = options.server;
    this.resolve = options.resolve;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MCP_HTTP_TIMEOUT_MS;
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "obsidian-agentic-chat", title: "Agentic Chat", version: "0.0.0" },
      },
      signal,
    );
    this.initialized = true;
    await this.send({ jsonrpc: JSON_RPC, method: "notifications/initialized" }, "notifications/initialized", signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDefinition[]> {
    await this.ensureInitialized(signal);
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = asRecord(await this.request("tools/list", cursor ? { cursor } : undefined, signal));
      tools.push(...parseTools(result.tools));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
    await this.ensureInitialized(signal);
    return asRecord(await this.request("tools/call", { name, arguments: args }, signal));
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) await this.initialize(signal);
  }

  private async request(method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonRpcMessage = { jsonrpc: JSON_RPC, id, method, ...(params ? { params } : {}) };
    const response = asRecord(await this.send(message, method, signal));
    if (response.id !== id) {
      throw new Error(`MCP ${this.server.name} ${method} failed: in-process server returned a response for another request.`);
    }
    const error = response.error;
    if (error && typeof error === "object") {
      const record = asRecord(error);
      const detail = typeof record.message === "string" && record.message ? record.message : "JSON-RPC error";
      throw new McpInProcessJsonRpcError(
        typeof record.code === "number" ? record.code : undefined,
        `MCP ${this.server.name} ${method} failed: ${detail}`,
      );
    }
    if (!("result" in response)) {
      throw new Error(`MCP ${this.server.name} ${method} failed: in-process server returned an invalid JSON-RPC response.`);
    }
    return response.result;
  }

  /** Hands one message to the target plugin; copies both ways so no object references cross plugins. */
  private async send(message: JsonRpcMessage, method: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new Error("Aborted.");
    const target = this.server.inProcess!;
    const server = this.resolve(target);
    const outgoing = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
    const handled = Promise.resolve()
      .then(() => server.handle(outgoing))
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`MCP ${this.server.name} ${method} failed: in-process server threw: ${detail}`, { cause: error });
      });
    const reply = await withMcpTimeout(raceAbort(handled, signal), `${this.server.name} ${method}`, this.requestTimeoutMs);
    if (message.id === undefined) return null;
    if (reply === null || reply === undefined) {
      throw new Error(`MCP ${this.server.name} ${method} failed: in-process server returned no response.`);
    }
    try {
      return JSON.parse(JSON.stringify(reply)) as unknown;
    } catch (error) {
      throw new Error(`MCP ${this.server.name} ${method} failed: in-process response is not JSON-serializable.`, {
        cause: error,
      });
    }
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("Aborted."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
