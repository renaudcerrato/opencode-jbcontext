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
		const result = commands[cmd];
		if (!result) {
			// Fail loudly on unmapped commands: a silent default would turn
			// command drift (refactored argv, renamed flags) into false passes.
			throw new Error(`makeShell: unmapped command: ${cmd}`);
		}
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
	const originalPath = process.env.PATH;

	afterEach(() => {
		fs.accessSync = originalAccess;
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
	});

	it("walks PATH directories in order and returns the first hit", () => {
		process.env.PATH = "/first/bin:/second/bin";
		fs.accessSync = (p: any) => {
			if (p === "/second/bin/jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("/second/bin/jbcontext");
	});

	it("prefers the first PATH directory containing the binary", () => {
		process.env.PATH = "/first/bin:/second/bin";
		fs.accessSync = (p: any) => {
			if (p === "/first/bin/jbcontext" || p === "/second/bin/jbcontext")
				return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("/first/bin/jbcontext");
	});

	it("falls back to the installer default path when PATH lacks the binary", () => {
		process.env.PATH = "/first/bin";
		fs.accessSync = (p: any) => {
			if (p === DEFAULT_BIN_PATH) return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe(DEFAULT_BIN_PATH);
	});

	it("skips empty PATH segments", () => {
		process.env.PATH = "::/first/bin::";
		fs.accessSync = (p: any) => {
			if (p === "/first/bin/jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("/first/bin/jbcontext");
	});

	it("skips relative PATH directories (never resolves against cwd)", () => {
		process.env.PATH = "relative/bin:/first/bin";
		fs.accessSync = (p: any) => {
			// A repo-controlled relative candidate would be usable — it must
			// never be consulted.
			if (p === "relative/bin/jbcontext") return undefined;
			if (p === "/first/bin/jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("/first/bin/jbcontext");
	});

	it("returns null when PATH has only relative dirs and the default is missing", () => {
		process.env.PATH = "relative/bin";
		fs.accessSync = () => {
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBeNull();
	});

	it("returns null when no candidate is usable", () => {
		process.env.PATH = "/first/bin";
		fs.accessSync = () => {
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBeNull();
	});

	it("returns null when PATH is unset and the default path is missing", () => {
		delete process.env.PATH;
		fs.accessSync = () => {
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBeNull();
	});

	it("ignores a non-executable file squatting a PATH slot (X_OK check)", () => {
		process.env.PATH = "/squat/bin:/real/bin";
		fs.accessSync = (p: any, mode?: number) => {
			if (p === "/squat/bin/jbcontext") {
				const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
				error.code = "EACCES";
				throw error;
			}
			if (p === "/real/bin/jbcontext" && mode === fs.constants.X_OK) return undefined;
			throw new Error("ENOENT");
		};
		expect(resolveBinaryPath()).toBe("/real/bin/jbcontext");
	});
});

// ---------------------------------------------------------------------------
// createHooks — config hook
// ---------------------------------------------------------------------------

describe("createHooks config", () => {
	it("auto-registers the MCP server when none is configured (injected binary)", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg: Record<string, unknown> = {};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: "/opt/jbcontext",
		});
		expect((cfg.mcp as Record<string, unknown>).jbcontext).toEqual({
			type: "local",
			command: ["/opt/jbcontext", "mcp"],
		});
	});

	it("auto-registers using the real resolver when deps.resolveBinary is not provided", async () => {
		// Hermetic: force the real resolver to find a hit via mocked fs.
		const originalAccess = fs.accessSync;
		const originalPath = process.env.PATH;
		process.env.PATH = "/resolved/bin";
		fs.accessSync = (p: any) => {
			if (p === "/resolved/bin/jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		try {
			const deps = makeDeps();
			const hooks = createHooks(deps);
			const cfg: Record<string, unknown> = {};
			await hooks.config(cfg as never);
			expect(hooks.__state()).toEqual({
				enabled: true,
				serverName: "jbcontext",
				binPath: "/resolved/bin/jbcontext",
			});
			expect((cfg.mcp as Record<string, unknown>).jbcontext).toEqual({
				type: "local",
				command: ["/resolved/bin/jbcontext", "mcp"],
			});
		} finally {
			fs.accessSync = originalAccess;
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});

	it("respects a disabled jbcontext-keyed entry (never override, even disabled)", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				jbcontext: { type: "local", enabled: false, command: ["/old/jbcontext"] },
			},
		};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		// The user's entry is untouched.
		expect(cfg.mcp.jbcontext).toEqual({
			type: "local",
			enabled: false,
			command: ["/old/jbcontext"],
		});
		expect(deps.logCalls).toEqual([]);
	});

	it("respects a disabled jbcontext entry under a custom key (basename-based)", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				"jetbrains-context": {
					type: "local",
					enabled: false,
					command: ["/opt/jbcontext"],
				},
			},
		};
		await hooks.config(cfg as never);
		// No new enabled server is registered alongside the disabled one.
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(Object.keys(cfg.mcp)).toEqual(["jetbrains-context"]);
		expect(deps.logCalls).toEqual([]);
	});

	it("auto-registers when a disabled non-jbcontext server exists", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				other: { type: "local", enabled: false, command: ["/bin/other"] },
			},
		};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: "/opt/jbcontext",
		});
		expect((cfg.mcp as Record<string, unknown>).jbcontext).toEqual({
			type: "local",
			command: ["/opt/jbcontext", "mcp"],
		});
	});

	it("respects a disabled remote entry under the jbcontext key (never clobbered)", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				jbcontext: { type: "remote", enabled: false, url: "https://example.com" },
			},
		};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(cfg.mcp.jbcontext).toEqual({
			type: "remote",
			enabled: false,
			url: "https://example.com",
		});
		expect(deps.logCalls).toEqual([]);
	});

	it("respects an enabled remote entry under the jbcontext key (never clobbered)", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				jbcontext: { type: "remote", url: "https://example.com" },
			},
		};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(cfg.mcp.jbcontext).toEqual({
			type: "remote",
			url: "https://example.com",
		});
		expect(deps.logCalls).toEqual([]);
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
		expect(deps.logCalls[0].extra).toEqual(
			expect.objectContaining({
				decision: "cli-missing",
				installCommand: INSTALL_COMMAND,
			}),
		);
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

	it("manual tool joins a session-start index for the same repo (cross-entry-point dedupe)", async () => {
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

		// Session-start index begins (fire-and-forget, minutes-long in reality).
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		expect(runCount).toBe(1);

		// The user asks for a refresh; the manual tool must join the
		// in-flight session-start run, not spawn a second one.
		const manual = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s2" },
		);
		gate.resolve("session-start output");
		const output = await manual;
		expect(runCount).toBe(1);
		expect(output).toBe("session-start output");
	});

	it("clears the in-flight entry after a failed run (no poisoned dedupe cache)", async () => {
		let runCount = 0;
		const deps = makeDeps({
			runIndex: async () => {
				runCount += 1;
				if (runCount === 1) throw new Error("auth expired");
				return `fresh index ${runCount}`;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// First run fails.
		await expect(
			hooks.tool.jbcontext_index.execute({}, { directory: "/repo", sessionID: "s1" }),
		).rejects.toThrow("auth expired");

		// A later retry must spawn a NEW run, not re-throw the cached rejection.
		const output = await hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s1" },
		);
		expect(runCount).toBe(2);
		expect(output).toBe("fresh index 2");
	});

	it("gates pre-search on the configured server key, not a hardcoded name", async () => {
		const gate = deferred<string>();
		let runCount = 0;
		const deps = makeDeps({
			runIndex: async () => {
				runCount += 1;
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		// Server registered under a custom key — basename matching is
		// advertised as "server name irrelevant".
		const config = {
			mcp: {
				"jetbrains-context": { type: "local", command: ["/bin/jbcontext"] },
			},
		};
		await hooks.config(config as never);
		expect(hooks.__state().serverName).toBe("jetbrains-context");

		// Start an in-flight index via the manual tool.
		const manual = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s1" },
		);

		// A search named after the custom key joins the in-flight index.
		const join = hooks["tool.execute.before"]({
			tool: "jetbrains-context_code_search",
			sessionID: "s1",
		} as never);
		// A search named after the default key does not block on it.
		const nonJoin = hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s2",
		} as never);
		await nonJoin;
		gate.resolve("done");
		await Promise.all([manual, join, gate.promise]);
		expect(runCount).toBe(1);
	});

	it("detects wrapper-script commands and resolves the real binary for indexing", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				"jetbrains-context": { type: "local", command: ["npx", "jbcontext", "mcp"] },
			},
		};
		await hooks.config(cfg as never);
		// The wrapper server is detected and adopted — no duplicate registered.
		// Index runs use the resolved real binary, not the wrapper.
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jetbrains-context",
			binPath: "/opt/jbcontext",
		});
		expect(Object.keys(cfg.mcp)).toEqual(["jetbrains-context"]);
	});

	it("detects env-wrapper commands at argv[1] and resolves the real binary", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				jb: { type: "local", command: ["/usr/bin/env", "jbcontext", "mcp"] },
			},
		};
		await hooks.config(cfg as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jb",
			binPath: "/opt/jbcontext",
		});
	});

	it("resolves the real binary via the default resolver for wrapper servers", async () => {
		// Hermetic: force the real resolver to find a hit via mocked fs.
		const originalAccess = fs.accessSync;
		const originalPath = process.env.PATH;
		process.env.PATH = "/resolved/bin";
		fs.accessSync = (p: any) => {
			if (p === "/resolved/bin/jbcontext") return undefined;
			throw new Error("ENOENT");
		};
		try {
			const deps = makeDeps();
			const hooks = createHooks(deps);
			const cfg = {
				mcp: {
					jb: { type: "local", command: ["npx", "jbcontext", "mcp"] },
				},
			};
			await hooks.config(cfg as never);
			expect(hooks.__state()).toEqual({
				enabled: true,
				serverName: "jb",
				binPath: "/resolved/bin/jbcontext",
			});
		} finally {
			fs.accessSync = originalAccess;
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});

	it("degrades to inactive when a wrapper server exists but the CLI is missing", async () => {
		const deps = makeDeps({ resolveBinary: () => null });
		const hooks = createHooks(deps);
		const cfg = {
			mcp: {
				"jetbrains-context": { type: "local", command: ["npx", "jbcontext", "mcp"] },
			},
		};
		await hooks.config(cfg as never);
		// The user's server still runs; only the plugin's index triggers no-op.
		expect(hooks.__state()).toEqual({
			enabled: false,
			serverName: null,
			binPath: null,
		});
		expect(deps.logCalls).toHaveLength(1);
		expect(deps.logCalls[0].level).toBe("warn");
		expect(deps.logCalls[0].message).toContain("uses a wrapper command");
		expect(deps.logCalls[0].extra).toEqual(
			expect.objectContaining({
				serverName: "jetbrains-context",
				wrapper: "npx",
				decision: "cli-missing",
				installCommand: INSTALL_COMMAND,
			}),
		);
	});

	it("indexes two different repos concurrently (cross-repo isolation)", async () => {
		const gates = new Map<string, ReturnType<typeof deferred<string>>>();
		const runRoots: string[] = [];
		const deps = makeDeps({
			runIndex: async (_bin: string, root: string) => {
				runRoots.push(root);
				const gate = deferred<string>();
				gates.set(root, gate);
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// Two sessions in different repos start indexes simultaneously.
		await hooks.event({ event: sessionCreatedEvent("s1", "/repoA") } as never);
		await hooks.event({ event: sessionCreatedEvent("s2", "/repoB") } as never);
		expect(runRoots.sort()).toEqual(["/git/repoA", "/git/repoB"]);

		// Resolving repo A's index does not affect repo B's pending run.
		gates.get("/git/repoA")!.resolve("a done");
		await gates.get("/git/repoA")!.promise;
		expect(gates.get("/git/repoB")!.promise).toBeInstanceOf(Promise);
		gates.get("/git/repoB")!.resolve("b done");
		await gates.get("/git/repoB")!.promise;
	});

	it("dedupes different directories resolving to the same git root", async () => {
		const gate = deferred<string>();
		let runCount = 0;
		const deps = makeDeps({
			// Both directories live in the same repository.
			getGitRoot: async (cwd: string) => "/git/repo",
			runIndex: async () => {
				runCount += 1;
				return gate.promise;
			},
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		const first = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo", sessionID: "s1" },
		);
		const second = hooks.tool.jbcontext_index.execute(
			{},
			{ directory: "/repo/packages/app", sessionID: "s2" },
		);
		gate.resolve("done");
		const [out1, out2] = await Promise.all([first, second]);
		expect(runCount).toBe(1);
		expect(out2).toBe(out1);
	});

	it("is idempotent when the config hook runs twice on the same config", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		const cfg: Record<string, unknown> = {};
		await hooks.config(cfg as never);
		await hooks.config(cfg as never);
		// Second call re-detects the registered entry and stays enabled —
		// no duplicate write, no warning.
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: "/opt/jbcontext",
		});
		expect(Object.keys(cfg.mcp as Record<string, unknown>)).toEqual(["jbcontext"]);
		expect(deps.logCalls).toEqual([]);
	});

	it("registers on a second config call after a failed first registration", async () => {
		const deps = makeDeps({ resolveBinary: () => "/opt/jbcontext" });
		const hooks = createHooks(deps);
		// First call: frozen config, registration fails.
		const frozen = { mcp: Object.freeze({}) as Record<string, unknown> };
		await hooks.config(frozen as never);
		expect(hooks.__state().enabled).toBe(false);
		// Second call: writable config, registration succeeds.
		const writable: Record<string, unknown> = {};
		await hooks.config(writable as never);
		expect(hooks.__state()).toEqual({
			enabled: true,
			serverName: "jbcontext",
			binPath: "/opt/jbcontext",
		});
	});

	it("search joining an in-flight index that fails resolves without throwing", async () => {
		const gate = deferred<string>();
		const deps = makeDeps({
			// Both the session-start event and the search resolve to the same root.
			getGitRoot: async () => "/git/repo",
			runIndex: async () => gate.promise,
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// Session-start index begins; a search joins it.
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		const search = hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);

		// The in-flight index fails — the joiner must not throw.
		gate.reject(new Error("auth expired"));
		await expect(search).resolves.toBeUndefined();
		// Allow the fire-and-forget .catch handler to run.
		await new Promise((r) => setImmediate(r));
		// The failure is logged exactly once (by the session-start .catch).
		const failureLogs = deps.logCalls.filter((c) =>
			c.message.includes("background session-start indexing failed"),
		);
		expect(failureLogs).toHaveLength(1);
	});

	it("pre-search join does not resolve before the in-flight index settles", async () => {
		const gate = deferred<string>();
		const deps = makeDeps({
			// Both the session-start event and the search resolve to the same root.
			getGitRoot: async () => "/git/repo",
			runIndex: async () => gate.promise,
		});
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);

		// Session-start index begins; a search joins it.
		await hooks.event({ event: sessionCreatedEvent("s1", "/repo") } as never);
		const search = hooks["tool.execute.before"]({
			tool: "jbcontext_code_search",
			sessionID: "s1",
		} as never);

		// The join is still pending after a tick (no timeout fires).
		await new Promise((r) => setImmediate(r));
		let settled = false;
		void search.then(() => {
			settled = true;
		});
		await new Promise((r) => setImmediate(r));
		expect(settled).toBe(false);

		// Releasing the gate resolves the search immediately.
		gate.resolve("done");
		await expect(search).resolves.toBeUndefined();
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

	it("ignores session.created events with an empty-string directory", async () => {
		const deps = makeDeps();
		const hooks = createHooks(deps);
		await hooks.config(CONFIG_ONE as never);
		await hooks.event({
			event: { type: "session.created", properties: { info: { id: "s1", directory: "" } } },
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
	it("forwards stderr-only success output to the caller", async () => {
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
				stderr: "warning: legacy flag",
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
		expect(result).toBe("warning: legacy flag");
	});

	it("preserves multiline stdout in forwarded output", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "/git/root\n",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/git/root": {
				stdout: "line1\nline2\nline3",
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
		expect(result).toBe("line1\nline2\nline3");
	});

	it("falls back to the init directory when session.get returns null data", async () => {
		const logCalls: LogCall[] = [];
		const client = {
			app: {
				log: async (input: { body: LogCall }) => {
					logCalls.push(input.body);
				},
			},
			session: {
				get: async () => ({ data: null }),
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
			}),
		);
	});


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

	it("falls back to the directory itself when it is not a git repository", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "fatal: not a git repository",
				exitCode: 128,
			},
			"/usr/local/bin/jbcontext index --project-path=/session/dir": {
				stdout: "indexed plain dir",
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

		// The manual tool indexes the directory itself (git optional).
		const result = await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		expect(result).toBe("indexed plain dir");
		expect(shellCalls).toContain("/usr/local/bin/jbcontext index --project-path=/session/dir");

		// Non-git classification is logged at debug.
		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "debug",
				extra: expect.objectContaining({
					directory: "/session/dir",
					decision: "non-git",
				}),
			}),
		);
	});

	it("falls back to the directory itself when git output is empty but successful", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/session/dir": {
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
		expect(result).toMatch(/^jbcontext: indexed \/session\/dir in \d+ms$/);
		expect(shellCalls).toContain("/usr/local/bin/jbcontext index --project-path=/session/dir");
	});

	it("warns once per directory when the git binary is missing and falls back", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $, shellCalls } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "bun: command not found: git",
				exitCode: 127,
			},
			"git -C /session/dir2 rev-parse --show-toplevel": {
				stdout: "",
				stderr: "bun: command not found: git",
				exitCode: 127,
			},
			"/usr/local/bin/jbcontext index --project-path=/session/dir": {
				stdout: "",
				stderr: "",
				exitCode: 0,
			},
			"/usr/local/bin/jbcontext index --project-path=/session/dir2": {
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

		// Two manual index calls for the same directory: the warn fires once.
		await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);
		// A different directory gets its own warn (once per directory).
		await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir2", sessionID: "s1" } as never);

		const warns = logCalls.filter(
			(c) => c.level === "warn" && c.extra.decision === "git-missing",
		);
		expect(warns).toHaveLength(2);
		expect(warns[0].extra.directory).toBe("/session/dir");
		expect(warns[1].extra.directory).toBe("/session/dir2");
		expect(warns[0].message).toContain("git is not installed");
		expect(shellCalls).toContain("/usr/local/bin/jbcontext index --project-path=/session/dir");
	});

	it("classifies command-not-found stderr as git missing (exit 0 path)", async () => {
		const logCalls: LogCall[] = [];
		const client = makeClient(logCalls, { s1: "/session/dir" });
		const { $ } = makeShell({
			"git -C /session/dir rev-parse --show-toplevel": {
				stdout: "",
				stderr: "/bin/sh: git: command not found",
				exitCode: 1,
			},
			"/usr/local/bin/jbcontext index --project-path=/session/dir": {
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

		await (
			plugin.tool.jbcontext_index.execute as (args: never, ctx: never) => Promise<string>
		)({} as never, { directory: "/session/dir", sessionID: "s1" } as never);

		expect(logCalls).toContainEqual(
			expect.objectContaining({
				level: "warn",
				extra: expect.objectContaining({ decision: "git-missing" }),
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