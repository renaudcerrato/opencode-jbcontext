# opencode-jbcontext

[![License: MIT](https://img.shields.io/github/license/renaudcerrato/opencode-jbcontext)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode](https://opencode.ai) plugin for v1.18.29+ and v2 that keeps the current project directory indexed by [JetBrains Context (jbcontext)](https://jbcontext.com) for semantic code search — indexing on the first prompt in each session.

## Contents

- [Installation](#installation)
- [Why This Plugin?](#why-this-plugin)
- [How It Works](#how-it-works)
- [The `jbcontext_index` Tool](#the-jbcontext_index-tool)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Installation

Choose one plugin config form. For a config shared by OpenCode v1 and v2, use the v1-compatible form:

```json
{
  "plugin": ["@renaudcerrato/opencode-jbcontext@2.0.0"]
}
```

OpenCode v2 normalizes this legacy form. Use it after version 2.0.0 is published to npm; OpenCode resolves npm plugins on startup. Pinning the version keeps behavior consistent across machines.

For a v2-only config, use the native form instead (v1 does not understand it):

```json
{
  "plugins": [
    { "package": "@renaudcerrato/opencode-jbcontext@2.0.0" }
  ]
}
```

<details>
<summary>Alternative: install from source</summary>

Clone the repo to a local workspace:

```sh
git clone https://github.com/renaudcerrato/opencode-jbcontext.git ~/workspace/opencode-jbcontext
```

For a shared v1/v2 config, reference the local path with the v1-compatible form:

```json
{
  "plugin": ["~/workspace/opencode-jbcontext"]
}
```

For a v2-only config, use its native form:

```json
{
  "plugins": [
    { "package": "~/workspace/opencode-jbcontext" }
  ]
}
```

</details>

## Why This Plugin?

The jbcontext MCP server exposes `jbcontext_code_search` for semantic code search, but the index it searches is only as fresh as the last time someone ran `jbcontext index`. Without automation:

- A freshly cloned or heavily edited repo searches against a stale index.
- You have to remember to run `jbcontext index` manually (or via a shell hook) in every session.
- Other agents (Claude Code, Codex) get this through jbcontext's `setup-agent` SessionStart hooks; OpenCode uses this plugin for equivalent automation.

The plugin indexes on the first user prompt in each session, keeping semantic search current without a separate manual step.

## How It Works

The v1 and v2 host adapters share the same indexing behavior:

1. **MCP registration** — on either host, if no jbcontext MCP server is configured, the plugin registers one automatically (resolving the binary from `PATH`, then the installer's default `~/.jbcontext/bin/jbcontext`). Wrapper invocations (`["npx", "jbcontext", "mcp"]`, `["/usr/bin/env", "jbcontext", "mcp"]`) are detected; extra flags before the binary are not. Existing or explicitly disabled entries are never overridden.
2. **First prompt** — v1 uses `chat.message`; v2 uses `session.hook("prompt")`. Both start `jbcontext index` for the session's directory in the background, without delaying the prompt, once per session per OpenCode process. A resumed session is indexed on its first user prompt after a restart.
3. **Before a search** — before the configured semantic search tool (`<your-server-key>_code_search`, typically `jbcontext_code_search`), the plugin joins an in-flight index but never starts one. Only the first prompt and manual tool trigger indexing.
4. **On demand** — the `jbcontext_index` tool (below) runs a fresh index whenever the agent asks for one.

Concurrent index runs for the same directory are deduplicated: a caller that arrives while an index is running gets that run's output instead of spawning a second one.

If the jbcontext CLI is not installed, the plugin logs a single warning with the install command and stays inactive:

```sh
curl -fsSL https://download.jetbrains.com/jetbrains-context/release/download-jbcontext.sh | bash
```

## The `jbcontext_index` Tool

The plugin registers a `jbcontext_index` tool that agents can call to force a fresh index — useful after making code changes, before re-running `jbcontext_code_search`:

```jsonc
// The agent calls it like any other tool:
jbcontext_index({})
```

It takes no arguments and returns the jbcontext CLI output (stdout + stderr). V1 uses the tool context's `directory`; v2 resolves the session directory by ID. Both fall back to the plugin's initialization directory when needed.

## Requirements

- [OpenCode](https://opencode.ai) v1.18.29+ or a compatible v2 release (v2 API verified at v2.0.15)
- POSIX (macOS/Linux): binary resolution walks `PATH` and the installer's default location; Windows is not supported (the plugin degrades gracefully to inactive).
- The [jbcontext CLI](https://jbcontext.com) installed and authenticated (`jbcontext login`) — the plugin registers the MCP server itself, but authentication is interactive and stays the user's job.

If jbcontext is not installed, the plugin logs one warning and stays inactive. Configuring more than one enabled jbcontext MCP server is an error.

## Development

```sh
npm install
npm test        # jest with 100% coverage enforced (statements/branches/functions/lines)
npm run typecheck
```

## License

[MIT](LICENSE)
