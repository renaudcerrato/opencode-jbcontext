/**
 * OpenCode jbcontext plugin.
 *
 * Keeps the current project directory indexed by JetBrains Context
 * (jbcontext) so the `jbcontext_code_search` MCP tool always has a fresh
 * index, and exposes a manual `jbcontext_index` tool for on-demand
 * re-indexing.
 *
 * Behavior (mirrors jbcontext's own Codex SessionStart hook, which runs
 * `jbcontext index --silent &` on session start/resume):
 * - First user prompt in a session (`chat.message` in v1, `prompt` in v2) →
 *   indexes in the background (fire-and-forget); the prompt never waits for indexing. The
 *   per-session guard fires exactly once per session per opencode process,
 *   covering new and resumed sessions alike (a resumed session keeps its
 *   sessionID, so its first prompt after a restart re-indexes — Codex
 *   `resume` parity).
 * - Before a `jbcontext_code_search` call → joins an in-flight index if one
 *   is running (so the search sees fresh content), but never starts one.
 * - The `jbcontext_index` tool indexes on demand and forwards the jbcontext
 *   CLI output (stdout + stderr) back to the agent so indexing progress,
 *   warnings, and diagnostics are visible.
 * - Concurrent index runs for the same directory are deduplicated (the
 *   caller gets the in-flight run's output instead of spawning a second
 *   one). jbcontext resolves the git root itself when the directory is
 *   inside one — the plugin passes the directory as-is and stays git-free.
 *
 * Directory resolution:
 * - The first-prompt hook resolves the session's working directory by ID
 *   through the host's session API, falling back to the init directory when
 *   the lookup fails or returns no directory.
 * - The pre-search hook uses the same resolution.
 * - The manual `jbcontext_index` tool uses `ToolContext.directory` in v1;
 *   v2 tool contexts only expose sessionID, so v2 uses the session lookup.
 *
 * Error handling:
 * - Background indexing errors are logged and swallowed (graceful
 *   degradation; searches can still run against any existing index).
 * - Pre-search indexing errors are logged and swallowed so code_search can
 *   still run against any existing index.
 * - The manual `jbcontext_index` tool propagates errors to the caller.
 *
 * Self-gates on the presence of an enabled jbcontext MCP server in the
 * merged config (detected by binary basename). Throws if multiple enabled
 * jbcontext servers are configured. The default export supports both the
 * v1 server() and v2 setup() plugin loaders.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { Plugin } from "@opencode/plugin";
import type { Hooks as V1Hooks, Plugin as V1Plugin } from "@opencode-ai/plugin";

/** The two host APIs only need these MCP operations to share registration logic. */
type ServerEditor = {
	list(): Iterable<readonly [string, unknown]>;
	set(name: string, config: { type: "local"; command: string[] }): void;
};

const INDEX_DESCRIPTION =
	"Run a fresh jbcontext index of the current project directory. Use this to refresh the semantic search index after making code changes, before re-running jbcontext_code_search. Takes no arguments — indexes the current working directory.";

/** Basename of a path (last segment after the final `/`). Avoids a node:path dependency. POSIX-only: on Windows, config paths use `/` in opencode's merged config. */
export function basename(p: string): string {
	return p.split("/").filter(Boolean).pop() ?? "";
}

/** Installer's default install location for the jbcontext CLI. */
export const DEFAULT_BIN_PATH = `${homedir()}/.jbcontext/bin/jbcontext`;

/** Official installer one-liner, shown when the CLI is missing. */
export const INSTALL_COMMAND =
	"curl -fsSL https://download.jetbrains.com/jetbrains-context/release/download-jbcontext.sh | bash";

/**
 * Resolve the jbcontext binary by walking `process.env.PATH` explicitly
 * (accessSync on a bare name checks the process cwd, not PATH), then the
 * installer's default location. Returns an absolute path, or null when the
 * CLI is not installed. Check-time-only validation: the binary can still
 * change between this check and any later spawn (index execution reports
 * spawn failures; opencode owns MCP server startup).
 */
