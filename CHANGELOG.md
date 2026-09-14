# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-13

### Added

- Automatic MCP server registration: if no jbcontext MCP server is configured,
  the plugin resolves the jbcontext binary (walking `PATH`, then the
  installer's default `~/.jbcontext/bin/jbcontext`) and registers a
  `jbcontext` MCP entry on the runtime config — spawned in the same session,
  no restart or config editing needed. The registered command is always an
  absolute path. Wrapper invocations (`npx`/`env` launchers with the binary
  at argv[1]) are detected too. Existing jbcontext MCP entries are never
  overridden — including explicitly disabled entries, matched by binary
  basename regardless of their config key, and any entry under the literal
  `jbcontext` key regardless of type.
- Single warning with the official install command when the jbcontext CLI is
  not installed; the plugin stays inactive instead of spamming errors.
- Background indexing on the first user prompt of a session (`chat.message`
  hook), mirroring jbcontext's Codex SessionStart hook
  (`jbcontext index --silent &` on `startup|resume`): the prompt never waits
  for indexing, and resumed sessions re-index on their first prompt after a
  restart (per-session guard, once per session per process).
- Join-only pre-search behavior: `jbcontext_code_search` calls wait for an
  in-flight index (so the search sees fresh content) but never start one.
- Manual `jbcontext_index` tool for on-demand re-indexing, forwarding the
  jbcontext CLI output (stdout + stderr) to the agent.
- Concurrent index deduplication per repository.
- Worktree-aware directory resolution: the session's working directory is
  resolved through the OpenCode SDK, so worktree sessions index the correct
  repository root.
- Self-gating on the presence of an enabled jbcontext MCP server in the
  merged config; ambiguous configurations (multiple enabled jbcontext
  servers) fail fast at startup.
- 100% test coverage (statements, branches, functions, lines), enforced in
  CI.

[1.0.0]: https://github.com/renaudcerrato/opencode-jbcontext/releases/tag/v1.0.0