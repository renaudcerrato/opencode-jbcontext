# opencode-jbcontext

[![License: MIT](https://img.shields.io/github/license/renaudcerrato/opencode-jbcontext)](LICENSE)
[![Tests](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml/badge.svg)](https://github.com/renaudcerrato/opencode-jbcontext/actions/workflows/test.yml)
![Statements](https://img.shields.io/badge/statements-100%25-brightgreen.svg?style=flat)
![Branches](https://img.shields.io/badge/branches-100%25-brightgreen.svg?style=flat)
![Functions](https://img.shields.io/badge/functions-100%25-brightgreen.svg?style=flat)
![Lines](https://img.shields.io/badge/lines-100%25-brightgreen.svg?style=flat)

[OpenCode](https://opencode.ai) plugin that keeps the current git repository indexed by [JetBrains Context (jbcontext)](https://jbcontext.com) for semantic code search — indexing on session start, exactly like jbcontext's own Codex integration.

## Contents

- [Installation](#installation)
- [Why This Plugin?](#why-this-plugin)
- [How It Works](#how-it-works)
- [The `jbcontext_index` Tool](#the-jbcontext_index-tool)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Installation

Add the plugin to your OpenCode config (`opencode.jsonc`), pinned to a version:

```json
{
  "plugin": ["@renaudcerrato/opencode-jbcontext@1.0.0"]
}
```

OpenCode resolves and installs npm plugin references automatically on startup — no manual install step. Pinning the version is recommended: it guarantees the plugin behavior stays identical across machines until you choose to upgrade.

<details>
<summary>Alternative: install from source</summary>

Clone the repo to a local workspace:

```sh
git clone https://github.com/renaudcerrato/opencode-jbcontext.git ~/workspace/opencode-jbcontext
```

Then reference the local path in your OpenCode config (`opencode.jsonc`):

```json
{
  "plugin": ["~/workspace/opencode-jbcontext"]
}
```

</details>

## Why This Plugin?

The jbcontext MCP server exposes `jbcontext_code_search` for semantic code search, but the index it searches is only as fresh as the last time someone ran `jbcontext index`. Without automation:

- A freshly cloned or heavily edited repo searches against a stale index.
- You have to remember to run `jbcontext index` manually (or via a shell hook) in every session.
- Other agents (Claude Code, Codex) get this for free via jbcontext's `setup-agent` SessionStart hooks — OpenCode had no equivalent.

This plugin gives OpenCode the same treatment: the repository is indexed automatically when a session starts, so semantic search always has recent content without any manual step.

## How It Works

The plugin mirrors jbcontext's own Codex SessionStart hook (`jbcontext index --silent &`):

1. **MCP registration** — if no jbcontext MCP server is configured, the plugin registers one automatically (resolving the binary from `PATH`, then the installer's default `~/.jbcontext/bin/jbcontext`). OpenCode initializes plugins before MCP servers, so the registered server is spawned in the same session — no restart, no config editing. An existing jbcontext MCP entry is never overridden.
2. **Session start** — when a session is created, the plugin resolves the session's git repository root and kicks off `jbcontext index` in the background (fire-and-forget). The session never waits for indexing.
3. **Before a search** — when `jbcontext_code_search` runs, the plugin joins an in-flight index if one is running (so the search sees fresh content) but never starts one. Indexing is triggered by session start and the manual tool only.
4. **On demand** — the `jbcontext_index` tool (below) runs a fresh index whenever the agent asks for one.

Concurrent index runs for the same repository are deduplicated: a caller that arrives while an index is running gets that run's output instead of spawning a second one.

Worktree sessions index the correct repository root — the plugin resolves the session's working directory through the OpenCode SDK, not the startup directory.

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

It takes no arguments, indexes the repository root of the current working directory, and returns the jbcontext CLI output (stdout + stderr) so indexing progress, warnings, and diagnostics are visible to the agent.

## Requirements

- [OpenCode](https://opencode.ai)
- The [jbcontext CLI](https://jbcontext.com) installed and authenticated (`jbcontext login`) — the plugin registers the MCP server itself, but authentication is interactive and stays the user's job.

The plugin self-gates: if the jbcontext binary cannot be found (neither on `PATH` nor at the installer's default location), it logs one warning and stays inactive. Configuring more than one enabled jbcontext MCP server is an error.

## Development

```sh
npm install
npm test        # jest with 100% coverage enforced (statements/branches/functions/lines)
npm run typecheck
```

## License

[MIT](LICENSE)