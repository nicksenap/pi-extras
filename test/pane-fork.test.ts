import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import paneFork from "../extensions/pane-fork.ts";

const FAKE_TERMINAL = join(import.meta.dirname, "fake-terminal.cjs");
const TERMINAL_ENV = ["HERDR_PANE_ID", "HERDR_BIN_PATH", "CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "TMUX", "TMUX_PANE", "PI_FORK_BACKEND", "PI_FORK_ARGS"];
const savedEnv = { ...process.env };
const tempRoots: string[] = [];

const HERDR = { HERDR_PANE_ID: "herdr-pane-0" };
const CMUX = { CMUX_SURFACE_ID: "surface:1", CMUX_WORKSPACE_ID: "workspace:1" };
const TMUX = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" };

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Launch = { argv: string[]; cwd: string };

/** A project with a real Pi session, fake terminal CLIs and a fake `pi` on PATH. */
function setup(env: Record<string, string>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pane-fork-")));
	tempRoots.push(root);
	const project = join(root, "project");
	const bin = join(root, "bin");
	mkdirSync(project);
	mkdirSync(bin);

	const statePath = join(root, "state.json");
	const piLog = join(root, "pi-launches.jsonl");
	writeFileSync(statePath, JSON.stringify({ panes: [], splits: [] }));
	writeFileSync(piLog, "");
	for (const terminal of ["herdr", "cmux", "tmux"]) {
		writeFileSync(join(bin, terminal), `#!/bin/sh\nexec node "${FAKE_TERMINAL}" ${terminal} "$@"\n`);
		chmodSync(join(bin, terminal), 0o755);
	}
	writeFileSync(
		join(bin, "pi"),
		`#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");\n`,
	);
	chmodSync(join(bin, "pi"), 0o755);

	for (const key of TERMINAL_ENV) delete process.env[key];
	Object.assign(process.env, { PATH: `${bin}:${savedEnv.PATH}`, FAKE_STATE: statePath }, env);

	const session = SessionManager.create(project, join(root, "sessions"));
	const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};
	paneFork({ registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => unknown }) => (commands[name] = opts.handler) } as never);
	const notes: { message: string; type?: string }[] = [];
	const ctx = { sessionManager: session, ui: { notify: (message: string, type?: string) => notes.push({ message, type }) } };

	return {
		session,
		project,
		notes,
		run: async (command: string, args = "") => {
			await commands[command](args, ctx);
		},
		splits: (): { terminal: string; direction: string }[] => JSON.parse(readFileSync(statePath, "utf8")).splits,
		launches: (): Launch[] =>
			readFileSync(piLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
	};
}

