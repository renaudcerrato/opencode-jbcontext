# AGENTS.md - opencode-jbcontext

References:
- https://agentsmd.io/agents-md-best-practices

## Project Overview

This is an OpenCode plugin that keeps the current git repository indexed by
JetBrains Context (jbcontext) for semantic code search. It indexes on session
creation (mirroring jbcontext's Codex SessionStart hook), joins in-flight
indexes before searches, and exposes a manual `jbcontext_index` tool.

## Do

- Use TypeScript for all source files
- Use `@opencode-ai/plugin` for type definitions
- Keep `src/index.ts` as the main entry point
- Follow the existing code patterns in the plugin
- Keep test coverage at 100% (enforced by jest coverageThreshold)

## Don't

- Add unnecessary dependencies
- Use default exports (the plugin exports named symbols only)
- Make large speculative changes without confirming with user
- Add indexing triggers beyond session creation and the manual tool without
  discussing first (the design is deliberately Codex-parity: index on
  session start, join-only before searches)

## Commands

- `npm test` - Run jest with coverage (100% enforced)
- `npm run typecheck` - Type check the plugin
- Test locally using `opencode` with a config that references this repo path

## Project Structure

- `src/index.ts` - Main plugin implementation (server detection, hook wiring,
  SDK adapters)
- `tests/index.test.ts` - Jest tests (mock deps + mocked SDK client/$)
- `tests/setup.cjs` - Jest global setup (env pinning)
- `jest.config.cjs` - Jest config with 100% coverage thresholds
- `package.json` - Project metadata and dependencies
- `.github/workflows/` - CI (test + publish)

## Testing

- Tests exercise `createHooks` directly with mock dependencies — no real
  filesystem, network, or opencode SDK access
- The `jbcontextPlugin` factory is tested with mocked `client`/`$` objects
- Coverage must stay at 100% for statements, branches, functions, and lines

## When stuck

- Ask a clarifying question
- Propose a short plan before implementing
- Don't push large changes without confirmation