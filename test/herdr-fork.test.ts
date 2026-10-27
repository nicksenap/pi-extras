import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import herdrFork from "../extensions/herdr-fork.ts";

const FAKE_HERDR = join(import.meta.dirname, "fake-herdr.cjs");
const FORK_ENV = ["HERDR_PANE_ID", "HERDR_BIN_PATH", "PI_FORK_ARGS"];
const savedEnv = { ...process.env };
const tempRoots: string[] = [];

const HERDR = { HERDR_PANE_ID: "herdr-pane-0" };

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Launch = { argv: string[]; cwd: string };

/** A project with a real Pi session, a fake `herdr` CLI and a fake `pi` on PATH. */
/** `pick` stands in for the /tree selector: it returns the entry id the user selects, or undefined to cancel. */
function setup(env: Record<string, string>, pick?: () => string | undefined) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-fork-")));
	tempRoots.push(root);
	const project = join(root, "project");
	const bin = join(root, "bin");
	mkdirSync(project);
	mkdirSync(bin);

	const statePath = join(root, "state.json");
	const piLog = join(root, "pi-launches.jsonl");
	writeFileSync(statePath, JSON.stringify({ panes: [], splits: [] }));
	writeFileSync(piLog, "");
	writeFileSync(join(bin, "herdr"), `#!/bin/sh\nexec node "${FAKE_HERDR}" "$@"\n`);
	chmodSync(join(bin, "herdr"), 0o755);
	writeFileSync(
		join(bin, "pi"),
		`#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(piLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");\n`,
	);
	chmodSync(join(bin, "pi"), 0o755);

	for (const key of FORK_ENV) delete process.env[key];
	Object.assign(process.env, { PATH: `${bin}:${savedEnv.PATH}`, FAKE_STATE: statePath }, env);

	const session = SessionManager.create(project, join(root, "sessions"));
	const commands: Record<string, (args: string, ctx: unknown) => unknown> = {};
	herdrFork({ registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => unknown }) => (commands[name] = opts.handler) } as never);
	const notes: { message: string; type?: string }[] = [];
	const ctx = { sessionManager: session, ui: {
			notify: (message: string, type?: string) => notes.push({ message, type }),
			custom: async () => pick?.(),
		},
	};

	return {
		session,
		project,
		notes,
		run: async (command: string, args = "") => {
			await commands[command](args, ctx);
		},
		splits: (): { direction: string }[] => JSON.parse(readFileSync(statePath, "utf8")).splits,
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

for (const [command, direction] of [
	["fork-right", "right"],
	["fork-down", "down"],
] as const) {
	test(`/${command} opens the conversation in a new herdr pane (${direction})`, async () => {
		const t = setup(HERDR);
		t.session.appendMessage(user("hello"));
		t.session.appendMessage(assistant("hi there"));

		await t.run(command);

		assert.deepEqual(t.splits(), [{ direction }]);
		assert.equal(t.launches().length, 1);
		const [launch] = t.launches();
		assert.equal(launch.cwd, t.project);
		assert.deepEqual(transcript(sessionArg(launch)), ["hello", "hi there"]);
	});
}

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
	const t = setup(HERDR);
	t.session.appendMessage(user("hello"));

	await t.run("fork-right", "  try the other approach, don't 'refactor' yet  ");

	assert.equal(t.launches()[0].argv.at(-1), "try the other approach, don't 'refactor' yet");
});

