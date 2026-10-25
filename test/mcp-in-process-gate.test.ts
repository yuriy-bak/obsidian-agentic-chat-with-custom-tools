import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { AgentToolCallController, type ToolApprovalRequest } from "../src/agent/tool-call-controller";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import type { ApprovalPolicy } from "../src/agent/approval";
import { createMcpServerState } from "../src/mcp/settings";
import { localMcpToolName } from "../src/mcp/tools";
import { pluginMcpServerId } from "../src/plugins/loader";
import { FakeVault } from "./helpers/fake-vault";

// In-process tools are plain MCP tools to the gate: the server id in the tool
// name selects the plugin server's client-owned approval state.
const SERVER_ID = pluginMcpServerId("tasks-query", "tasks");
const TOOL_NAME = localMcpToolName(SERVER_ID, "query_tasks");

function gate(options: {
  mode?: AgenticChatSettings["mode"];
  serverApproval?: ApprovalPolicy;
  perTool?: Record<string, ApprovalPolicy>;
}): { controller: AgentToolCallController; requests: ToolApprovalRequest[] } {
  const settings: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    mode: options.mode ?? "safe",
    approval: { ...DEFAULT_SETTINGS.approval, perTool: options.perTool ?? {}, workingDirs: [] },
    plugins: {
      ...DEFAULT_SETTINGS.plugins,
      mcpState: options.serverApproval
        ? { [SERVER_ID]: createMcpServerState(SERVER_ID, { enabled: true, approval: options.serverApproval }) }
        : {},
    },
  };
  const requests: ToolApprovalRequest[] = [];
  const controller = new AgentToolCallController({
    app: { vault: new FakeVault() } as unknown as App,
    getSettings: () => settings,
    confirmToolCall: async (request) => {
      requests.push(request);
      return { approved: true, remember: false };
    },
    getTools: () => [{ name: TOOL_NAME, label: "tasks-query: tasks: query_tasks" } as AgentTool],
    getProfiles: () => [],
    onUndoApplied: () => undefined,
  });
  return { controller, requests };
}

const call = (controller: AgentToolCallController) =>
  controller.beforeToolCall({ toolCall: { id: "call-1", name: TOOL_NAME }, args: { query: "not done" } });

describe("in-process MCP tools through gateMcpToolCall", () => {
  it("asks by default (new plugin servers start with approval ask)", async () => {
    const { controller, requests } = gate({ serverApproval: "ask" });

    await expect(call(controller)).resolves.toBeUndefined();
    expect(requests).toEqual([{ toolName: TOOL_NAME, label: "tasks-query: tasks: query_tasks", args: { query: "not done" } }]);
  });

  it("asks when the server has no stored state yet", async () => {
    const { controller, requests } = gate({});

    await call(controller);
    expect(requests).toHaveLength(1);
  });

  it("denies in plan mode even when the server allows", async () => {
    const { controller, requests } = gate({ mode: "plan", serverApproval: "allow" });

    await expect(call(controller)).resolves.toMatchObject({ block: true });
    expect(requests).toHaveLength(0);
  });

  it("allows in YOLO mode unless the server denies", async () => {
    const yolo = gate({ mode: "yolo", serverApproval: "ask" });
    await expect(call(yolo.controller)).resolves.toBeUndefined();
    expect(yolo.requests).toHaveLength(0);

    const denied = gate({ mode: "yolo", serverApproval: "deny" });
    await expect(call(denied.controller)).resolves.toEqual({
      block: true,
      reason: `The "${TOOL_NAME}" MCP tool is disabled by your MCP approval settings.`,
    });
  });

  it("honors a per-tool allow (\"don't ask again\") over the server's ask", async () => {
    const { controller, requests } = gate({ serverApproval: "ask", perTool: { [TOOL_NAME]: "allow" } });

    await expect(call(controller)).resolves.toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("honors a per-tool deny over a server allow", async () => {
    const { controller } = gate({ serverApproval: "allow", perTool: { [TOOL_NAME]: "deny" } });

    await expect(call(controller)).resolves.toMatchObject({ block: true });
  });
});
