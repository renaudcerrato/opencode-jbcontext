/** Behavior at both OpenCode host boundaries; no SDK, filesystem or CLI is invoked. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { spawn } from "node:child_process";

jest.mock("@opencode/plugin", () => ({ Plugin: { define: (definition: unknown) => definition } }), { virtual: true });
jest.mock("node:child_process", () => ({ spawn: jest.fn() }));

import plugin, {
	basename, createHooks, DEFAULT_BIN_PATH, findJbcontextServer, INSTALL_COMMAND,
	jbcontextPlugin, resolveBinaryPath, type JbcontextPluginDeps,
} from "../src/index";

const BIN = "/usr/local/bin/jbcontext";
const SERVER = { type: "local", command: [BIN, "mcp"] };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function deps(overrides: Partial<JbcontextPluginDeps> = {}) {
	const calls: Array<[string, string]> = [];
	const log = jest.fn(async (_level: string, _message: string, _extra: object) => {});
	const getSessionDirectory = jest.fn(async (id: string) => `/sessions/${id}`);
	const runIndex = jest.fn(async (bin: string, root: string) => { calls.push([bin, root]); return `indexed ${root}`; });
	return { calls, log, getSessionDirectory, runIndex, resolveBinary: () => BIN, ...overrides };
}
function editor(initial: Record<string, unknown> = {}) {
	const entries = new Map(Object.entries(initial));
	return { entries, list: jest.fn(() => entries.entries()), set: jest.fn((name: string, value: unknown) => { entries.set(name, value); }) };
}
function active(d = deps(), entries: Record<string, unknown> = { jbcontext: SERVER }) {
	const hooks = createHooks(d);
	const e = editor(entries);
	hooks.configureServer(e);
	return { hooks, e, d };
}

describe("server discovery and binary safety", () => {
	it("recognizes path basenames without treating a trailing slash or empty path as a binary", () => {
		// Arrange
		const paths = ["/opt/bin/jbcontext/", "jbcontext", ""];
		// Act
		const names = paths.map(basename);
		// Assert
		expect(names).toEqual(["jbcontext", "jbcontext", ""]);
	});
	it("finds an enabled local CLI under a custom name or wrapper but excludes remote and disabled entries", () => {
		// Arrange
		const config = { mcp: { custom: { type: "local", command: ["/usr/bin/env", "jbcontext", "mcp"] }, remote: { type: "remote", command: [BIN] }, off: { type: "local", disabled: true, command: [BIN] }, legacy: { type: "local", enabled: false, command: [BIN] } } };
		// Act
		const enabled = findJbcontextServer(config);
		const all = findJbcontextServer(config, { includeDisabled: true });
		// Assert
		expect(enabled).toEqual({ matchCount: 1, serverName: "custom", binPath: "/usr/bin/env", matchNames: ["custom"] });
		expect(all.matchNames).toEqual(["custom", "off", "legacy"]);
	});
	it("ignores malformed config and commands, and does not choose between multiple matches", () => {
		// Arrange
		const entries = { none: null, empty: { type: "local" }, list: { type: "local", command: [] }, text: { type: "local", command: "jbcontext" }, wrong: { type: "local", command: ["/bin/not-jbcontext", "mcp"] } };
		// Act
		const invalid = [null, undefined, {}, { mcp: "bad" }, { mcp: entries }].map(findJbcontextServer);
		const duplicates = findJbcontextServer({ mcp: { a: SERVER, b: SERVER } });
		// Assert
		expect(invalid.every((result) => result.matchCount === 0)).toBe(true);
		expect(duplicates).toEqual({ matchCount: 2, serverName: null, binPath: null, matchNames: ["a", "b"] });
	});
	describe("PATH lookup", () => {
		const originalPath = process.env.PATH;
		afterEach(() => { jest.restoreAllMocks(); if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
		it("uses the first executable absolute PATH entry and ignores relative and empty entries", () => {
			// Arrange
			process.env.PATH = ":relative:/first:/second";
			const access = jest.spyOn(fs, "accessSync").mockImplementation((path, mode) => { if (path === "/second/jbcontext" && mode === fs.constants.X_OK) return; throw new Error("EACCES"); });
			// Act
			const result = resolveBinaryPath();
			// Assert
			expect(result).toBe("/second/jbcontext");
			expect(access.mock.calls.map(([path]) => path)).toEqual(["/first/jbcontext", "/second/jbcontext"]);
		});
		it("falls back to installer location, or reports missing when nothing is executable", () => {
			// Arrange
			delete process.env.PATH;
			const access = jest.spyOn(fs, "accessSync").mockImplementation(() => {});
			// Act
			const installed = resolveBinaryPath();
			access.mockImplementation(() => { throw new Error("ENOENT"); });
			const missing = resolveBinaryPath();
			// Assert
			expect(installed).toBe(DEFAULT_BIN_PATH);
			expect(missing).toBeNull();
		});
	});
});

describe("MCP registration", () => {
	it("registers once with the resolved CLI and adopts that server on repeated transforms", async () => {
		// Arrange
		const { hooks, e, d } = active(deps(), {});
		// Act
		hooks.configureServer(e);
		await hooks.indexManual("s1");
		// Assert
		expect(e.set).toHaveBeenCalledTimes(1);
		expect(e.entries.get("jbcontext")).toEqual(SERVER);
		expect(d.calls).toEqual([[BIN, "/sessions/s1"]]);
	});
	it("uses the built-in binary resolver when none is injected", () => {
		// Arrange
		const access = jest.spyOn(fs, "accessSync").mockImplementation((path) => { if (path === DEFAULT_BIN_PATH) return; throw new Error("ENOENT"); });
		const oldPath = process.env.PATH;
		process.env.PATH = "relative";
		try {
			const hooks = createHooks({ log: deps().log, getSessionDirectory: deps().getSessionDirectory, runIndex: deps().runIndex });
			const e = editor();
			// Act
			hooks.configureServer(e);
			// Assert
			expect(e.entries.get("jbcontext")).toEqual({ type: "local", command: [DEFAULT_BIN_PATH, "mcp"] });
		} finally { access.mockRestore(); if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
	});
	it("adopts an existing enabled custom server without overwriting its entry", async () => {
		// Arrange
		const { hooks, e, d } = active(deps(), { custom: SERVER });
		// Act
		await hooks.indexManual("s1");
		// Assert
		expect(e.set).not.toHaveBeenCalled();
		expect(d.calls).toEqual([[BIN, "/sessions/s1"]]);
	});
	it("adopts a wrapper only when its real CLI is available", async () => {
		// Arrange
		const wrapped = { custom: { type: "local", command: ["npx", "jbcontext", "mcp"] } };
		const { hooks, e, d } = active(deps(), wrapped);
		// Act
		await hooks.indexManual("s1");
		// Assert
		expect(e.set).not.toHaveBeenCalled();
		expect(d.calls).toEqual([[BIN, "/sessions/s1"]]);
	});
	it("resolves wrappers using the default resolver when no resolver was supplied", async () => {
		// Arrange
		const access = jest.spyOn(fs, "accessSync").mockImplementation((path) => { if (path === DEFAULT_BIN_PATH) return; throw new Error("ENOENT"); });
		const d = deps();
		const hooks = createHooks({ log: d.log, getSessionDirectory: d.getSessionDirectory, runIndex: d.runIndex });
		try {
			// Act
			hooks.configureServer(editor({ custom: { type: "local", command: ["/usr/bin/env", "jbcontext", "mcp"] } }));
			await hooks.indexManual("s1");
			// Assert
			expect(d.calls).toEqual([[DEFAULT_BIN_PATH, "/sessions/s1"]]);
		} finally { access.mockRestore(); }
	});
	it("leaves disabled local entries and existing remote or opaque jbcontext keys untouched", async () => {
		// Arrange
		const cases = [{ custom: { type: "local", disabled: true, command: [BIN] } }, { custom: { type: "local", enabled: false, command: [BIN] } }, { jbcontext: { type: "remote", url: "https://example.invalid" } }, { jbcontext: null }];
		// Act
		const outcomes = await Promise.all(cases.map(async (entries) => { const { hooks, e } = active(deps(), entries); return { e, result: await hooks.indexManual("s1") }; }));
		// Assert
		expect(outcomes.every(({ e, result }) => e.set.mock.calls.length === 0 && result.includes("not active"))).toBe(true);
	});
	it("ignores unrelated disabled servers and registers jbcontext", () => {
		// Arrange
		const { e } = active(deps(), { other: { type: "local", disabled: true, command: ["other"] } });
		// Act
		const registered = e.entries.get("jbcontext");
		// Assert
		expect(registered).toEqual(SERVER);
	});
	it("does not register when the editor cannot be read or written", async () => {
		// Arrange
		const hooks = createHooks(deps());
		const brokenRead = { list: () => { throw new Error("unreadable"); }, set: jest.fn() };
		const brokenWrite = { list: () => [][Symbol.iterator](), set: () => { throw new Error("readonly"); } };
		// Act
		hooks.configureServer(brokenRead);
		hooks.configureServer(brokenWrite);
		const outcome = await hooks.indexManual("s1");
		// Assert
		expect(outcome).toContain("not active");
		expect(brokenRead.set).not.toHaveBeenCalled();
	});
	it("reports missing CLI and preserves the user's wrapper server", async () => {
		// Arrange
		const d = deps({ resolveBinary: () => null, log: jest.fn(async () => { throw new Error("logger offline"); }) });
		const hooks = createHooks(d);
		const e = editor({ custom: { type: "local", command: ["npx", "jbcontext"] } });
		// Act
		hooks.configureServer(e);
		await flush();
		const result = await hooks.indexManual("s1");
		// Assert
		expect(result).toContain("not active");
		expect(e.set).not.toHaveBeenCalled();
		expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining(INSTALL_COMMAND), expect.objectContaining({ wrapper: "npx" }));
	});
	it("warns when the CLI is missing without writing a server, even if logging rejects", async () => {
		// Arrange
		const d = deps({ resolveBinary: () => null, log: jest.fn(async () => { throw new Error("logger offline"); }) });
		const hooks = createHooks(d);
		const e = editor();
		// Act
		hooks.configureServer(e);
		await flush();
		// Assert
		expect(e.set).not.toHaveBeenCalled();
		expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining(INSTALL_COMMAND), expect.objectContaining({ decision: "cli-missing" }));
	});
	it("rejects duplicate enabled servers instead of selecting one", () => {
		// Arrange
		const hooks = createHooks(deps());
		const e = editor({ first: SERVER, second: SERVER });
		// Act and Assert
		expect(() => hooks.configureServer(e)).toThrow(/multiple enabled jbcontext MCP servers found \(first, second\)/);
		expect(e.set).not.toHaveBeenCalled();
	});
});

describe("session indexing and search coordination", () => {
	it("starts a nonblocking first-prompt index once per session, including resumed sessions", async () => {
		// Arrange
		const gate = deferred<string>();
		const d = deps({ runIndex: jest.fn(() => gate.promise) });
		const { hooks } = active(d);
		// Act
		await hooks.onPrompt({ sessionID: "resumed" });
		await hooks.onPrompt({ sessionID: "resumed" });
		// Assert
		expect(d.runIndex).toHaveBeenCalledTimes(1);
		gate.resolve("done");
		await gate.promise;
	});
	it("never indexes on prompts or manual calls when inactive", async () => {
		// Arrange
		const d = deps();
		const hooks = createHooks(d);
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		const message = await hooks.indexManual("s1");
		// Assert
		expect(message).toContain("not active");
		expect(d.runIndex).not.toHaveBeenCalled();
	});
	it("deduplicates concurrent prompts across sessions sharing a directory, then permits a later manual refresh", async () => {
		// Arrange
		const gate = deferred<string>();
		const d = deps({ getSessionDirectory: async () => "/shared", runIndex: jest.fn().mockReturnValueOnce(gate.promise).mockResolvedValue("new index") });
		const { hooks } = active(d);
		// Act
		await Promise.all([hooks.onPrompt({ sessionID: "a" }), hooks.onPrompt({ sessionID: "b" })]);
		await flush();
		const manual = hooks.indexManual("b");
		gate.resolve("first index");
		const first = await manual;
		const second = await hooks.indexManual("a");
		// Assert
		expect([first, second]).toEqual(["first index", "new index"]);
		expect(d.runIndex).toHaveBeenCalledTimes(2);
	});
	it("indexes different directories independently", async () => {
		// Arrange
		const { hooks, d } = active();
		// Act
		await Promise.all([hooks.indexManual("a"), hooks.indexManual("b")]);
		// Assert
		expect(d.calls).toEqual([[BIN, "/sessions/a"], [BIN, "/sessions/b"]]);
	});
	it("joins only the configured server's in-flight search, without starting an index for idle searches", async () => {
		// Arrange
		const gate = deferred<string>();
		const d = deps({ runIndex: jest.fn(() => gate.promise) });
		const { hooks } = active(d, { custom: SERVER });
		// Act
		await hooks.beforeSearch({ tool: "custom_code_search", sessionID: "idle" });
		const manual = hooks.indexManual("s1");
		await flush();
		const search = hooks.beforeSearch({ tool: "custom_code_search", sessionID: "s1" });
		let settled = false;
		void search.then(() => { settled = true; });
		await hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		await flush();
		// Assert
		expect(settled).toBe(false);
		expect(d.runIndex).toHaveBeenCalledTimes(1);
		gate.resolve("indexed");
		await Promise.all([search, manual]);
		expect(settled).toBe(true);
	});
	it("searches and unrelated tools never start indexes while inactive or idle", async () => {
		// Arrange
		const d = deps();
		const hooks = createHooks(d);
		// Act
		await hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		hooks.configureServer(editor({ jbcontext: SERVER }));
		await hooks.beforeSearch({ tool: "read", sessionID: "s1" });
		await hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		// Assert
		expect(d.runIndex).not.toHaveBeenCalled();
	});
	it("logs a non-Error CLI failure without blocking the prompt", async () => {
		// Arrange
		const diagnostic = deferred<void>();
		const log = jest.fn(async (level: string) => {
			if (level === "debug") diagnostic.resolve();
		});
		const d = deps({ runIndex: jest.fn().mockRejectedValue("offline"), log });
		const { hooks } = active(d);
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		await diagnostic.promise;
		// Assert
		expect(d.runIndex).toHaveBeenCalledWith(BIN, "/sessions/s1");
		expect(d.log).toHaveBeenCalledWith("debug", expect.stringContaining("background"), expect.objectContaining({ error: "offline" }));
	});
	it("continues serving searches and manual refreshes if background failure diagnostics cannot be logged", async () => {
		// Arrange
		const diagnostic = deferred<void>();
		const log = jest.fn(async (level: string) => {
			if (level === "debug") {
				diagnostic.resolve();
				throw new Error("diagnostic logger offline");
			}
		});
		const runIndex = jest.fn().mockRejectedValueOnce(new Error("index unavailable")).mockResolvedValueOnce("fresh index");
		const { hooks } = active(deps({ log, runIndex }));
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		await diagnostic.promise;
		await hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		const output = await hooks.indexManual("s1");
		// Assert
		expect(log).toHaveBeenCalledWith("debug", expect.stringContaining("background"), expect.objectContaining({ error: "index unavailable" }));
		expect(output).toBe("fresh index");
		expect(runIndex).toHaveBeenCalledTimes(2);
	});
	it("starts the CLI despite a rejected diagnostic log and keeps manual refresh and search usable", async () => {
		// Arrange
		const gate = deferred<string>();
		const d = deps({ log: jest.fn(async () => { throw new Error("logging unavailable"); }), runIndex: jest.fn(() => gate.promise) });
		const { hooks } = active(d);
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		await flush();
		const search = hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		const manual = hooks.indexManual("s1");
		await flush();
		// Assert
		expect(d.runIndex).toHaveBeenCalledTimes(1);
		gate.resolve("fresh index");
		await expect(search).resolves.toBeUndefined();
		await expect(manual).resolves.toBe("fresh index");
	});
	it("reports unexpected prompt directory failures without indexing", async () => {
		// Arrange
		const d = deps({ getSessionDirectory: async () => { throw "no session"; } });
		const { hooks } = active(d);
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		// Assert
		expect(d.runIndex).not.toHaveBeenCalled();
		expect(d.log).toHaveBeenCalledWith("debug", expect.stringContaining("could not resolve"), expect.objectContaining({ error: "no session" }));
	});
	it("reports an Error from prompt directory resolution without attempting an index", async () => {
		// Arrange
		const d = deps({ getSessionDirectory: async () => { throw new Error("session unavailable"); } });
		const { hooks } = active(d);
		// Act
		await hooks.onPrompt({ sessionID: "s1" });
		// Assert
		expect(d.runIndex).not.toHaveBeenCalled();
		expect(d.log).toHaveBeenCalledWith("debug", expect.stringContaining("could not resolve"), expect.objectContaining({ error: "session unavailable" }));
	});
	it("allows search when an in-flight index fails and reports the failure", async () => {
		// Arrange
		const gate = deferred<string>();
		const d = deps({ runIndex: jest.fn(() => gate.promise) });
		const { hooks } = active(d);
		await hooks.onPrompt({ sessionID: "s1" });
		await flush();
		// Act
		const search = hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		await flush();
		gate.reject(new Error("index failed"));
		await search;
		// Assert
		expect(d.log).toHaveBeenCalledWith("error", expect.stringContaining("pre-search"), expect.objectContaining({ error: "index failed" }));
	});
	it("allows search when directory resolution fails and stringifies the reason", async () => {
		// Arrange
		const d = deps({ getSessionDirectory: async () => { throw 42; } });
		const { hooks } = active(d);
		// Act
		await hooks.beforeSearch({ tool: "jbcontext_code_search", sessionID: "s1" });
		// Assert
		expect(d.log).toHaveBeenCalledWith("error", expect.any(String), expect.objectContaining({ error: "42" }));
	});
	it("propagates manual errors and retries after a failed run", async () => {
		// Arrange
		const d = deps({ runIndex: jest.fn().mockRejectedValueOnce(new Error("auth required")).mockResolvedValueOnce("success") });
		const { hooks } = active(d);
		// Act
		const failure = hooks.indexManual("s1");
		await expect(failure).rejects.toThrow("auth required");
		const retry = await hooks.indexManual("s1");
		// Assert
		expect(retry).toBe("success");
		expect(d.runIndex).toHaveBeenCalledTimes(2);
	});
});

type Tool = { name: string; description: string; input: unknown; execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> };
function host(get = jest.fn(async ({ sessionID }: { sessionID: string }) => ({ location: { directory: `/project/${sessionID}` } }))) {
	let prompt!: (event: { sessionID: string }) => Promise<void>;
	let before!: (event: { tool: string; sessionID: string }) => Promise<void>;
	let tool!: Tool;
	const mcp = editor({ jbcontext: SERVER });
	const ctx = {
		location: { directory: "/initial" }, session: { get, hook: jest.fn(async (_name: string, callback: typeof prompt) => { prompt = callback; }) },
		mcp: { transform: jest.fn(async (callback: (e: typeof mcp) => void) => callback(mcp)) },
		tool: { hook: jest.fn(async (_name: string, callback: typeof before) => { before = callback; }), transform: jest.fn(async (callback: (e: { add: (value: Tool) => void }) => void) => callback({ add: (value) => { tool = value; } })) },
	};
	return { ctx, get, mcp, prompt: () => prompt, before: () => before, tool: () => tool };
}
function child() {
	const process = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding: jest.Mock }; stderr: EventEmitter & { setEncoding: jest.Mock } };
	process.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn().mockReturnThis() });
	process.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn().mockReturnThis() });
	(spawn as jest.Mock).mockReturnValue(process);
	return process;
}
/** The SDK fallback may await several promises before spawn installs its close listener. */
function readyToClose(process: EventEmitter): Promise<void> {
	if (process.listenerCount("close") > 0) return Promise.resolve();
	return new Promise((resolve) => {
		const onListener = (event: string | symbol) => {
			if (event !== "close") return;
			process.off("newListener", onListener);
			resolve();
		};
		process.on("newListener", onListener);
	});
}
async function wired(get?: ReturnType<typeof jest.fn>) {
	const h = host(get);
	await jbcontextPlugin.setup(h.ctx as never);
	return h;
}