test("PI_FORK_ARGS flags are passed to the forked pi", async () => {
	const t = setup({ ...HERDR, PI_FORK_ARGS: "--no-skills --skill-profile pocock" });
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

test("outside a herdr pane, /fork-right reports an error and forks nothing", async () => {
	const t = setup({});
	t.session.appendMessage(user("hello"));
	const before = sessionFiles(t);

	await t.run("fork-right");

	assert.deepEqual(t.splits(), []);
	assert.deepEqual(t.launches(), []);
	assert.deepEqual(sessionFiles(t), before);
	assert.equal(t.notes.at(-1)?.type, "error");
});

test("when herdr fails to split, the error is reported and no fork session is left behind", async () => {
	const t = setup({ ...HERDR, FAKE_FAIL: "1" });
	t.session.appendMessage(user("hello"));
	const before = sessionFiles(t);

	await t.run("fork-right");

	assert.deepEqual(t.launches(), []);
	assert.deepEqual(sessionFiles(t), before);
	assert.equal(t.notes.at(-1)?.type, "error");
	assert.match(t.notes.at(-1)!.message, /herdr split failed/);
});

test("/fork-right-from on a user message forks from just before it", async () => {
	let target = "";
	const t = setup(HERDR, () => target);
	t.session.appendMessage(user("first question"));
	t.session.appendMessage(assistant("first answer"));
	target = t.session.appendMessage(user("second question"));
	t.session.appendMessage(assistant("second answer"));

	await t.run("fork-right-from");

	assert.deepEqual(t.splits(), [{ direction: "right" }]);
	assert.deepEqual(transcript(sessionArg(t.launches()[0])), ["first question", "first answer"]);
});

test("/fork-right-from on an assistant message keeps it in the fork", async () => {
	let target = "";
	const t = setup(HERDR, () => target);
	t.session.appendMessage(user("first question"));
	target = t.session.appendMessage(assistant("first answer"));
	t.session.appendMessage(user("second question"));

	await t.run("fork-right-from");

	assert.deepEqual(transcript(sessionArg(t.launches()[0])), ["first question", "first answer"]);
});

test("/fork-right-from can fork from an abandoned branch", async () => {
	let target = "";
	const t = setup(HERDR, () => target);
	t.session.appendMessage(user("start"));
	const kept = t.session.appendMessage(assistant("first answer"));
	t.session.appendMessage(user("abandoned question"));
	target = t.session.appendMessage(assistant("abandoned answer"));
	t.session.branch(kept);
	t.session.appendMessage(user("better question"));

	await t.run("fork-right-from");

	assert.deepEqual(transcript(sessionArg(t.launches()[0])), ["start", "first answer", "abandoned question", "abandoned answer"]);
});

test("/fork-down-from on the first message forks an empty conversation", async () => {
	let target = "";
	const t = setup(HERDR, () => target);
	target = t.session.appendMessage(user("first question"));
	t.session.appendMessage(assistant("first answer"));

	await t.run("fork-down-from", "start over");

	assert.deepEqual(t.splits(), [{ direction: "down" }]);
	const [launch] = t.launches();
	assert.deepEqual(transcript(sessionArg(launch)), []);
	assert.equal(launch.argv.at(-1), "start over");
});

test("cancelling the /fork-right-from picker forks nothing", async () => {
	const t = setup(HERDR, () => undefined);
	t.session.appendMessage(user("hello"));
	const before = sessionFiles(t);

	await t.run("fork-right-from");

	assert.deepEqual(t.splits(), []);
	assert.deepEqual(sessionFiles(t), before);
});

for (const [command, direction] of [
	["new-right", "right"],
	["new-down", "down"],
] as const) {
	test(`/${command} opens a fresh pi session in a new herdr pane (${direction})`, async () => {
		const t = setup(HERDR);
		t.session.appendMessage(user("hello"));
		const before = sessionFiles(t);

		await t.run(command);

		assert.deepEqual(t.splits(), [{ direction }]);
		const [launch] = t.launches();
		assert.equal(launch.cwd, t.project);
		assert.deepEqual(launch.argv, []);
		assert.deepEqual(sessionFiles(t), before);
	});
}

test("/new-right passes PI_FORK_ARGS and the prompt to the new pi", async () => {
	const t = setup({ ...HERDR, PI_FORK_ARGS: "--no-skills" });

	await t.run("new-right", "  look at 'the logs'  ");

	assert.deepEqual(t.launches()[0].argv, ["--no-skills", "look at 'the logs'"]);
});

test("outside a herdr pane, /new-right reports an error and opens nothing", async () => {
	const t = setup({});

	await t.run("new-right");

	assert.deepEqual(t.splits(), []);
	assert.deepEqual(t.launches(), []);
	assert.equal(t.notes.at(-1)?.type, "error");
});