function user(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

function messageTexts(entries: { type: string; message?: { content: unknown } }[]): string[] {
	return entries.flatMap((e) => (e.type === "message" ? [(e.message!.content as { text: string }[])[0].text] : []));
}

/** The text of each message a resumed session would show, in order. */
function transcript(sessionFile: string): string[] {
	return messageTexts(SessionManager.open(sessionFile).getBranch() as never);
}

/** The text of every message anywhere in the session tree, as /tree would show it. */
function everyMessageInTree(sessionFile: string): string[] {
	return messageTexts(SessionManager.open(sessionFile).getEntries() as never);
}

function sessionArg(launch: Launch): string {
	return launch.argv[launch.argv.indexOf("--session") + 1];
}

for (const [terminal, env, command, direction] of [
	["herdr", HERDR, "fork-right", "right"],
	["cmux", CMUX, "fork-right", "right"],
	["tmux", TMUX, "fork-down", "down"],
] as const) {
	test(`inside ${terminal}, /${command} opens the conversation in a new pane (${direction})`, async () => {
		const t = setup(env);
		t.session.appendMessage(user("hello"));
		t.session.appendMessage(assistant("hi there"));

		await t.run(command);

		assert.deepEqual(t.splits(), [{ terminal, direction }]);
		assert.equal(t.launches().length, 1);
		const [launch] = t.launches();
		assert.equal(launch.cwd, t.project);
		assert.deepEqual(transcript(sessionArg(launch)), ["hello", "hi there"]);
	});
}

test("herdr running inside cmux forks into a herdr pane, the innermost multiplexer", async () => {
	const t = setup({ ...HERDR, ...CMUX });
	t.session.appendMessage(user("hello"));

	await t.run("fork-right");

	assert.deepEqual(t.splits(), [{ terminal: "herdr", direction: "right" }]);
	assert.equal(t.launches().length, 1);
});

test("PI_FORK_BACKEND picks the terminal when detection would pick another", async () => {
	const t = setup({ ...HERDR, ...CMUX, PI_FORK_BACKEND: "cmux" });
	t.session.appendMessage(user("hello"));

	await t.run("fork-down");

	assert.deepEqual(t.splits(), [{ terminal: "cmux", direction: "down" }]);
	assert.equal(t.launches().length, 1);
});

test("the fork holds only the active branch and links back to the original session", async () => {
	const t = setup(HERDR);
	t.session.appendMessage(user("start"));
	const kept = t.session.appendMessage(assistant("first answer"));
	t.session.appendMessage(user("abandoned question"));
	t.session.appendMessage(assistant("abandoned answer"));
	t.session.branch(kept);
	t.session.appendMessage(user("better question"));

	await t.run("fork-right");

	const forkFile = sessionArg(t.launches()[0]);
	assert.deepEqual(transcript(forkFile), ["start", "first answer", "better question"]);
	assert.deepEqual(everyMessageInTree(forkFile), ["start", "first answer", "better question"]);
	assert.equal(SessionManager.open(forkFile).getHeader()?.parentSession, t.session.getSessionFile());
});

test("a prompt after the command becomes the fork's first message, quotes intact", async () => {
	const t = setup(TMUX);
	t.session.appendMessage(user("hello"));

	await t.run("fork-right", "  try the other approach, don't 'refactor' yet  ");

	assert.equal(t.launches()[0].argv.at(-1), "try the other approach, don't 'refactor' yet");
});

test("PI_FORK_ARGS flags are passed to the forked pi", async () => {
	const t = setup({ ...CMUX, PI_FORK_ARGS: "--no-skills --skill-profile pocock" });
	t.session.appendMessage(user("hello"));

	await t.run("fork-right");

	assert.deepEqual(t.launches()[0].argv.slice(0, 3), ["--no-skills", "--skill-profile", "pocock"]);
});

function sessionFiles(t: ReturnType<typeof setup>): string[] {
	try {
		return readdirSync(t.session.getSessionDir()).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
}

test("outside any supported terminal, /fork-right reports an error and forks nothing", async () => {
	const t = setup({});
	t.session.appendMessage(user("hello"));
	const before = sessionFiles(t);

	await t.run("fork-right");

	assert.deepEqual(t.splits(), []);
	assert.deepEqual(t.launches(), []);
	assert.deepEqual(sessionFiles(t), before);
	assert.equal(t.notes.at(-1)?.type, "error");
});

test("an unknown PI_FORK_BACKEND is reported by name", async () => {
	const t = setup({ ...HERDR, PI_FORK_BACKEND: "wezterm" });
	t.session.appendMessage(user("hello"));

	await t.run("fork-right");

	assert.deepEqual(t.splits(), []);
	assert.equal(t.notes.at(-1)?.type, "error");
	assert.match(t.notes.at(-1)!.message, /wezterm/);
});

test("a PI_FORK_BACKEND that names an Object property is rejected as unknown", async () => {
	const t = setup({ ...HERDR, PI_FORK_BACKEND: "constructor" });
	t.session.appendMessage(user("hello"));

	await t.run("fork-right");

	assert.deepEqual(t.splits(), []);
	assert.match(t.notes.at(-1)!.message, /Unknown PI_FORK_BACKEND "constructor"/);
});

test("PI_FORK_BACKEND=herdr outside a herdr pane reports an error and forks nothing", async () => {
	const t = setup({ ...TMUX, PI_FORK_BACKEND: "herdr" });
	t.session.appendMessage(user("hello"));
	const before = sessionFiles(t);

	await t.run("fork-right");

	assert.deepEqual(t.splits(), []);
	assert.deepEqual(sessionFiles(t), before);
	assert.equal(t.notes.at(-1)?.type, "error");
	assert.match(t.notes.at(-1)!.message, /HERDR_PANE_ID/);
});

for (const [terminal, env] of [
	["herdr", HERDR],
	["cmux", CMUX],
	["tmux", TMUX],
] as const) {
	test(`when ${terminal} fails to split, the error is reported and no fork session is left behind`, async () => {
		const t = setup({ ...env, FAKE_FAIL: terminal });
		t.session.appendMessage(user("hello"));
		const before = sessionFiles(t);

		await t.run("fork-right");

		assert.deepEqual(t.launches(), []);
		assert.deepEqual(sessionFiles(t), before);
		assert.equal(t.notes.at(-1)?.type, "error");
		assert.match(t.notes.at(-1)!.message, new RegExp(terminal));
	});
}
