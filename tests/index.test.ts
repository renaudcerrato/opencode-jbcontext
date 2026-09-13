/**
 * Tests for the opencode-jbcontext plugin.
 *
 * The plugin factory (jbcontextPlugin) wires opencode SDK dependencies
 * (client, $ shell, directory) into createHooks; tests exercise createHooks
 * directly with mock deps, plus the pure helpers (basename,
 * findJbcontextServer) and the SDK-wiring paths of the factory via mocked
 * client/$ objects.
 */

import fs from "node:fs";
import {
	basename,
	createHooks,
	findJbcontextServer,
	INSTALL_COMMAND,
	jbcontextPlugin,
	DEFAULT_BIN_PATH,
	resolveBinaryPath,
	type JbcontextPluginDeps,
} from "../src/index";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type LogCall = {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	extra: Record<string, unknown>;
};

function makeDeps(overrides: Partial<JbcontextPluginDeps> = {}) {
	const logCalls: LogCall[] = [];
	const deps: JbcontextPluginDeps & {
		logCalls: LogCall[];
		gitRootCalls: string[];
		runIndexCalls: Array<{ bin: string; root: string }>;
		sessionDirCalls: string[];
	} = {
		logCalls,
		gitRootCalls: [],
		runIndexCalls: [],
		sessionDirCalls: [],
		log: async (level, message, extra = {}) => {
			logCalls.push({ level, message, extra });
		},
		getGitRoot: async (cwd: string) => {
			deps.gitRootCalls.push(cwd);
			return `/git${cwd}`;
		},
		getSessionDirectory: async (sessionID: string) => {
			deps.sessionDirCalls.push(sessionID);
			return `/session/${sessionID}`;
		},
		runIndex: async (bin: string, root: string) => {
			deps.runIndexCalls.push({ bin, root });
			return `indexed ${root}`;
		},
		...overrides,
	};
	return deps;
}

