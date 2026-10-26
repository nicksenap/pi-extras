// Fake herdr CLI for tests: emulates `herdr pane split` / `herdr pane run` at the command-line boundary.
// A split records { direction } in $FAKE_STATE (and its focus flag in `focus`), and whatever the new pane is told to run is executed
// through `sh` in that pane's cwd, like a real shell. Set FAKE_FAIL=1 to make the CLI fail.
const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state));

if (process.env.FAKE_FAIL) {
	process.stderr.write("herdr: simulated failure\n");
	process.exit(1);
}

function option(name) {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

// herdr pane split <pane> --direction <right|down> --cwd <dir> [--focus|--no-focus]
if (args[0] === "pane" && args[1] === "split") {
	const id = `herdr-pane-${state.panes.length + 1}`;
	// A new pane's shell starts somewhere other than the session cwd unless told otherwise.
	state.panes.push({ id, cwd: option("--cwd") ?? "/" });
	state.splits.push({ direction: option("--direction") });
	state.focus.push(args.find((a) => a === "--focus" || a === "--no-focus"));
	save();
	process.stdout.write(JSON.stringify({ result: { pane: { pane_id: id } } }));
	// herdr pane run <pane> <command>
} else if (args[0] === "pane" && args[1] === "run") {
	const pane = state.panes.find((p) => p.id === args[2]);
	if (!pane) {
		process.stderr.write(`herdr: no such pane ${args[2]}\n`);
		process.exit(1);
	}
	execSync(args[3], { cwd: pane.cwd, shell: "/bin/sh", stdio: "inherit", env: process.env });
} else process.exit(2);
