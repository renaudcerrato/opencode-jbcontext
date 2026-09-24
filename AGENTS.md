# AGENTS.md - opencode-jbcontext

References:
- https://agentsmd.io/agents-md-best-practices

## Project Overview

This is a hybrid OpenCode plugin for v1.18.29+ and v2 that keeps the current
project directory indexed by JetBrains Context (jbcontext) for semantic code
search. It auto-registers the MCP server when none is configured (never
overriding existing or explicitly disabled entries), indexes on the first
prompt per session (`chat.message` in v1, `session.hook("prompt")` in v2),
joins in-flight indexes before searches, and exposes `jbcontext_index`.

## Do

- Use TypeScript for all source files
- Import v2 runtime APIs and types from `@opencode/plugin`
- Import v1 types from `@opencode-ai/plugin` using type-only imports
- Keep `src/index.ts` as the main entry point
- Default-export one hybrid plugin object with the v2
  `Plugin.define({ id, setup })` entry and v1 `server(input)` entry; keep test
  helpers as named exports
- Follow the existing code patterns in the plugin
- Keep test coverage at 100% (enforced by jest coverageThreshold)

## Don't

- Add unnecessary dependencies
- Do not export the runtime plugin as named-only; both host loaders use the
  hybrid default export
- Make large speculative changes without confirming with user
- Add indexing triggers beyond the first prompt per session and the manual
  tool without discussing first; pre-search behavior only joins an in-flight
  index
- Override an existing jbcontext MCP entry in the user's config

## Commands

- `npm test` - Run jest with coverage (100% enforced)
- `npm run typecheck` - Type check the plugin
- Test locally using `opencode` with a config that references this repo path

## Project Structure

- `src/index.ts` - Main plugin implementation (server detection, hook wiring,
  SDK adapters)
- `tests/index.test.ts` - Jest tests (injected deps + mocked v1/v2 hosts and
  child process)
- `tests/setup.cjs` - Jest global setup (env pinning)
- `jest.config.cjs` - Jest config with 100% coverage thresholds
- `package.json` - Project metadata and dependencies
- `.github/workflows/` - CI (test + publish)

## Testing

- Tests exercise shared hooks with injected dependencies and both host adapters
  through mocks — no real OpenCode runtime, network, or CLI process is used
- The hybrid default export, v1 `server()` entry, and v2 `Plugin.define` setup
  are covered; named helper exports support focused unit tests
- Coverage must stay at 100% for statements, branches, functions, and lines

## When stuck

- Ask a clarifying question
- Propose a short plan before implementing
- Don't push large changes without confirmation