/** Deferred promise handle for controlling runIndex resolution order. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const CONFIG_ONE = {
	mcp: {
		jbcontext: {
			type: "local",
			command: ["/usr/local/bin/jbcontext", "mcp"],
		},
	},
};

const sessionCreatedEvent = (id: string, directory: string) => ({
	type: "session.created",
	properties: { info: { id, directory } },
});

// ---------------------------------------------------------------------------
// basename
// ---------------------------------------------------------------------------

describe("basename", () => {
	it("returns the last path segment", () => {
		expect(basename("/usr/local/bin/jbcontext")).toBe("jbcontext");
	});

	it("returns the input when there is no slash", () => {
		expect(basename("jbcontext")).toBe("jbcontext");
	});

	it("returns empty string for empty input", () => {
		expect(basename("")).toBe("");
	});

	it("returns the last non-empty segment", () => {
		expect(basename("/usr/bin/")).toBe("bin");
	});
});

// ---------------------------------------------------------------------------
// findJbcontextServer
// ---------------------------------------------------------------------------

describe("findJbcontextServer", () => {
	it("returns no match for null/undefined config", () => {
		expect(findJbcontextServer(null)).toEqual({
			matchCount: 0,
			serverName: null,
			binPath: null,
			matchNames: [],
		});
		expect(findJbcontextServer(undefined)).toEqual({
			matchCount: 0,
			serverName: null,
			binPath: null,
			matchNames: [],
		});
	});

	it("returns no match when mcp is not an object", () => {
		expect(findJbcontextServer({ mcp: "nope" }).matchCount).toBe(0);
		expect(findJbcontextServer({}).matchCount).toBe(0);
	});

	it("returns no match when there is no jbcontext server", () => {
		const config = {
			mcp: {
				other: { type: "local", command: ["/bin/other"] },
			},
		};
		expect(findJbcontextServer(config).matchCount).toBe(0);
	});

	it("matches a local enabled jbcontext server by binary basename", () => {
		const match = findJbcontextServer(CONFIG_ONE);
		expect(match).toEqual({
			matchCount: 1,
			serverName: "jbcontext",
			binPath: "/usr/local/bin/jbcontext",
			matchNames: ["jbcontext"],
		});
	});

	it("skips remote servers", () => {
		const config = {
			mcp: {
				jbcontext: { type: "remote", url: "https://example.com" },
			},
		};
		expect(findJbcontextServer(config).matchCount).toBe(0);
	});

	it("skips explicitly disabled servers", () => {
		const config = {
			mcp: {
				jbcontext: {
					type: "local",
					enabled: false,
					command: ["/bin/jbcontext"],
				},
			},
		};
		expect(findJbcontextServer(config).matchCount).toBe(0);
	});

	it("skips servers with missing, empty, or non-array command", () => {
		expect(
			findJbcontextServer({
				mcp: { jbcontext: { type: "local" } },
			}).matchCount,
		).toBe(0);
		expect(
			findJbcontextServer({
				mcp: { jbcontext: { type: "local", command: [] } },
			}).matchCount,
		).toBe(0);
		expect(
			findJbcontextServer({
				mcp: { jbcontext: { type: "local", command: "jbcontext" } },
			}).matchCount,
		).toBe(0);
	});

	it("skips servers whose binary basename is not jbcontext", () => {
		const config = {
			mcp: {
				jb: { type: "local", command: ["/bin/jbcontext-wrapper"] },
			},
		};
		expect(findJbcontextServer(config).matchCount).toBe(0);
	});

	it("reports multiple matches without picking one", () => {
		const config = {
			mcp: {
				jb1: { type: "local", command: ["/bin/jbcontext"] },
				jb2: { type: "local", command: ["/opt/jbcontext"] },
			},
		};
		const match = findJbcontextServer(config);
		expect(match.matchCount).toBe(2);
		expect(match.serverName).toBeNull();
		expect(match.binPath).toBeNull();
		expect(match.matchNames).toEqual(["jb1", "jb2"]);
	});

	it("handles null entries in the mcp map", () => {
		const config = { mcp: { jbcontext: null } };
		expect(findJbcontextServer(config).matchCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// resolveBinaryPath
// ---------------------------------------------------------------------------

describe("resolveBinaryPath", () => {
	const originalAccess = fs.accessSync;

	afterEach(() => {
		fs.accessSync = originalAccess;
	});

	it("returns the first usable candidate (PATH binary)", () => {
		fs.accessSync = (p: any) => {
			if (p === "jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("jbcontext");
	});

	it("falls back to the installer default path when PATH lacks the binary", () => {
		fs.accessSync = (p: any) => {
			if (p === DEFAULT_BIN_PATH) return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe(DEFAULT_BIN_PATH);
	});

	it("returns null when no candidate is usable", () => {
		fs.accessSync = () => {
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// createHooks — config hook
// ---------------------------------------------------------------------------

describe("createHooks config", () => {
	it("auto-registers the MCP server when none is configured and the CLI exists", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		const cfg: Record<string, unknown> = {};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: resolveBinaryPath(),
		});
		expect((cfg.mcp as Record<string, unknown>).jbcontext).toEqual({
			type: "local",
			command: [resolveBinaryPath(), "mcp"],
		});
	});

	it("warns once and stays inactive when the CLI is missing", async () => {
		const deps = makeDeps({ resolveBinary: () => null });
		const hooks = createHooks(deps);
		const cfg: Record<string, unknown> = {};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(cfg.mcp).toBeUndefined();
		expect(deps.logCalls).toHaveLength(1);
		expect(deps.logCalls[0].level).toBe("warn");
		expect(deps.logCalls[0].message).toContain(INSTALL_COMMAND);
		expect(deps.logCalls[0].extra).toEqual({
			decision: "cli-missing",
			installCommand: INSTALL_COMMAND,
		});
	});

	it("stays inactive when the config shape is hostile (throwing getters)", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		const cfg = {};
		Object.defineProperty(cfg, "mcp", {
			get() {
				throw new TypeError("hostile getter");
			},
			configurable: true,
		});
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("tolerates a frozen config when auto-registering", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		// A frozen config: mcp exists (empty) but is sealed against writes.
		const cfg = { mcp: Object.freeze({}) as Record<string, unknown> };
		// In strict mode, assigning to a frozen object throws.
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
	});

	it("enables itself when exactly one jbcontext server is configured", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: "/usr/local/bin/jbcontext",
		});
	});

	it("never overrides an existing jbcontext server", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		const cfg = JSON.parse(JSON.stringify(CONFIG_ONE)) as Record<string, any>;
		await hooks.config(cfg as never);
		expect(cfg.mcp.jbcontext.command).toEqual(["/usr/local/bin/jbcontext", "mcp"]);
	});

	it("throws when multiple enabled jbcontext servers are configured", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		const config = {
			mcp: {
				jb1: { type: "local", command: ["/bin/jbcontext"] },
				jb2: { type: "local", command: ["/opt/jbcontext"] },
			},
		};
		await expect(hooks.config(config as never)).rejects.toThrow(
			/multiple enabled jbcontext MCP servers found \(jb1, jb2\)/,
		);
	});
});

// ---------------------------------------------------------------------------
// createHooks — event hook (session.created)
// ---------------------------------------------------------------------------

describe("createHooks event", () => {
	it("does nothing when disabled", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		expect(deps.gitRootCalls).toEqual([]);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("does nothing for non-session.created events", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({
			event: { type: "session.idle", properties: { sessionID: "s1" } },
		} as never);
		expect(deps.gitRootCalls).toEqual([]);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("indexes in the background on session.created without awaiting", async () => {
		const gate = deferred<string>();
		const deps = makeDeps({
			runIndex: async () => {
				deps.runIndexCalls.push({ bin: "/usr/local/bin/jbcontext", root: "/git/repo" });
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		// The event hook resolved without waiting for runIndex (still pending).
		expect(deps.gitRootCalls).toEqual(["/repo"]);
		expect(deps.runIndexCalls).toEqual([
			{ bin: "/usr/local/bin/jbcontext", root: "/git/repo" },
		]);

		gate.resolve("done");
		await gate.promise;
	});

	it("deduplicates concurrent session-start indexes for the same repo (burst protection)", async () => {
		const gate = deferred<string>();
		let runCount = 0;
		const deps = makeDeps({
			runIndex: async () => {
				runCount += 1;
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// A burst of session creations for the same repo (subagents spawning).
		const first = hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		const second = hooks.event({ event: sessionCreatedEvent("s2", "/repo") } as never);
		await Promise.all([first, second]);
		// Both fire-and-forget runs share one in-flight index.
		expect(runCount).toBe(1);

		// A search during the burst joins the session-start index.
		const search = hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		gate.resolve("done");
		await Promise.all([search, gate.promise]);
		expect(runCount).toBe(1);
	});

	it("ignores malformed session.created events without info.directory", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({
			event: { type: "session.created", properties: {} },
		} as never);
		await hooks.event({
			event: { type: "session.created", properties: { info: {} } },
		} as never);
		expect(deps.gitRootCalls).toEqual([]);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("logs and swallows background index failures", async () => {
		const deps = makeDeps({
			runIndex: async () => {
				throw new Error("boom");
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		// Allow the fire-and-forget rejection handler to run.
		await new Promise((r) => setImmediate(r));
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				level: "debug",
				message: expect.stringContaining("background session-start indexing failed"),
				extra: expect.objectContaining({
					root: "/git/repo",
					sessionID: "s1",
					error: "boom",
				}),
			}),
		);
	});

	it("logs and swallows git-root resolution failures", async () => {
		const deps = makeDeps({
			getGitRoot: async () => {
				throw new Error("not a git repo");
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		expect(deps.runIndexCalls).toEqual([]);
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				level: "debug",
				message: expect.stringContaining("could not resolve git root at session start"),
				extra: expect.objectContaining({
					directory: "/repo",
					sessionID: "s1",
					error: "not a git repo",
				}),
			}),
		);
	});

	it("stringifies non-Error git-root failure reasons", async () => {
		const deps = makeDeps({
			getGitRoot: async () => {
				throw "plain-string-failure";
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				extra: expect.objectContaining({ error: "plain-string-failure" }),
			}),
		);
	});

	it("stringifies non-Error rejection reasons", async () => {
		const deps = makeDeps({
			runIndex: async () => {
				throw "plain-string-failure";
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		// Allow the fire-and-forget rejection handler to run.
		await new Promise((r) => setImmediate(r));
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				extra: expect.objectContaining({ error: "plain-string-failure" }),
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// createHooks — tool.execute.before (pre-search)
// ---------------------------------------------------------------------------

describe("createHooks tool.execute.before", () => {
	it("does nothing when disabled", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("does nothing for other tools", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks["tool.execute.before"]({
			tool: "read",
			sessionID: "s1",
		} as never);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("resolves the session directory and git root before a code_search call", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		// Join-only: the session dir and git root are resolved (so a manual
		// index started concurrently can be joined), but no index is started.
		expect(deps.sessionDirCalls).toEqual(["s1"]);
		expect(deps.gitRootCalls).toEqual(["/session/s1"]);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("joins an in-flight index for the same session+repo instead of re-running", async () => {
		const gate = deferred<string>();
		let runCount = 0;
		const deps = makeDeps({
			runIndex: async () => {
				runCount += 1;
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// Start an index via the manual tool (the only path that starts one).
		const manual = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/session/s1", sessionID: "s1" },
		);
		// A concurrent search joins the in-flight run instead of starting one.
		const search = hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		// Both callers await the same in-flight run; release it.
		gate.resolve("done");
		await Promise.all([manual, search]);
		expect(runCount).toBe(1);
	});

	it("deduplicates concurrent manual index runs for the same session+repo", async () => {
		const gate = deferred<string>();
		let runCount = 0;
		const deps = makeDeps({
			runIndex: async () => {
				runCount += 1;
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		const first = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/session/s1", sessionID: "s1" },
		);
		const second = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/session/s1", sessionID: "s1" },
		);
		gate.resolve("done");
		const [firstOut, secondOut] = await Promise.all([first, second]);
		expect(runCount).toBe(1);
		expect(secondOut).toBe(firstOut);
	});

	it("proceeds immediately when no index is in flight (join-only, never starts one)", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		// No index was started by the pre-search hook.
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("logs and swallows pre-search failures", async () => {
		const deps = makeDeps({
			getGitRoot: async () => {
				throw new Error("git failed");
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: expect.stringContaining("pre-search indexing failed"),
				extra: expect.objectContaining({
					sessionID: "s1",
					tool: "jbcontext_code_search",
					error: "git failed",
				}),
			}),
		);
	});

	it("stringifies non-Error pre-search failure reasons", async () => {
		const deps = makeDeps({
			getSessionDirectory: async () => {
				throw 42;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		expect(deps.logCalls).toContainEqual(
			expect.objectContaining({
				extra: expect.objectContaining({ error: "42" }),
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// createHooks — manual jbcontext_index tool
// ---------------------------------------------------------------------------

describe("createHooks jbcontext_index tool", () => {
	it("reports inactivity when no jbcontext server is configured", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		const result = await hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s1" },
		);
		expect(result).toBe(
			"jbcontext-index plugin is not active (no enabled jbcontext MCP server found in config).",
		);
		expect(deps.runIndexCalls).toEqual([]);
	});

	it("indexes on demand and returns the CLI output", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		const result = await hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s1" },
		);
		expect(result).toBe("indexed /git/repo");
		expect(deps.runIndexCalls).toEqual([
			{ bin: "/usr/local/bin/jbcontext", root: "/git/repo" },
		]);
	});

	it("propagates failures to the caller", async () => {
		const deps = makeDeps({
			runIndex: async () => {
				throw new Error("index exploded");
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await expect(
			hooks.tool.jbcontext_index.execute({}, { directory: "/repo", sessionID: "s1" }),
		).rejects.toThrow("index exploded");
	});
});

// ---------------------------------------------------------------------------
// jbcontextPlugin — SDK wiring
// ---------------------------------------------------------------------------

describe("jbcontextPlugin", () => {
	function makeClient(logCalls: LogCall[], sessionDirs: Record<string, string>) {
		return {
			app: {
				log: async (input: { body: LogCall }) => {
					logCalls.push(input.body);
				},
			},
			session: {
				get: async ({ path }: { path: { id: string } }) => {
					const dir = sessionDirs[path.id];
					if (dir === undefined) {
						throw new Error("session not found");
					}
					return { data: { directory: dir } };
				},
			},
		};
	}

	function makeShell(commands: Record<string, { stdout: string; stderr: string; exitCode: number }>) {
		const shellCalls: string[] = [];
		const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
			const cmd = strings
				.flatMap((s, i) => (i < values.length ? [s, String(values[i])] : [s]))
				.join("")
				.trim();
			shellCalls.push(cmd);
			const result = commands[cmd] ?? { stdout: "", stderr: "", exitCode: 1 };
			return {
				nothrow: () => ({
					quiet: async () => ({
						stdout: Buffer.from(result.stdout),
						stderr: Buffer.from(result.stderr),
						exitCode: result.exitCode,
					}),
				}),
			};
		};
		return { $, shellCalls };
	}

	it("wires the SDK: session dir lookup, git root, and index run", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "indexing…\n",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);
		// The manual tool exercises the full SDK wiring (session-start events
		// and searches never start an index).
		await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);

		expect(shellCalls).toEqual([
			"git -C /session/dir rev-parse --show-toplevel",
			"/usr/local/bin/jbcontext index --project-path=/git/root",
		]);
	});

	it("caches git roots and session directories across calls", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		for (let i = 0; i < 3; i += 1) {
			await (
				plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
			)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		}

		// One git lookup, one session lookup, but an index run per call.
		expect(
			shellCalls.filter((c) => c.startsWith("git -C")),
		).toHaveLength(1);
		expect(
			shellCalls.filter((c) => c.startsWith("/usr/local/bin/jbcontext index")),
		).toHaveLength(3);
	});

	it("caches session directories across searches for the same session", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// First search resolves and caches the session directory; a second
		// search hits the session-dir cache, and a manual index for the same
		// root hits the git-root cache.
		const search1 = plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		const manual = (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		await Promise.all([search1, manual]);
		const search2 = plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		await search2;

		expect(
			shellCalls.filter((c) => c.startsWith("git -C")),
		).toHaveLength(1);
	});

	it("falls back to the init directory when the session lookup fails", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, {});
		const { $, shellCalls } = makeShell({
			"git -C /init/dir rev-parse --show-toplevel": {
				stdout: "/git/init\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/init": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// Start a manual index for the init-dir root, then let a search for the
		// unknown session join it — the search resolves the session directory
		// (falling back to the init dir) and the same git root.
		const manual = (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/init/dir", sessionID: "manual" } as never);
		const search = plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "missing",
		} as never);
		await Promise.all([manual, search]);

		expect(shellCalls[0]).toBe("git -C /init/dir rev-parse --show-toplevel");
		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: expect.stringContaining("could not resolve session directory"),
			}),
		);
	});

	it("falls back to the init directory when the session has no directory", async () => {
		const logCalls: LogCall[] = [];
		const client = {
			app: {
				log: async (input: { body: LogCall }) => {
					logCalls.push(input.body);
				},
			},
			session: {
				get: async () => ({ data: {} }),
			},
		};
		const { $, shellCalls } = makeShell({
			"git -C /init/dir rev-parse --show-toplevel": {
				stdout: "/git/init\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/init": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// Start a manual index for the init-dir root, then let a search join it;
		// the session record has no directory, exercising the fallback path.
		const manual = (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/init/dir", sessionID: "manual" } as never);
		const search = plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		await Promise.all([manual, search]);

		expect(shellCalls[0]).toBe("git -C /init/dir rev-parse --show-toplevel");
		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "warn",
				message: expect.stringContaining("has no directory"),
			}),
		);
	});

	it("falls back to the init directory when the session lookup throws a non-Error", async () => {
		const logCalls: LogCall[] = [];
		const client = {
			app: {
				log: async (input: { body: LogCall }) => {
					logCalls.push(input.body);
				},
			},
			session: {
				get: async () => {
					throw "non-error rejection";
				},
			},
		};
		const { $, shellCalls } = makeShell({
			"git -C /init/dir rev-parse --show-toplevel": {
				stdout: "/git/init\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/init": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// Start a manual index for the init-dir root, then let a search join it;
		// the session lookup throws a non-Error, exercising the String(err) path.
		const manual = (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/init/dir", sessionID: "manual" } as never);
		const search = plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);
		await Promise.all([manual, search]);

		expect(shellCalls[0]).toBe("git -C /init/dir rev-parse --show-toplevel");
		expect(logCalls).toContainEqual(
			expect.objectContaining({
				extra: expect.objectContaining({ error: "non-error rejection" }),
			}),
		);
	});

	it("throws a descriptive error when the git root cannot be resolved", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "fatal: not a git repository",
				exitCode: 128,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// The manual tool propagates the git-root failure.
		await expect(
			(plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>)(
				{} as never,
				{ directory: "/session/dir", sessionID: "s1" } as never,
			),
		).rejects.toThrow(/could not determine git root/);

		// A search for the same session joins nothing (no in-flight index) and
		// logs the swallowed git-root failure.
		await plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);

		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: expect.stringContaining("pre-search indexing failed"),
				extra: expect.objectContaining({
					error: expect.stringContaining("could not determine git root"),
				}),
			}),
		);
	});

	it("throws a descriptive error when git output is empty but successful", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		await expect(
			(plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>)(
				{} as never,
				{ directory: "/session/dir", sessionID: "s1" } as never,
			),
		).rejects.toThrow(/could not determine git root/);

		// A search for the same session logs the swallowed git-root failure.
		await plugin["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);

		expect(logCalls).toContainEqual(
			expect.objectContaining({
				extra: expect.objectContaining({
					error: expect.stringContaining("could not determine git root"),
				}),
			}),
		);
	});

	it("reports failed index runs and throws with stderr in the message", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "auth required",
				exitCode: 1,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// The manual tool propagates the failure.
		await expect(
			(plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>)(
				{} as never,
				{ directory: "/session/dir", sessionID: "s1" } as never,
			),
		).rejects.toThrow(/indexing failed for "\/git\/root": auth required/);
		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "error",
				message: expect.stringContaining("indexing failed"),
			}),
		);
	});

	it("reports failed index runs with empty stderr", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		await expect(
			(plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>)(
				{} as never,
				{ directory: "/session/dir", sessionID: "s1" } as never,
			),
		).rejects.toThrow(/indexing failed for "\/git\/root"$/);
	});

	it("returns a fallback message when a successful index run has no output", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		const result = await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		expect(result).toMatch(/^jbcontext: indexed \/git\/root in \d+ms$/);
	});

	it("forwards combined stdout and stderr from a successful index run", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "uploaded snapshot",
				stderr: "warning: stale cache",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		const result = await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		expect(result).toBe("uploaded snapshot\nwarning: stale cache");
	});

	it("swallows log transport failures without unhandled rejections", async () => {
		const client = {
			app: {
				log: async () => {
					throw new Error("log transport down");
				},
			},
			session: {
				get: async () => ({ data: { directory: "/session/dir" } }),
			},
		};
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
		});

		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);

		await plugin.config(CONFIG_ONE as never);

		// Indexing succeeds even though every log call rejects.
		const result = await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		expect(result).toMatch(/^jbcontext: indexed \/git\/root in \d+ms$/);
	});

	it("exposes the manual tool with metadata", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, {});
		const { $ } = makeShell({});
		const plugin = await jbcontextPlugin({
			client: client as never,
			$,
			directory: "/init/dir",
		} as never);
		await plugin.config(CONFIG_ONE as never);
		expect(plugin.tool.jbcontext_index.description).toContain("jbcontext index");
		expect(plugin.tool.jbcontext_index.args).toEqual({});
	});
});