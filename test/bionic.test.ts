import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import bionicExtension, { bionic } from "../extensions/bionic.ts";

test("bolds the start of each word in prose", () => {
	assert.equal(bionic("Reading faster"), "**Read**ing **fas**ter");
	assert.equal(bionic("a cat"), "a **c**at");
});

test("leaves code, links, URLs, paths, identifiers and existing emphasis alone", () => {
	for (const span of [
		"`inline code`",
		"[link text](https://example.com)",
		"[reference link][ref]",
		"![alt text](img.png)",
		"<https://example.com>",
		"https://example.com/page",
		"src/extensions/bionic.ts",
		"snake_case_name",
		"getBranch",
		"SessionManager",
		"**already bold**",
		"*already italic*",
	]) {
		assert.equal(bionic(span), span, span);
	}
});

test("skips ATX and setext headings", () => {
	assert.equal(bionic("# Heading words"), "# Heading words");
	assert.equal(bionic("Heading words\n====="), "Heading words\n=====");
	assert.equal(bionic("Heading words\n-----"), "Heading words\n-----");
});

test("skips fenced code, closing only on a matching fence at least as long", () => {
	const md = "````\nouter code\n```\nstill code\n````\nprose";
	assert.equal(bionic(md), "````\nouter code\n```\nstill code\n````\n**pro**se");
	assert.equal(bionic("~~~\ncode\n```\nmore code"), "~~~\ncode\n```\nmore code");
});

test("skips every line of an indented code block", () => {
	const md = "Intro\n\n    first line\n    second line\n\n    after blank\nOutro";
	assert.equal(bionic(md), "**Int**ro\n\n    first line\n    second line\n\n    after blank\n**Out**ro");
});

// --- /bionic command repaint ----------------------------------------------------------

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempRoots: string[] = [];

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run `/bionic on` with the given global/project theme settings and active theme; return whether it repainted. */
async function toggleRepaints(opts: { global?: string; project?: string; active: string }): Promise<boolean> {
	const root = mkdtempSync(join(tmpdir(), "bionic-"));
	tempRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	if (opts.global) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: opts.global }));
	if (opts.project) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: opts.project }));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	let handler!: (args: string, ctx: unknown) => Promise<void>;
	bionicExtension({
		registerMarkdownTransformer: () => {},
		registerCommand: (_: string, o: { handler: typeof handler }) => (handler = o.handler),
	} as never);
	const setThemeCalls: string[] = [];
	await handler("on", {
		cwd,
		ui: {
			theme: { name: opts.active },
			setTheme: (name: string) => (setThemeCalls.push(name), { success: true }),
			setStatus: () => {},
			notify: () => {},
		},
	});
	return setThemeCalls.length > 0;
}

test("repaints when the theme setting is the plain active theme", async () => {
	assert.equal(await toggleRepaints({ global: "dark", active: "dark" }), true);
});

test("does not repaint for an automatic or system theme setting", async () => {
	assert.equal(await toggleRepaints({ global: "light/dark", active: "dark" }), false);
	assert.equal(await toggleRepaints({ global: "system", active: "system" }), false);
});

test("does not repaint when a project setting overrides the global one", async () => {
	assert.equal(await toggleRepaints({ global: "dark", project: "light/dark", active: "dark" }), false);
	assert.equal(await toggleRepaints({ global: "light/dark", project: "dark", active: "dark" }), false);
});
