/**
 * OpenCode jbcontext plugin.
 *
 * Keeps the current git repository indexed by JetBrains Context (jbcontext)
 * so the `jbcontext_code_search` MCP tool always has a fresh index, and
 * exposes a manual `jbcontext_index` tool for on-demand re-indexing.
 *
 * Behavior (mirrors jbcontext's own Codex SessionStart hook, which runs
 * `jbcontext index --silent &` on session start):
 * - Session creation (`session.created` event) → indexes in the background
 *   (fire-and-forget); the session never waits for indexing.
 * - Before a `jbcontext_code_search` call → joins an in-flight index if one
 *   is running (so the search sees fresh content), but never starts one.
 * - The `jbcontext_index` tool indexes on demand and forwards the jbcontext
 *   CLI output (stdout + stderr) back to the agent so indexing progress,
 *   warnings, and diagnostics are visible.
 * - Concurrent index runs for the same session+repo are deduplicated (the
 *   caller gets the in-flight run's output instead of spawning a second one).
 *
 * Directory resolution:
 * - The session-created hook uses the event's `info.directory`, so worktree
 *   sessions index the correct repo root rather than the init-time project
 *   directory.
 * - The pre-search hook resolves the session's working directory from
 *   `sessionID` via the opencode SDK (client.session.get), falling back to
 *   the init directory when the lookup fails or returns no directory.
 * - The manual `jbcontext_index` tool uses the session-time
 *   `ToolContext.directory` directly.
 *
 * Error handling:
 * - Background indexing errors are logged and swallowed (graceful
 *   degradation; searches can still run against any existing index).
 * - Pre-search indexing errors are logged and swallowed so code_search can
 *   still run against any existing index.
 * - The manual `jbcontext_index` tool propagates errors to the caller.
 *
 * Self-gates on the presence of an enabled jbcontext MCP server in the
 * merged config (detected by binary basename). Throws at init if multiple
 * enabled jbcontext servers are configured.
 */

import type { Config, Plugin, PluginInput } from "@opencode-ai/plugin";

/** Basename of a path (last segment after the final `/`). Avoids a node:path dependency. POSIX-only: on Windows, config paths use `/` in opencode's merged config. */
export function basename(p: string): string {
	return p.split("/").filter(Boolean).pop() ?? "";
}

export type ServerMatch = {
	matchCount: number;
	serverName: string | null;
	binPath: string | null;
	matchNames: string[];
};

/** Pure: scan merged config for enabled jbcontext MCP servers by binary basename. */
export function findJbcontextServer(config: unknown): ServerMatch {
	const matches: Array<{ name: string; binPath: string }> = [];
	const mcp = (config as { mcp?: unknown } | null | undefined)?.mcp;
	if (mcp && typeof mcp === "object") {
		for (const [name, entry] of Object.entries(mcp as Record<string, unknown>)) {
			const server = entry as
				| { type?: unknown; enabled?: unknown; command?: unknown }
				| null
				| undefined;
			if (server?.type !== "local" || server?.enabled === false) continue;
			const cmd = server?.command;
			if (!Array.isArray(cmd) || cmd.length === 0) continue;
			if (basename(String(cmd[0])) === "jbcontext") {
				matches.push({ name, binPath: String(cmd[0]) });
			}
		}
	}
	return {
		matchCount: matches.length,
		serverName: matches.length === 1 ? matches[0].name : null,
		binPath: matches.length === 1 ? matches[0].binPath : null,
		matchNames: matches.map((m) => m.name),
	};
}

export type Log = (
	level: "debug" | "info" | "warn" | "error",
	message: string,
	extra: Record<string, unknown>,
) => Promise<void>;

export type JbcontextPluginDeps = {
	/** Structured log via the opencode SDK. */
	log: Log;
	/** Cached git root lookup from the given cwd. Throws on failure. */
	getGitRoot: (cwd: string) => Promise<string>;
	/** Resolve the working directory for a session (SDK lookup with fallback). */
	getSessionDirectory: (sessionID: string) => Promise<string>;
	/** Run jbcontext index. Throws on failure. Returns the CLI output. */
	runIndex: (bin: string, root: string) => Promise<string>;
};

