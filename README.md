# opencode-jbcontext

[![License: MIT](https://img.shields.io/github/license/renaudcerrato/opencode-jbcontext)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode v2](https://opencode.ai/v2/docs/) plugin that keeps the current project directory indexed by [JetBrains Context (jbcontext)](https://jbcontext.com) for semantic code search. It starts indexing on the first prompt in each session, so searches can use a fresh index without delaying the prompt.

## Contents

- [Installation](#installation)
- [Why This Plugin?](#why-this-plugin)
- [How It Works](#how-it-works)
- [The `jbcontext_index` Tool](#the-jbcontext_index-tool)
- [Requirements](#requirements)
- [Legacy OpenCode v1](#legacy-opencode-v1)
- [Development](#development)
- [License](#license)

## Installation

Add the plugin to your OpenCode v2 config (`opencode.jsonc`), pinned to a version:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "@renaudcerrato/opencode-jbcontext@2.0.0" }
  ]
}
```

OpenCode installs the npm plugin automatically. Pinning the version keeps its behavior consistent until you choose to upgrade. Restart OpenCode after changing its plugin configuration.

<details>
<summary>Alternative: install from source</summary>

Clone the repo to a local workspace:

```sh
git clone https://github.com/renaudcerrato/opencode-jbcontext.git ~/workspace/opencode-jbcontext
```

Reference the checkout directory in your OpenCode v2 config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
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
- Other agents (Claude Code, Codex) get similar automation through jbcontext's `setup-agent` hooks; this plugin provides it for OpenCode.

The plugin indexes on the first user prompt in each session, keeping semantic search current without a separate manual step.

## How It Works

The plugin uses OpenCode v2 hooks to keep indexing asynchronous and search-aware:

1. **MCP registration** — if no jbcontext MCP server is configured, the plugin registers one automatically (resolving the binary from `PATH`, then the installer's default `~/.jbcontext/bin/jbcontext`). Wrapper invocations (`["npx", "jbcontext", "mcp"]`, `["/usr/bin/env", "jbcontext", "mcp"]`) are detected; extra flags before the binary are not. Existing or explicitly disabled entries are never overridden.
2. **First prompt** — `session.hook("prompt")` starts `jbcontext index` for the session's directory in the background, without delaying the prompt, once per session per OpenCode process. A resumed session is indexed on its first user prompt after a restart.
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

It takes no arguments, indexes the session's directory, and returns the jbcontext CLI output (stdout + stderr). If the session directory cannot be resolved, it falls back to the plugin's initialization directory.

## Requirements

- [OpenCode v2](https://opencode.ai/v2/docs/) (tested with v2.0.16)
- POSIX (macOS/Linux): binary resolution walks `PATH` and the installer's default location; Windows is not supported (the plugin degrades gracefully to inactive).
- The [jbcontext CLI](https://jbcontext.com) installed and authenticated (`jbcontext login`) — the plugin registers the MCP server itself, but authentication is interactive and stays the user's job.

If jbcontext is not installed, the plugin logs one warning and stays inactive. Configuring more than one enabled jbcontext MCP server is an error.

## Legacy OpenCode v1

OpenCode v1.18.29+ remains supported temporarily. Use the v1 `plugin` config instead of the v2 `plugins` config:

```jsonc
{
  "plugin": ["@renaudcerrato/opencode-jbcontext@2.0.0"]
}
```

OpenCode v2 can also read this legacy config, but new v2 installations should use the native form above. Earlier v1 releases are not supported.

## Development

```sh
npm install
npm test        # jest with 100% coverage enforced (statements/branches/functions/lines)
npm run typecheck
```

## License

[MIT](LICENSE)
