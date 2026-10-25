# Agent Plugins

Agent plugins are packages in the vault that follow the [Agent Plugins 1.0.0 specification](https://agent-plugins.org). Each package is a folder containing a `plugin.json` manifest plus optional `skills/` and `mcp.json` components. Agentic Chat treats the plugin folder as the **single source of truth** for skills and MCP servers.

## Layout

Plugins live in `.agentic-plugins/` at the vault root (configurable in Settings → Resources → Plugins folder):

```text
.agentic-plugins/
└── my-plugin/
    ├── plugin.json          # required: name, version, description
    ├── skills/
    │   └── summarize/
    │       └── SKILL.md     # skill name + description from frontmatter
    └── mcp.json             # optional: mcpServers map
```

- **Skills** — each folder under `skills/` holds a `SKILL.md`. The frontmatter `name` and `description` feed the skill registry; the body is the skill content. Plugin skills load first, so a plugin skill of the same name shadows a built-in.
- **MCP** — `mcp.json` declares `mcpServers` (currently `streamable-http` only; in-process servers backed by another Obsidian plugin are declared in `plugin.json`, see [below](#in-process-mcp-servers-obsidian-plugins)). Servers whose transport is unsupported are skipped; valid ones load with their persisted client state (enable toggle, approval, auth, OAuth) preserved by id. Tool names use the id `mcp__plugin_<name>_<key>__<tool>`.

A plugin with only an `mcp.json` (no skills) is valid — MCP-only plugins are allowed by the spec.

A plugin with neither `skills/` nor `mcp.json` (manifest only) is also valid: per §6.2 a missing
component location is not an error, so the loader reports it `ok` with 0 skills / 0 servers.
The vault ships one such package, `my-skills`, as your personal collection space for hand-curated
custom skills (`skills/<name>/SKILL.md` inside it). It is created only when absent and never overwritten;
deleting it restores on next restart (or via **Repair built-ins**, which also restores `my-skills`).

> **Note on built-ins staleness.** The `builtins` package in your vault is a materialized copy: it is
> only created when missing and never auto-updated, so after a plugin update it can lag behind the
> bundled skill text until you hit **Repair built-ins**. The agent always falls back to the bundled
> text for skills shadowed by nothing, but vault edits win — when in doubt, repair.

## In-process MCP servers (Obsidian plugins)

An agent plugin can also point at an MCP server implemented by **another Obsidian plugin** in the
same vault. Nothing goes over the network: JSON-RPC messages are handed to an object that plugin
exports, so it works the same on desktop and mobile. The declaration lives in the client extension
namespace of `plugin.json` (not in `mcp.json`, which stays plain Agent Plugins 1.0):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "tasks-query",
  "version": "0.1.0",
  "description": "Run Obsidian Tasks queries",
  "extensions": {
    "agentic-chat": {
      "inProcessMcpServers": {
        "tasks": { "type": "obsidian-plugin", "pluginId": "tasks-query-mcp", "export": "agenticMcp" }
      }
    }
  }
}
```

- `pluginId` is the Obsidian plugin id; `export` is the property of that plugin instance holding the
  server (`app.plugins.plugins[pluginId][export]`). Only an **enabled** plugin's own export is used —
  no `eval`, no code loading, no arbitrary property paths.
- The exported object implements contract version 1:

  ```ts
  interface InProcessMcpServer {
    contractVersion: 1;
    /** Handles one JSON-RPC 2.0 message; returns null for notifications. */
    handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
  }
  ```

  Required methods: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; anything
  else should answer with JSON-RPC error `-32601`.
- Servers behave like `mcp.json` servers: stable id (`plugin_<name>_<hash>`), tool names
  `mcp__<server-id>__<tool>`, **disabled until you enable them** in the MCP tab (the MCP master
  switch must be on too), approval **ask** by default, the same allow/deny tool filters, the same
  untrusted-output wrapping, limits, and artifacts, and the same approval gate (plan mode denies,
  YOLO allows unless the server is set to deny). Tool annotations such as `readOnlyHint` are not trusted.
- The tool budget (Settings → Tool budget) never drops in-process MCP tools: they make no network calls and
  the user enabled them for this vault. Remote MCP tools are still dropped first when tool schemas grow large.
- Each `handle()` call has the MCP request timeout (30 s); an exception or JSON-RPC error becomes a
  tool error, never a crash. Messages are copied through JSON in both directions.
- If the target plugin is missing, disabled, has no such export, or implements another contract
  version, `/status`, `/doctor`, and **Test connection** report it (category `plugin`) and no tools
  are registered; the rest of the agent keeps working. Runtime resources reload at the start of
  every turn, so a plugin that loads after Agentic Chat is picked up on the next message.
- Invalid entries (unknown `type`, malformed `pluginId`/`export`, a key already used in `mcp.json`)
  are skipped and listed in `/doctor`; they never reject the whole package.

## Creating plugins

The settings UI writes real packages for you:

- **MCP tab → Add MCP server** — enter a server name and an HTTPS (or loopback HTTP) endpoint, hit **Add MCP server**, and a package is created with that server's `plugin.json` + `mcp.json`. You then configure authentication, approval, and enable state from the same tab; endpoint and literal headers remain owned by the package.
- **Resources tab → New skill…** — scaffold a single-skill package (`skills/<name>/SKILL.md`) with a ready-to-fill template. The agent has the same capability in chat via the `create_skill` tool (same writer, always approval-gated — YOLO never auto-approves it, the package replaces same-named ones only after explicit confirmation, and created packages are not undoable via `/undo`).

Known limitation: generic file tools (`read`, `ls`) fall back to disk when the vault index is stale
(e.g. dot-folders created outside the session), but `edit`/`rename`/`delete` are still index-only —
editing an installed skill's files may need an Obsidian restart to re-index first. Skill *creation*
always works via `create_skill` / the wizard regardless.

## Importing plugins

**Resources tab → Install plugin…** brings packages into the vault from a GitHub URL, an archive, or a vault folder (desktop). See [Installing agent plugins](../guide/install.md) for the supported input shapes.

- Claude / Copilot / VS Code packages are converted to Agent Plugins 1.0 on import (skills copied whole, `mcpServers` → `mcp.json`, unsupported fields dropped with warnings).
- Imported packages show their install provenance (`Source:` line, e.g. `github:user/repo`) and can be **Removed** from the Resources tab, which also deletes any MCP servers the package contributed.
- Importing over an existing name updates it in place.
- Marketplace catalogs (`marketplace.json`) are shown as a pick list; `./`-relative entries install directly, git/archive entries list their fetch instructions.

## Built-in skill package

On first load, Agentic Chat materializes a `builtins` package in the plugins folder with the self-knowledge, deep-research (web mode), and install-plugin skills, so built-ins behave exactly like plugin skills (and a plugin skill with the same name can shadow them). The package is only materialized if missing — edits are never overwritten. If it is deleted, recreate it with **Resources → Repair built-ins**.

## Managing plugins

- **Resources tab → Installed plugins** — per-plugin enable toggles, spec-compliance status, component counts, and open-folder shortcuts.
- **`/doctor`** in chat — one health panel: aggregate status, then every package audited (manifest validation, skill counts, MCP server counts, skipped transports, and any spec violations) plus full runtime diagnostics.

## Spec compliance

- Vendored 1.0.0 JSON Schemas (`plugin.schema.json`, `mcp.schema.json`) validate every package on load.
- A fatal manifest violation rejects only that plugin; failures inside one plugin never affect the others.
- Packages are plain vault files: version-controllable, exportable with your vault, and readable on any device — no Node runtimes involved, so the same packages work on desktop and mobile.