describe("v2 host integration", () => {
	beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, "info").mockImplementation(() => {}); jest.spyOn(console, "warn").mockImplementation(() => {}); jest.spyOn(console, "error").mockImplementation(() => {}); jest.spyOn(console, "debug").mockImplementation(() => {}); });
	afterEach(() => jest.restoreAllMocks());
	it("exports the v2 plugin and registers exactly the four host extension points and argument-free tool", async () => {
		// Arrange
		const h = host();
		// Act
		await plugin.setup(h.ctx as never);
		// Assert
		expect(plugin).toBe(jbcontextPlugin);
		expect(plugin.id).toBe("opencode-jbcontext");
		expect(h.ctx.session.hook).toHaveBeenCalledWith("prompt", expect.any(Function));
		expect(h.ctx.tool.hook).toHaveBeenCalledWith("execute.before", expect.any(Function));
		expect(h.ctx.mcp.transform).toHaveBeenCalledTimes(1);
		expect(h.ctx.tool.transform).toHaveBeenCalledTimes(1);
		expect(h.tool()).toEqual(expect.objectContaining({ name: "jbcontext_index", description: expect.stringContaining("index"), input: { type: "object", properties: {}, additionalProperties: false }, execute: expect.any(Function) }));
	});
	it("passes the session's directory as a single safe CLI argument and returns stdout and stderr", async () => {
		// Arrange
		const c = child();
		const h = await wired(jest.fn(async () => ({ location: { directory: "/project/space ; $(id)" } })));
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" });
		await flush();
		c.stdout.emit("data", "uploaded\n"); c.stderr.emit("data", "warning\n"); c.emit("close", 0);
		// Assert
		expect(await result).toEqual({ content: "uploaded\nwarning" });
		expect(spawn).toHaveBeenCalledWith(BIN, ["index", "--project-path=/project/space ; $(id)"], { cwd: "/project/space ; $(id)", stdio: ["ignore", "pipe", "pipe"] });
		expect(h.get).toHaveBeenCalledWith({ sessionID: "s1" });
	});
	it("forwards stderr-only and multiline stdout without losing diagnostics", async () => {
		// Arrange
		const c = child(); const h = await wired();
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" }); await flush();
		c.stdout.emit("data", "line1\n"); c.stdout.emit("data", "line2"); c.stderr.emit("data", "warning"); c.emit("close", 0);
		// Assert
		expect(await result).toEqual({ content: "line1\nline2\nwarning" });
		expect(c.stdout.setEncoding).toHaveBeenCalledWith("utf8");
	});
	it("forwards a warning when the CLI succeeds with stderr only", async () => {
		// Arrange
		const c = child(); const h = await wired();
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" }); await flush();
		c.stderr.emit("data", "warning: stale cache\n"); c.emit("close", 0);
		// Assert
		expect(await result).toEqual({ content: "warning: stale cache" });
	});
	it("handles successful index commands whose output streams are unavailable", async () => {
		// Arrange
		jest.spyOn(Date, "now").mockReturnValue(100);
		const c = child();
		const h = await wired();
		const streamless = c as unknown as EventEmitter & { stdout?: EventEmitter; stderr?: EventEmitter };
		streamless.stdout = undefined; streamless.stderr = undefined;
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" }); await flush(); c.emit("close", 0);
		// Assert
		expect(await result).toEqual({ content: "jbcontext: indexed /project/s1 in 0ms" });
	});
	it("returns a success message for silent CLI output without relying on wall-clock timing", async () => {
		// Arrange
		jest.spyOn(Date, "now").mockReturnValue(100);
		const c = child(); const h = await wired();
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" }); await flush(); c.emit("close", 0);
		// Assert
		expect(await result).toEqual({ content: "jbcontext: indexed /project/s1 in 0ms" });
	});
	it("surfaces nonzero CLI exits, with or without stderr", async () => {
		// Arrange
		const h = await wired();
		const first = child();
		// Act
		const failed = h.tool().execute({}, { sessionID: "s1" }); await flush(); first.stderr.emit("data", "auth required\n"); first.emit("close", 1);
		await expect(failed).rejects.toThrow('indexing failed for "/project/s1": auth required');
		const second = child(); const empty = h.tool().execute({}, { sessionID: "s1" }); await flush(); second.emit("close", null);
		// Assert
		await expect(empty).rejects.toThrow('indexing failed for "/project/s1"');
		expect(console.error).toHaveBeenCalled();
	});
	it("surfaces spawn failures and stringifies non-Error reasons", async () => {
		// Arrange
		const h = await wired(); const first = child();
		// Act
		const failed = h.tool().execute({}, { sessionID: "s1" }); await flush(); first.emit("error", new Error("ENOENT"));
		await expect(failed).rejects.toThrow("ENOENT");
		const second = child(); const other = h.tool().execute({}, { sessionID: "s1" }); await flush(); second.emit("error", "offline");
		// Assert
		await expect(other).rejects.toThrow("offline");
	});
	it("falls back to initial location for missing session data without caching the fallback", async () => {
		// Arrange
		const get = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ location: {} });
		const h = await wired(get); const first = child();
		// Act
		const one = h.tool().execute({}, { sessionID: "s1" }); await readyToClose(first); first.emit("close", 0); await one;
		const second = child(); const two = h.tool().execute({}, { sessionID: "s1" }); await readyToClose(second); second.emit("close", 0); await two;
		// Assert
		expect(get).toHaveBeenCalledTimes(2);
		expect(spawn).toHaveBeenLastCalledWith(BIN, ["index", "--project-path=/initial"], expect.objectContaining({ cwd: "/initial" }));
		expect(console.warn).toHaveBeenCalled();
	});
	it("falls back on session lookup errors, including non-Error rejections", async () => {
		// Arrange
		const get = jest.fn().mockRejectedValueOnce(new Error("gone")).mockRejectedValueOnce("offline");
		const h = await wired(get); const first = child();
		// Act
		const one = h.tool().execute({}, { sessionID: "s1" }); await readyToClose(first); first.emit("close", 0); await one;
		const second = child(); const two = h.tool().execute({}, { sessionID: "s2" }); await readyToClose(second); second.emit("close", 0); await two;
		// Assert
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "offline", fallback: "/initial" }));
	});
	it("reuses successful session directories across manual indexes and searches", async () => {
		// Arrange
		const h = await wired(); const first = child();
		// Act
		const one = h.tool().execute({}, { sessionID: "s1" }); await flush(); first.emit("close", 0); await one;
		await h.before()({ tool: "jbcontext_code_search", sessionID: "s1" });
		const second = child(); const two = h.tool().execute({}, { sessionID: "s1" }); await flush(); second.emit("close", 0); await two;
		// Assert
		expect(h.get).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledTimes(2);
	});
	it("does not let broken console logging prevent indexing or fallback", async () => {
		// Arrange
		(console.info as jest.Mock).mockImplementation(() => { throw new Error("console unavailable"); });
		(console.warn as jest.Mock).mockImplementation(() => { throw new Error("console unavailable"); });
		const h = await wired(jest.fn(async () => null)); const c = child();
		// Act
		const result = h.tool().execute({}, { sessionID: "s1" }); await readyToClose(c); c.emit("close", 0);
		// Assert
		expect((await result).content).toContain("indexed /initial");
	});
});