export function resolveBinaryPath(): string | null {
	const pathEnv = process.env.PATH ?? "";
	const candidates = [
		...pathEnv
			.split(":")
			.filter(Boolean)
			// POSIX shells treat an empty segment as cwd; skipping it (and any
			// relative dir) keeps every candidate absolute and eliminates the
			// cwd channel entirely.
			.filter((dir) => dir.startsWith("/"))
			.map((dir) => `${dir}/jbcontext`),
		DEFAULT_BIN_PATH,
	];
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not usable; try the next candidate.
		}
	}
	return null;
}

export type ServerMatch = {
	matchCount: number;
	serverName: string | null;
	binPath: string | null;
	matchNames: string[];
};

/**
 * Pure: scan merged config for jbcontext MCP servers by binary basename.
 * Matches the binary at argv[0] or argv[1] — the latter covers wrapper
 * invocations like `["npx", "jbcontext", "mcp"]` or `["/usr/bin/env",
 * "jbcontext", "mcp"]`. By default only enabled local servers match; with
 * `includeDisabled`, disabled local servers match too (used to respect
 * explicit keep-it-off entries regardless of their config key). V2 uses
 * `disabled`; v1 uses `enabled: false`. Remote
 * entries are invisible to both scans by design — they are respected via
 * the key-existence guard during registration, not basename matching.
 */