/**
 * Build the plugin hooks given resolved dependencies. Split out from the
 * plugin factory so the hook wiring is testable without the opencode SDK.
 */
export function createHooks(deps: JbcontextPluginDeps) {
	// --- state (per opencode process) ---
	let enabled = false;
	let serverName: string | null = null;
	let binPath: string | null = null;
	// in-flight index promises keyed by `${sessionID}:${root}` (resolves to CLI output)
	const indexingPromises = new Map<string, Promise<string>>();

	/**
	 * Index the repo, deduplicating concurrent runs for the same repository
	 * (a caller joining an in-flight run gets that run's output). Always
	 * indexes — there is no throttle window. Keyed by repo alone: the jbcontext
	 * CLI is the shared resource, so a burst of session creations for the same
	 * repo (subagents spawning) must share one run regardless of session.
	 */
	const indexRepo = (bin: string, root: string, sessionID: string): Promise<string> => {
		const key = root;

		const existing = indexingPromises.get(key);
		if (existing) {
			return existing;
		}

		// Register the in-flight promise synchronously, before any await, so
		// concurrent callers can never both pass the check above.
		const promise = deps
			.log("info", `jbcontext: indexing ${root}…`, { root, decision: "index" })
			.then(() => deps.runIndex(bin, root))
			.finally(() => {
				indexingPromises.delete(key);
			});

		indexingPromises.set(key, promise);
		return promise;
	};

	/**
	 * Join an in-flight index for the repo if one is running. Never starts a
	 * new index — indexing is triggered by session creation and the manual
	 * tool only (Codex SessionStart-hook parity).
	 */
	const joinIndex = (root: string): Promise<string> => {
		const existing = indexingPromises.get(root);
		return existing ?? Promise.resolve("");
	};

	return {
		/** Test visibility: whether the plugin is active and for which server. */
		__state: () => ({ enabled, serverName, binPath }),

		// Init: detect jbcontext server, throw on ambiguity, never throw on missing binary.
		config: async (cfg: Config) => {
			const match = findJbcontextServer(cfg as unknown);
			if (match.matchCount === 0) {
				enabled = false;
				return;
			}
			if (match.matchCount > 1) {
				throw new Error(
					`jbcontext-index plugin: multiple enabled jbcontext MCP servers found (${match.matchNames.join(", ")}); configure exactly one.`,
				);
			}
			enabled = true;
			serverName = match.serverName;
			binPath = match.binPath;
		},

		// Session creation: kick off a background index, Codex SessionStart-hook
		// style. Fire-and-forget — never awaited, never blocks the session.
		// Routed through indexRepo so concurrent session creations for the same
		// repo (subagent bursts) share one run, and so pre-search joins can see
		// the in-flight session-start index.
		event: async ({ event }: { event: { type: string; properties: any } }) => {
			if (!enabled || !serverName || !binPath) return;
			if (event.type !== "session.created") return;
			const info = event.properties?.info;
			if (!info?.directory) return;
			const dir: string = info.directory;
			try {
				const root = await deps.getGitRoot(dir);
				indexRepo(binPath, root, info.id).catch(async (err: unknown) => {
					await deps.log(
						"debug",
						`jbcontext: background session-start indexing failed, proceeding without it`,
						{
							root,
							sessionID: info.id,
							error: err instanceof Error ? err.message : String(err),
						},
					);
				});
			} catch (err) {
				await deps.log(
					"debug",
					`jbcontext: could not resolve git root at session start, skipping background index`,
					{
						directory: dir,
						sessionID: info.id,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		},

		// Lazy: fires before every tool call; only acts on ${serverName}_code_search.
		// Join-only: waits for an in-flight index (so the search sees fresh
		// content) but never starts one. Errors are logged and swallowed so
		// code_search can still run against any existing index.
		"tool.execute.before": async (input: { tool: string; sessionID: string }) => {
			if (!enabled || !serverName || !binPath) return;
			if (input.tool !== `${serverName}_code_search`) return;

			try {
				const dir = await deps.getSessionDirectory(input.sessionID);
				const root = await deps.getGitRoot(dir);
				await joinIndex(root);
			} catch (err) {
				await deps.log(
					"error",
					`jbcontext: pre-search indexing failed, proceeding with existing index`,
					{
						sessionID: input.sessionID,
						tool: input.tool,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		},

		// Manual tool: index the current repo on demand.
		tool: {
			jbcontext_index: {
				description:
					"Run a fresh jbcontext index of the current git repository. Use this to refresh the semantic search index after making code changes, before re-running jbcontext_code_search. Takes no arguments — indexes the repo root of the current working directory.",
				args: {},
				async execute(
					_args: Record<string, never>,
					context: { directory: string; sessionID: string },
				): Promise<string> {
					if (!enabled || !binPath) {
						return "jbcontext-index plugin is not active (no enabled jbcontext MCP server found in config).";
					}
					const root = await deps.getGitRoot(context.directory);
					return indexRepo(binPath, root, context.sessionID);
				},
			},
		},
	};
}

export const jbcontextPlugin: Plugin = async ({
	client,
	$,
	directory,
}: PluginInput) => {
	// --- state (per opencode process) ---
	// git root cache keyed by cwd. Unbounded by design: bounded in practice by
	// the number of distinct working directories seen per opencode process.
	const gitRootCache = new Map<string, string>();
	// session directory cache keyed by sessionID. Unbounded by design: bounded
	// in practice by the number of sessions per opencode process.
	const sessionDirCache = new Map<string, string>();

	/** Structured log via opencode SDK. Never rejects. */
	const log: Log = (level, message, extra) => {
		client.app
			.log({
				body: { service: "opencode-jbcontext", level, message, extra },
			})
			.catch(() => {});
		return Promise.resolve();
	};

	/** Cached git root lookup from the given cwd. Throws on failure. */
	const getGitRoot = async (cwd: string): Promise<string> => {
		const cached = gitRootCache.get(cwd);
		if (cached) return cached;
		const out = await $`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet();
		const root = out.stdout.toString().trim();
		if (out.exitCode !== 0 || !root) {
			const stderr = out.stderr.toString().trim();
			throw new Error(
				`jbcontext-index: could not determine git root from "${cwd}"${stderr ? `: ${stderr}` : ""}`,
			);
		}
		gitRootCache.set(cwd, root);
		return root;
	};

	/**
	 * Resolve the working directory for a session via the opencode SDK.
	 * Falls back to the init-time `directory` if the lookup fails or returns
	 * no data, so a stale/missing session record never blocks indexing.
	 */
	const getSessionDirectory = async (sessionID: string): Promise<string> => {
		const cached = sessionDirCache.get(sessionID);
		if (cached) return cached;
		try {
			const res = await client.session.get({ path: { id: sessionID } });
			const dir = res.data?.directory;
			if (dir) {
				sessionDirCache.set(sessionID, dir);
				return dir;
			}
			await log(
				"warn",
				`jbcontext: session ${sessionID} has no directory, falling back to init directory`,
				{ sessionID, fallback: directory },
			);
		} catch (err) {
			await log(
				"warn",
				`jbcontext: could not resolve session directory for ${sessionID}, falling back to init directory`,
				{
					sessionID,
					fallback: directory,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
		return directory;
	};

	/** Run jbcontext index. Throws on failure with stderr in the message. Returns the CLI output. */
	const runIndex = async (bin: string, root: string): Promise<string> => {
		const start = Date.now();
		const out = await $`${bin} index --project-path=${root}`.nothrow().quiet();
		const ms = Date.now() - start;
		if (out.exitCode !== 0) {
			const stderr = out.stderr.toString().trim();
			await log("error", `jbcontext: indexing failed for ${root} in ${ms}ms`, {
				root,
				ms,
				stderr,
			});
			throw new Error(
				`jbcontext-index: indexing failed for "${root}"${stderr ? `: ${stderr}` : ""}`,
			);
		}
		await log("info", `jbcontext: indexed ${root} in ${ms}ms`, {
			root,
			ms,
			decision: "indexed",
		});
		const stdout = out.stdout.toString().trim();
		const stderr = out.stderr.toString().trim();
		return (
			[stdout, stderr].filter(Boolean).join("\n") ||
			`jbcontext: indexed ${root} in ${ms}ms`
		);
	};

	return createHooks({ log, getGitRoot, getSessionDirectory, runIndex });
};