type LegacyConfig = { mcp?: Record<string, unknown> };
type LegacyHooks = {
	config: (config: LegacyConfig) => Promise<void>;
	"chat.message": (event: { sessionID: string }) => Promise<void>;
	"tool.execute.before": (event: { tool: string; sessionID: string }) => Promise<void>;
	tool: { jbcontext_index: { description: string; args: object; execute: (args: object, context: { directory?: string; sessionID: string }) => Promise<string> } };
};

async function legacy(get = jest.fn(async ({ path }: { path: { id: string } }) => ({ data: { directory: `/project/${path.id}` } }))) {
	const log = jest.fn(async (_entry: unknown) => {});
	const hooks = await plugin.server({ client: { session: { get }, app: { log } }, directory: "/initial" } as never) as LegacyHooks;
	return { hooks, get, log };
}

describe("v1.18.29+ host integration", () => {
	beforeEach(() => { jest.clearAllMocks(); jest.spyOn(fs, "accessSync").mockImplementation((path) => { if (path === DEFAULT_BIN_PATH) return; throw new Error("ENOENT"); }); });
	afterEach(() => jest.restoreAllMocks());
	it("exports a v1 server entry point alongside the v2 default setup without invoking either host at import", async () => {
		// Arrange
		const h = await legacy();
		// Act
		const keys = Object.keys(h.hooks);
		// Assert
		expect(plugin).toBe(jbcontextPlugin);
		expect(plugin.setup).toBe(jbcontextPlugin.setup);
		expect(keys).toEqual(expect.arrayContaining(["config", "chat.message", "tool.execute.before", "tool"]));
		expect(h.hooks.tool.jbcontext_index).toEqual(expect.objectContaining({ args: {}, description: expect.stringContaining("index"), execute: expect.any(Function) }));
		expect(spawn).not.toHaveBeenCalled();
	});
	it("registers the executable in v1 config once and leaves the entry intact on reentrant config", async () => {
		// Arrange
		const { hooks } = await legacy();
		const config: LegacyConfig = {};
		// Act
		await hooks.config(config);
		const entry = config.mcp?.jbcontext;
		await hooks.config(config);
		// Assert
		expect(entry).toEqual({ type: "local", command: [DEFAULT_BIN_PATH, "mcp"] });
		expect(config.mcp).toEqual({ jbcontext: entry });
	});
	it("adopts an existing custom wrapper without changing it and runs the actual CLI", async () => {
		// Arrange
		const c = child();
		const { hooks } = await legacy();
		const config = { mcp: { custom: { type: "local", command: ["npx", "jbcontext", "mcp"] } } };
		// Act
		await hooks.config(config);
		const result = hooks.tool.jbcontext_index.execute({}, { directory: "/working", sessionID: "s1" });
		await flush(); c.stdout.emit("data", "updated\n"); c.emit("close", 0);
		// Assert
		expect(await result).toBe("updated");
		expect(Object.keys(config.mcp)).toEqual(["custom"]);
		expect(spawn).toHaveBeenCalledWith(DEFAULT_BIN_PATH, ["index", "--project-path=/working"], expect.objectContaining({ cwd: "/working" }));
	});
	it("never re-enables a v1 disabled server or overwrites a remote or opaque reserved key", async () => {
		// Arrange
		const configs: LegacyConfig[] = [
			{ mcp: { custom: { type: "local", enabled: false, command: [BIN] } } },
			{ mcp: { jbcontext: { type: "local", disabled: true, command: [BIN] } } },
			{ mcp: { jbcontext: { type: "remote", url: "https://example.invalid" } } },
			{ mcp: { jbcontext: null } },
		];
		// Act
		const results = await Promise.all(configs.map(async (config) => {
			const { hooks } = await legacy();
			const before = Object.keys(config.mcp ?? {});
			await hooks.config(config);
			return { before, after: Object.keys(config.mcp ?? {}), output: await hooks.tool.jbcontext_index.execute({}, { directory: "/working", sessionID: "s1" }) };
		}));
		// Assert
		expect(results.every(({ before, after, output }) => JSON.stringify(before) === JSON.stringify(after) && output.includes("not active"))).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
	});
	it("rejects duplicate enabled servers, but permits an enabled server alongside a disabled one", async () => {
		// Arrange
		const { hooks } = await legacy();
		const duplicates = { mcp: { first: SERVER, second: SERVER } };
		const mixed = { mcp: { first: SERVER, second: { ...SERVER, enabled: false } } };
		// Act
		const failure = hooks.config(duplicates);
		// Assert
		await expect(failure).rejects.toThrow(/multiple enabled jbcontext MCP servers found \(first, second\)/);
		await expect(hooks.config(mixed)).resolves.toBeUndefined();
		expect(mixed.mcp.second.enabled).toBe(false);
	});
	it("does not register on unreadable or frozen v1 config, and can recover on a later writable config", async () => {
		// Arrange
		const { hooks } = await legacy();
		const unreadable = Object.defineProperty({}, "mcp", { get: () => { throw new Error("unreadable"); } });
		const frozen = { mcp: Object.freeze({}) };
		const writable: LegacyConfig = {};
		// Act
		await hooks.config(unreadable);
		await hooks.config(frozen);
		const inactive = await hooks.tool.jbcontext_index.execute({}, { directory: "/working", sessionID: "s1" });
		await hooks.config(writable);
		// Assert
		expect(inactive).toContain("not active");
		expect(writable.mcp?.jbcontext).toEqual({ type: "local", command: [DEFAULT_BIN_PATH, "mcp"] });
	});
	it("does not overwrite an MCP entry that appears after reading the v1 config", async () => {
		// Arrange
		const { hooks } = await legacy();
		const mcp = {} as Record<string, unknown>;
		let reads = 0;
		const config = { get mcp() {
			reads += 1;
			if (reads === 2) mcp.jbcontext = { type: "remote", url: "https://example.invalid" };
			return mcp;
		} };
		// Act
		await hooks.config(config);
		const message = await hooks.tool.jbcontext_index.execute({}, { directory: "/working", sessionID: "s1" });
		// Assert
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(message).toContain("not active");
		expect(mcp.jbcontext).toEqual({ type: "remote", url: "https://example.invalid" });
	});
	it("warns and stays inactive when the CLI is missing for registration or wrapper adoption", async () => {
		// Arrange
		(fs.accessSync as jest.Mock).mockImplementation(() => { throw new Error("ENOENT"); });
		const plain = await legacy(); const wrapped = await legacy();
		const config: LegacyConfig = {};
		const wrapper = { mcp: { custom: { type: "local", command: ["npx", "jbcontext"] } } };
		// Act
		await plain.hooks.config(config);
		await wrapped.hooks.config(wrapper);
		await flush();
		// Assert
		expect(config.mcp).toBeUndefined();
		expect(Object.keys(wrapper.mcp)).toEqual(["custom"]);
		expect(plain.log).toHaveBeenCalledWith({ body: expect.objectContaining({ service: "opencode-jbcontext", level: "warn", message: expect.stringContaining(INSTALL_COMMAND) }) });
		expect(wrapped.log).toHaveBeenCalledWith({ body: expect.objectContaining({ level: "warn", extra: expect.objectContaining({ wrapper: "npx" }) }) });
	});
	it("prefers v1 tool-context directory over the SDK even for paths with spaces and shell syntax", async () => {
		// Arrange
		const c = child(); const h = await legacy(jest.fn(async () => { throw new Error("SDK should not be consulted"); }));
		await h.hooks.config({ mcp: { jbcontext: SERVER } });
		// Act
		const output = h.hooks.tool.jbcontext_index.execute({}, { directory: "/folder/a ; $(id)", sessionID: "s1" });
		await flush(); c.stderr.emit("data", "warning\n"); c.emit("close", 0);
		// Assert
		expect(await output).toBe("warning");
		expect(h.get).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledWith(BIN, ["index", "--project-path=/folder/a ; $(id)"], { cwd: "/folder/a ; $(id)", stdio: ["ignore", "pipe", "pipe"] });
	});
	it("resolves missing tool-context directory via v1 session API and caches a successful lookup", async () => {
		// Arrange
		const h = await legacy(); await h.hooks.config({ mcp: { jbcontext: SERVER } });
		const first = child();
		// Act
		const one = h.hooks.tool.jbcontext_index.execute({}, { sessionID: "s1" }); await flush(); first.emit("close", 0); await one;
		await h.hooks["tool.execute.before"]({ tool: "jbcontext_code_search", sessionID: "s1" });
		const second = child(); const two = h.hooks.tool.jbcontext_index.execute({}, { sessionID: "s1" }); await flush(); second.emit("close", 0); await two;
		// Assert
		expect(h.get).toHaveBeenCalledTimes(1);
		expect(h.get).toHaveBeenCalledWith({ path: { id: "s1" } });
		expect(spawn).toHaveBeenLastCalledWith(BIN, ["index", "--project-path=/project/s1"], expect.objectContaining({ cwd: "/project/s1" }));
	});
	it("falls back to the v1 init directory on absent or failed sessions, retrying the lookup", async () => {
		// Arrange
		const get = jest.fn().mockResolvedValueOnce({ data: null }).mockRejectedValueOnce(new Error("gone")).mockRejectedValueOnce("offline");
		const h = await legacy(get); await h.hooks.config({ mcp: { jbcontext: SERVER } });
		// Act
		for (let i = 0; i < 3; i++) {
			const c = child(); const result = h.hooks.tool.jbcontext_index.execute({}, { sessionID: "s1" });
			await readyToClose(c); c.emit("close", 0); await result;
		}
		// Assert
		expect(get).toHaveBeenCalledTimes(3);
		expect(spawn).toHaveBeenCalledTimes(3);
		expect(spawn).toHaveBeenLastCalledWith(BIN, ["index", "--project-path=/initial"], expect.objectContaining({ cwd: "/initial" }));
		expect(h.log).toHaveBeenCalledWith({ body: expect.objectContaining({ level: "warn", extra: expect.objectContaining({ error: "offline" }) }) });
	});
	it("indexes once at first prompt and lets matching custom searches join, never trigger, an in-flight run", async () => {
		// Arrange
		const h = await legacy(); await h.hooks.config({ mcp: { custom: SERVER } });
		const c = child();
		// Act
		await h.hooks["tool.execute.before"]({ tool: "custom_code_search", sessionID: "s1" });
		await h.hooks["chat.message"]({ sessionID: "s1" });
		await h.hooks["chat.message"]({ sessionID: "s1" });
		await flush();
		const search = h.hooks["tool.execute.before"]({ tool: "custom_code_search", sessionID: "s1" });
		let settled = false; void search.then(() => { settled = true; });
		await h.hooks["tool.execute.before"]({ tool: "jbcontext_code_search", sessionID: "s1" });
		await flush();
		// Assert
		expect(settled).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(1);
		c.emit("close", 0); await search;
		expect(settled).toBe(true);
	});
	it("deduplicates v1 manual calls with first-prompt indexing for the same directory", async () => {
		// Arrange
		const h = await legacy(); await h.hooks.config({ mcp: { jbcontext: SERVER } });
		const c = child();
		// Act
		await h.hooks["chat.message"]({ sessionID: "s1" }); await flush();
		const one = h.hooks.tool.jbcontext_index.execute({}, { directory: "/project/s1", sessionID: "s2" });
		const two = h.hooks.tool.jbcontext_index.execute({}, { directory: "/project/s1", sessionID: "s3" });
		c.stdout.emit("data", "indexed once"); c.emit("close", 0);
		// Assert
		expect(await Promise.all([one, two])).toEqual(["indexed once", "indexed once"]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});
	it("forwards manual CLI errors to the caller but allows subsequent indexing", async () => {
		// Arrange
		const h = await legacy(); await h.hooks.config({ mcp: { jbcontext: SERVER } });
		const first = child();
		// Act
		const failed = h.hooks.tool.jbcontext_index.execute({}, { directory: "/project/s1", sessionID: "s1" });
		await flush(); first.stderr.emit("data", "auth required"); first.emit("close", 1);
		await expect(failed).rejects.toThrow("auth required");
		const second = child(); const retried = h.hooks.tool.jbcontext_index.execute({}, { directory: "/project/s1", sessionID: "s1" });
		await flush(); second.stdout.emit("data", "updated"); second.emit("close", 0);
		// Assert
		expect(await retried).toBe("updated");
		expect(h.log).toHaveBeenCalledWith({ body: expect.objectContaining({ service: "opencode-jbcontext", level: "error", extra: expect.objectContaining({ stderr: "auth required" }) }) });
	});
	it("keeps indexing despite v1 logging failures", async () => {
		// Arrange
		const h = await legacy(jest.fn(async () => ({ data: null })));
		h.log.mockRejectedValue(new Error("logging offline"));
		await h.hooks.config({ mcp: { jbcontext: SERVER } });
		const c = child();
		// Act
		const result = h.hooks.tool.jbcontext_index.execute({}, { sessionID: "s1" });
		await readyToClose(c); c.emit("close", 0);
		// Assert
		expect(await result).toContain("indexed /initial");
		expect(h.log).toHaveBeenCalled();
	});
});