export function findJbcontextServer(
	config: unknown,
	options: { includeDisabled?: boolean } = {},
): ServerMatch {
	const matches: Array<{ name: string; binPath: string }> = [];
	const mcp = (config as { mcp?: unknown } | null | undefined)?.mcp;
	if (mcp && typeof mcp === "object") {
		for (const [name, entry] of Object.entries(mcp as Record<string, unknown>)) {
			const server = entry as
				| { type?: unknown; disabled?: unknown; enabled?: unknown; command?: unknown }
				| null
				| undefined;
			if (server?.type !== "local") continue;
			if (!options.includeDisabled && (server.disabled === true || server.enabled === false)) continue;
			const cmd = server?.command;
			if (!Array.isArray(cmd) || cmd.length === 0) continue;
			const isJbcontext = cmd
				.slice(0, 2)
				.some((arg) => basename(String(arg)) === "jbcontext");
			if (isJbcontext) {
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
	/** Log diagnostics without blocking indexing. */
	log: Log;
	/** Resolve the working directory for a session (host lookup with fallback). */
	getSessionDirectory: (sessionID: string) => Promise<string>;
	/** Run jbcontext index. Throws on failure. Returns the CLI output. */
	runIndex: (bin: string, root: string) => Promise<string>;
	/** Resolve the jbcontext binary path, or null when not installed. */
	resolveBinary?: () => string | null;
};

/**
 * Build the plugin behavior given resolved dependencies. Split out from the
 * host adapters so the hooks are testable without the opencode runtime.
 */
export function createHooks(deps: JbcontextPluginDeps) {
	// --- state (per opencode process) ---
	let enabled = false;
	let serverName: string | null = null;
	let binPath: string | null = null;
	// in-flight index promises keyed by directory path (resolves to CLI output)
	const indexingPromises = new Map<string, Promise<string>>();
	// sessions whose first prompt already triggered an index (per process)
	const promptIndexed = new Set<string>();

	/**
	 * Index the directory, deduplicating concurrent runs for the same path
	 * (a caller joining an in-flight run gets that run's output). Always
	 * indexes — there is no throttle window. Keyed by directory alone: a
	 * burst of session creations for the same directory (subagents spawning)
	 * must share one run regardless of session. jbcontext resolves the git
	 * root itself when the directory is inside one.
	 */
	const indexRepo = (bin: string, root: string): Promise<string> => {
		const key = root;

		const existing = indexingPromises.get(key);
		if (existing) {
			return existing;
		}

		// Register the in-flight promise synchronously, before any await, so
		// concurrent callers can never both pass the check above.
		// Diagnostics must not prevent the index from starting if logging fails.
		void Promise.resolve()
			.then(() => deps.log("info", `jbcontext: indexing ${root}…`, { root, decision: "index" }))
			.catch(() => {});
		const promise = Promise.resolve()
			.then(() => deps.runIndex(bin, root))
			.finally(() => {
				indexingPromises.delete(key);
			});

		indexingPromises.set(key, promise);
		return promise;
	};

	/**
	 * Join an in-flight index for the directory if one is running. Never
	 * starts a new index — indexing is triggered by session creation and the
	 * manual tool only (Codex SessionStart-hook parity).
	 */
	const joinIndex = (root: string): Promise<string> => {
		const existing = indexingPromises.get(root);
		return existing ?? Promise.resolve("");
	};

	return {
		// Detect or register the jbcontext server in either host API.
		// - An existing enabled jbcontext server in the merged config wins
		//   (never override user config).
		// - Otherwise, resolve the binary (PATH, then the installer's default
		//   location) and register a `jbcontext` MCP entry before servers load.
		// - When the CLI is missing entirely, warn with the install
		//   command and stay inactive.
		configureServer: (editor: ServerEditor) => {
			// The editor contains the merged MCP entries. `set` replaces entries,
			// so only call it after checking every existing name.
			let mcpSnapshot: Record<string, unknown>;
			try {
				mcpSnapshot = Object.fromEntries(editor.list());
			} catch {
				// An unreadable configuration must never trigger registration.
				enabled = false;
				serverName = null;
				binPath = null;
				return;
			}
			enabled = false;
			serverName = null;
			binPath = null;
			const match = findJbcontextServer({ mcp: mcpSnapshot });
			if (match.matchCount > 1) {
				throw new Error(
					`jbcontext-index plugin: multiple enabled jbcontext MCP servers found (${match.matchNames.join(", ")}); configure exactly one.`,
				);
			}
			if (match.matchCount === 1) {
				enabled = true;
				serverName = match.serverName;
				const matchedBin = match.binPath as string;
				binPath = matchedBin;
				// Wrapper adoption: when the matched command's argv[0] is a
				// wrapper (npx, env, …) rather than the jbcontext binary
				// itself, the plugin's index runs must invoke the real binary,
				// not the wrapper (`npx index …` would fail). Resolve it; if
				// unavailable, degrade to inactive — the user's MCP server
				// still runs, only the plugin's index triggers no-op.
				if (basename(matchedBin) !== "jbcontext") {
					const resolved = (deps.resolveBinary ?? resolveBinaryPath)();
					if (!resolved) {
						const adoptedServer = serverName;
						enabled = false;
						serverName = null;
						binPath = null;
						void deps.log(
							"warn",
							`jbcontext: MCP server "${adoptedServer}" uses a wrapper command ("${matchedBin} …") but the jbcontext binary was not found for indexing (checked PATH and ${DEFAULT_BIN_PATH}). Install it with: ${INSTALL_COMMAND}`,
							{
								serverName: adoptedServer,
								wrapper: matchedBin,
								decision: "cli-missing",
								installCommand: INSTALL_COMMAND,
							},
						).catch(() => {});
						return;
					}
					binPath = resolved;
				}
				return;
			}
			// No enabled jbcontext server. Before auto-registering, respect any
			// user-configured disabled jbcontext entry regardless of its config
			// key — an explicit "keep it off" decision must not be silently
			// reversed by registering a new enabled server alongside it.
			const disabled = findJbcontextServer({ mcp: mcpSnapshot }, {
				includeDisabled: true,
			});
			if (disabled.matchCount > 0) {
				enabled = false;
				return;
			}
			// No existing jbcontext server: auto-register one. Final safety net:
			// never write under the literal "jbcontext" key if the user has any
			// entry there — remote entries are invisible to the basename scans
			// by design (they are respected via this key-existence guard, not
			// basename matching), and any shape under that key is user intent.
			if (Object.prototype.hasOwnProperty.call(mcpSnapshot, "jbcontext")) {
				enabled = false;
				return;
			}
			const resolved = (deps.resolveBinary ?? resolveBinaryPath)();
			if (!resolved) {
				enabled = false;
				void deps.log(
					"warn",
					`jbcontext: CLI not found (checked PATH and ${DEFAULT_BIN_PATH}); jbcontext MCP server not registered. Install it with: ${INSTALL_COMMAND}`,
					{ decision: "cli-missing", installCommand: INSTALL_COMMAND },
				).catch(() => {});
				return;
			}
			try {
				editor.set("jbcontext", { type: "local", command: [resolved, "mcp"] });
				enabled = true;
				serverName = "jbcontext";
				binPath = resolved;
			} catch {
				// An unwritable editor must not leave indexing active.
				enabled = false;
			}
		},

		// First user prompt in a session: kick off a background index, Codex
		// SessionStart-hook style (`startup|resume` parity — a resumed session
		// keeps its sessionID, so the per-session guard fires exactly once per
		// session per opencode process, covering new and resumed sessions
		// alike). Fire-and-forget — never awaited, never blocks the prompt.
		// Routed through indexRepo so concurrent triggers for the same
		// directory (subagent bursts) share one run, and so pre-search joins
		// can see the in-flight index.
		onPrompt: async (input: { sessionID: string }) => {
			if (!enabled || !serverName || !binPath) return;
			if (promptIndexed.has(input.sessionID)) return;
			promptIndexed.add(input.sessionID);
			try {
				const dir = await deps.getSessionDirectory(input.sessionID);
				void indexRepo(binPath, dir).catch(async (err: unknown) => {
					await deps.log(
						"debug",
						`jbcontext: background session-start indexing failed, proceeding without it`,
						{
							root: dir,
							sessionID: input.sessionID,
							error: err instanceof Error ? err.message : String(err),
						},
					).catch(() => {});
				});
			} catch (err) {
				// getSessionDirectory falls back internally; this only fires on
				// unexpected internal errors.
				await deps.log(
					"debug",
					`jbcontext: could not resolve session directory at first prompt, skipping background index`,
					{
						sessionID: input.sessionID,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		},

		// Lazy: fires before every tool call; only acts on ${serverName}_code_search.
		// Join-only: waits for an in-flight index (so the search sees fresh
		// content) but never starts one. Errors are logged and swallowed so
		// code_search can still run against any existing index.
		beforeSearch: async (input: { tool: string; sessionID: string }) => {
			if (!enabled || !serverName || !binPath) return;
			if (input.tool !== `${serverName}_code_search`) return;

			try {
				const dir = await deps.getSessionDirectory(input.sessionID);
				await joinIndex(dir);
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

		// V1 passes its tool-context directory; v2 resolves one from sessionID.
		// Errors propagate to the manual tool caller.
		indexManual: async (sessionID: string, directory?: string): Promise<string> => {
			if (!enabled || !binPath) {
				return "jbcontext-index plugin is not active (no enabled jbcontext MCP server found in config).";
			}
			const dir = directory ?? await deps.getSessionDirectory(sessionID);
			return indexRepo(binPath, dir);
		},
	};
}

/** Both hosts run the same argv-only index command and report its output. */
function createRunIndex(log: Log): JbcontextPluginDeps["runIndex"] {
	return async (bin, root) => {
		const start = Date.now();
		let out: { exitCode: number | null; stdout: string; stderr: string };
		try {
			out = await new Promise<typeof out>((resolve, reject) => {
				const child = spawn(bin, ["index", `--project-path=${root}`], {
					cwd: root,
					stdio: ["ignore", "pipe", "pipe"],
				});
				const stdout: string[] = [];
				const stderr: string[] = [];
				child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
				child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
				child.once("error", reject);
				child.once("close", (exitCode) => {
					resolve({ exitCode, stdout: stdout.join(""), stderr: stderr.join("") });
				});
			});
		} catch (err) {
			const ms = Date.now() - start;
			const error = err instanceof Error ? err.message : String(err);
			await log("error", `jbcontext: indexing failed for ${root} in ${ms}ms`, {
				root,
				ms,
				error,
			});
			throw new Error(`jbcontext-index: indexing failed for "${root}": ${error}`);
		}
		const ms = Date.now() - start;
		if (out.exitCode !== 0) {
			const stderr = out.stderr.trim();
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
		const stdout = out.stdout.trim();
		const stderr = out.stderr.trim();
		return (
			[stdout, stderr].filter(Boolean).join("\n") ||
			`jbcontext: indexed ${root} in ${ms}ms`
		);
	};
}

/** Cache successful session directories, but retry missing sessions next time. */
function createSessionDirectoryResolver(
	lookup: (sessionID: string) => Promise<string | undefined>,
	fallback: string,
	log: Log,
): JbcontextPluginDeps["getSessionDirectory"] {
	const cache = new Map<string, string>();
	return async (sessionID) => {
		const cached = cache.get(sessionID);
		if (cached) return cached;
		try {
			const dir = await lookup(sessionID);
			if (dir) {
				cache.set(sessionID, dir);
				return dir;
			}
			await log(
				"warn",
				`jbcontext: session ${sessionID} has no directory, falling back to init directory`,
				{ sessionID, fallback },
			);
		} catch (err) {
			await log(
				"warn",
				`jbcontext: could not resolve session directory for ${sessionID}, falling back to init directory`,
				{
					sessionID,
					fallback,
					error: err instanceof Error ? err.message : String(err),
				},
			);
		}
		return fallback;
	};
}

async function setupPlugin(ctx: Plugin.Context): Promise<void> {
	/** V2 has no logging API; diagnostics must not block indexing. */
	const log: Log = async (level, message, extra) => {
		try {
			console[level](message, extra);
		} catch {
			// Logging must not affect the index or search hooks.
		}
	};

	const hooks = createHooks({
		log,
		getSessionDirectory: createSessionDirectoryResolver(
			async (sessionID) => (await ctx.session.get({ sessionID }))?.location?.directory,
			ctx.location.directory,
			log,
		),
		runIndex: createRunIndex(log),
	});
	await ctx.mcp.transform(hooks.configureServer);
	await ctx.session.hook("prompt", hooks.onPrompt);
	await ctx.tool.hook("execute.before", hooks.beforeSearch);
	await ctx.tool.transform((editor) => {
		editor.add({
			name: "jbcontext_index",
			description: INDEX_DESCRIPTION,
			input: { type: "object", properties: {}, additionalProperties: false },
			async execute(_input, context) {
				return { content: await hooks.indexManual(context.sessionID) };
			},
		});
	});
}

/** V1 receives SDK and tool-context values from the host rather than v2 domains. */
const server: V1Plugin = async ({ client, directory }) => {
	const log: Log = async (level, message, extra) => {
		try {
			await client.app.log({
				body: { service: "opencode-jbcontext", level, message, extra },
			});
		} catch {
			// Logging must not affect the index or search hooks.
		}
	};
	const hooks = createHooks({
		log,
		getSessionDirectory: createSessionDirectoryResolver(
			async (sessionID) => (await client.session.get({ path: { id: sessionID } })).data?.directory,
			directory,
			log,
		),
		runIndex: createRunIndex(log),
	});

	const legacyHooks: V1Hooks = {
		config: async (cfg) => {
			hooks.configureServer({
				list: () => Object.entries(cfg.mcp ?? {}),
				set: (name, value) => {
					const mcp = (cfg.mcp ??= {});
					// V1 mutates the merged config; never overwrite an entry that
					// appeared since the snapshot (including inherited keys).
					if (name in mcp) throw new Error(`jbcontext: MCP entry "${name}" already exists`);
					mcp[name] = value;
				},
			});
		},
		"chat.message": hooks.onPrompt,
		"tool.execute.before": hooks.beforeSearch,
		tool: {
			jbcontext_index: {
				description: INDEX_DESCRIPTION,
				args: {},
				execute: async (_args, context) => hooks.indexManual(context.sessionID, context.directory),
			},
		},
	};
	return legacyHooks;
};

export const jbcontextPlugin = {
	...Plugin.define({ id: "opencode-jbcontext", setup: setupPlugin }),
	server,
};

export default jbcontextPlugin;
