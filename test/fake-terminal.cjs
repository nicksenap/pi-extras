// Fake terminal multiplexers for tests: emulates the herdr, cmux, and tmux CLIs at their
// command-line boundary. A split records { terminal, direction } in $FAKE_STATE, and whatever
// the new pane is told to run is executed through `sh` in that pane's cwd, like a real shell.
// Set FAKE_FAIL=<terminal> to make that CLI fail.
const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const [terminal, ...args] = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));

if (process.env.FAKE_FAIL === terminal) {
	process.stderr.write(`${terminal}: simulated failure\n`);
	process.exit(1);
}

function option(name) {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

function newPane(direction, cwd) {
	const id = `${terminal}-pane-${state.panes.length + 1}`;
	state.panes.push({ id, cwd });
	state.splits.push({ terminal, direction });
	save();
	return id;
}

function runInPane(id, command) {
	const pane = state.panes.find((p) => p.id === id);
	if (!pane) {
		process.stderr.write(`${terminal}: no such pane ${id}\n`);
		process.exit(1);
	}
	execSync(command, { cwd: pane.cwd, shell: "/bin/sh", stdio: "inherit", env: process.env });
}

// A new pane's shell starts somewhere other than the session cwd unless told otherwise.
const DEFAULT_CWD = "/";

if (terminal === "herdr") {
	// herdr pane split <pane> --direction <right|down> --cwd <dir> [--focus]
	// herdr pane run <pane> <command>
	if (args[0] === "pane" && args[1] === "split") {
		const id = newPane(option("--direction"), option("--cwd") ?? DEFAULT_CWD);
		process.stdout.write(JSON.stringify({ result: { pane: { pane_id: id } } }));
	} else if (args[0] === "pane" && args[1] === "run") {
		runInPane(args[2], args[3]);
	} else process.exit(2);
} else if (terminal === "cmux") {
	// cmux [--json] [--id-format f] new-split <dir> [--focus true|false] [--surface id]
	// cmux send [--surface id] <text>     (\n in text means Enter)
	const rest = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--json") continue;
		if (args[i] === "--id-format") {
			i++;
			continue;
		}
		rest.push(args[i]);
	}
	const json = args.includes("--json");
	if (rest[0] === "new-split") {
		const id = newPane(rest[1], DEFAULT_CWD);
		const ref = `surface:${state.panes.length}`;
		state.panes.at(-1).ref = ref;
		save();
		process.stdout.write(json ? JSON.stringify({ surface_ref: ref, surface_id: id, pane_ref: "pane:9" }) : `OK ${ref} workspace:1\n`);
	} else if (rest[0] === "send") {
		const si = rest.indexOf("--surface");
		const target = si === -1 ? process.env.CMUX_SURFACE_ID : rest[si + 1];
		const text = rest.filter((_, i) => i !== 0 && i !== si && i !== si + 1).join(" ");
		const pane = state.panes.find((p) => p.ref === target || p.id === target);
		if (!pane) process.exit(1);
		const typed = text.replace(/\\n/g, "\n");
		if (typed.endsWith("\n")) runInPane(pane.id, typed.slice(0, -1));
	} else process.exit(2);
} else if (terminal === "tmux") {
	// tmux split-window [-h|-v] [-t target] [-c cwd] [-P] [-F fmt] [command]
	if (args[0] !== "split-window") process.exit(2);
	const flagsWithValue = new Set(["-t", "-c", "-F", "-l", "-e"]);
	let command;
	for (let i = 1; i < args.length; i++) {
		if (flagsWithValue.has(args[i])) i++;
		else if (!args[i].startsWith("-")) command = args[i];
	}
	const direction = args.includes("-h") ? "right" : "down";
	const id = newPane(direction, option("-c") ?? DEFAULT_CWD);
	if (command) runInPane(id, command);
} else process.exit(2);
