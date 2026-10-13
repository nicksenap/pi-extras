import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// /fork-right [prompt]  — fork the current conversation into a new pane on the right.
// /fork-down  [prompt]  — same, split below.
// The terminal (herdr, tmux, cmux) is detected from the environment, or forced with PI_FORK_BACKEND.
// Optional prompt is sent as the first message in the forked session.
// Extra flags for the forked pi can be set with PI_FORK_ARGS, e.g. PI_FORK_ARGS="--no-skills".

type Direction = "right" | "down";
type Failure = { error: string };

/** Run a CLI synchronously and capture its combined output. */
function runCapture(bin: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface Backend {
  name: string;
  /** Why this backend can't be used right now, if anything. Checked when the backend is forced. */
  unavailable?(): Failure | undefined;
  /** Open a new pane in `direction` that runs `command` in `cwd`. */
  open(direction: Direction, cwd: string, command: string): Failure | undefined;
}

/** Split a pane, read the new pane's id from the CLI's JSON output, then run something in it. */
function splitThenRun(
  name: string,
  split: () => { ok: boolean; out: string },
  parseId: (json: any) => string | undefined,
  run: (id: string) => { ok: boolean; out: string },
): Failure | undefined {
  const created = split();
  if (!created.ok) return { error: `${name} split failed: ${created.out}` };
  let id: string | undefined;
  try {
    id = parseId(JSON.parse(created.out));
  } catch {}
  if (!id) return { error: `Could not parse new ${name} pane id: ${created.out}` };
  const ran = run(id);
  if (!ran.ok) return { error: `${name} run failed: ${ran.out}` };
}

const herdr: Backend = {
  name: "herdr",
  unavailable: () => (process.env.HERDR_PANE_ID ? undefined : { error: "herdr needs HERDR_PANE_ID; run pi inside a herdr pane." }),
  open(direction, cwd, command) {
    const bin = process.env.HERDR_BIN_PATH || "herdr";
    return splitThenRun(
      "herdr",
      () => runCapture(bin, ["pane", "split", process.env.HERDR_PANE_ID!, "--direction", direction, "--cwd", cwd, "--focus"]),
      (out) => out.result?.pane?.pane_id,
      (pane) => runCapture(bin, ["pane", "run", pane, command]),
    );
  },
};

const cmux: Backend = {
  name: "cmux",
  open(direction, cwd, command) {
    return splitThenRun(
      "cmux",
      () => runCapture("cmux", ["--json", "new-split", direction, "--focus", "true"]),
      (out) => out.surface_ref ?? out.surface_id,
      (surface) => runCapture("cmux", ["send", "--surface", surface, `cd ${shellQuote(cwd)} && ${command}\\n`]),
    );
  },
};

const tmux: Backend = {
  name: "tmux",
  open(direction, cwd, command) {
    const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
    const split = runCapture("tmux", ["split-window", direction === "right" ? "-h" : "-v", ...target, "-c", cwd, command]);
    if (!split.ok) return { error: `tmux split failed: ${split.out}` };
  },
};

const backends = new Map<string, Backend>([herdr, tmux, cmux].map((b) => [b.name, b]));

function detectBackend(): { backend: Backend } | Failure {
  const forced = process.env.PI_FORK_BACKEND?.trim();
  if (forced) {
    const backend = backends.get(forced);
    if (!backend) return { error: `Unknown PI_FORK_BACKEND "${forced}" (use ${[...backends.keys()].join(", ")}).` };
    return backend.unavailable?.() ?? { backend };
  }
  // Multiplexers before terminal apps: the innermost one wins when they are nested.
  if (process.env.HERDR_PANE_ID) return { backend: herdr };
  if (process.env.TMUX) return { backend: tmux };
  if (process.env.CMUX_SURFACE_ID) return { backend: cmux };
  return { error: "Not inside a supported terminal pane (herdr, tmux, cmux)." };
}

/**
 * Write the *active branch* (root→current leaf, so /tree rewinds are respected) into a new session file
 * that links back to the current one. Built by hand because SessionManager.createBranchedSession switches
 * the live session over to the new file, and SessionManager.forkFrom copies the whole tree from disk
 * (which may not be flushed yet).
 */
function writeForkFile(sm: ExtensionCommandContext["sessionManager"]): { forkFile: string } | Failure {
  const branch = sm.getBranch();
  if (branch.length === 0) return { error: "Nothing to fork yet." };

  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const forkFile = join(sm.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp,
    cwd: sm.getCwd(),
    parentSession: sm.getSessionFile(),
  };
  try {
    writeFileSync(forkFile, [header, ...branch].map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "wx" });
  } catch (e) {
    return { error: `Failed to write fork: ${(e as Error).message}` };
  }
  return { forkFile };
}

async function forkInto(direction: Direction, prompt: string, ctx: ExtensionCommandContext) {
  const detected = detectBackend();
  if ("error" in detected) return ctx.ui.notify(detected.error, "error");
  const { backend } = detected;

  const written = writeForkFile(ctx.sessionManager);
  if ("error" in written) return ctx.ui.notify(written.error, "error");
  const { forkFile } = written;

  const extra = process.env.PI_FORK_ARGS?.trim();
  let cmd = `pi${extra ? ` ${extra}` : ""} --session ${shellQuote(forkFile)}`;
  if (prompt.trim()) cmd += ` ${shellQuote(prompt.trim())}`;

  let failure: Failure | undefined;
  try {
    failure = backend.open(direction, ctx.sessionManager.getCwd(), cmd);
  } catch (e) {
    failure = { error: `${backend.name} failed: ${(e as Error).message}` };
  }
  if (failure) {
    rmSync(forkFile, { force: true });
    return ctx.ui.notify(failure.error, "error");
  }
  ctx.ui.notify(`Forked into a new ${backend.name} pane (${direction}).`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-right", {
    description: "Fork this conversation into a new terminal pane on the right",
    handler: (args, ctx) => forkInto("right", args ?? "", ctx),
  });
  pi.registerCommand("fork-down", {
    description: "Fork this conversation into a new terminal pane below",
    handler: (args, ctx) => forkInto("down", args ?? "", ctx),
  });
}
