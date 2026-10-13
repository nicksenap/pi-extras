import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// /fork-right [prompt]  — fork the current conversation into a new Herdr pane on the right.
// /fork-down  [prompt]  — same, split below.
// Optional prompt is sent as the first message in the forked session.
// Extra flags for the forked pi can be set with PI_FORK_ARGS, e.g. PI_FORK_ARGS="--no-skills".

function herdr(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", timeout: 5000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function forkInto(direction: "right" | "down", prompt: string, ctx: ExtensionCommandContext) {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return ctx.ui.notify("Not inside a Herdr pane.", "error");

  // Fork the *active branch* (respects /tree rewinds), not the whole file:
  // write root→current-leaf into a new session file and open it with --session.
  const sm = ctx.sessionManager;
  const branch = sm.getBranch();
  if (branch.length === 0) return ctx.ui.notify("Nothing to fork yet.", "error");

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
    return ctx.ui.notify(`Failed to write fork: ${(e as Error).message}`, "error");
  }

  const cwd = ctx.sessionManager.getCwd();
  const split = herdr(["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--focus"]);
  if (!split.ok) return ctx.ui.notify(`herdr split failed: ${split.out}`, "error");

  let newPane: string | undefined;
  try {
    newPane = JSON.parse(split.out).result?.pane?.pane_id;
  } catch {}
  if (!newPane) return ctx.ui.notify(`Could not parse new pane id: ${split.out}`, "error");

  const extra = process.env.PI_FORK_ARGS?.trim();
  let cmd = `pi${extra ? ` ${extra}` : ""} --session ${shq(forkFile)}`;
  if (prompt.trim()) cmd += ` ${shq(prompt.trim())}`;
  const run = herdr(["pane", "run", newPane, cmd]);
  if (!run.ok) return ctx.ui.notify(`herdr run failed: ${run.out}`, "error");

  ctx.ui.notify(`Forked into pane ${newPane} (${direction}).`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-right", {
    description: "Fork this conversation into a new Herdr pane on the right",
    handler: (args, ctx) => forkInto("right", args ?? "", ctx),
  });
  pi.registerCommand("fork-down", {
    description: "Fork this conversation into a new Herdr pane below",
    handler: (args, ctx) => forkInto("down", args ?? "", ctx),
  });
}
