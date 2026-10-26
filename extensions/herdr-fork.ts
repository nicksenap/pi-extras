import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";

// /fork-right [prompt]  — fork the current conversation into a new herdr pane on the right.
// /fork-down  [prompt]  — same, split below.
// /fork-right-from [prompt], /fork-down-from [prompt] — pick a point in pi's /tree view (any branch); the fork
//   keeps history up to it, rewinding to just before a picked user message, as /tree does.
// Optional prompt is sent as the first message in the forked session.
// Extra flags for the forked pi can be set with PI_FORK_ARGS, e.g. PI_FORK_ARGS="--no-skills".

type Direction = "right" | "down";
type Failure = { error: string };

/** Run the herdr CLI synchronously and capture its combined output. */
function runHerdr(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", timeout: 5000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Split the current herdr pane in `direction`, then run `command` in the new pane. */
function openPane(paneId: string, direction: Direction, cwd: string, command: string): Failure | undefined {
  const split = runHerdr(["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--focus"]);
  if (!split.ok) return { error: `herdr split failed: ${split.out}` };
  let newPane: string | undefined;
  try {
    newPane = JSON.parse(split.out).result?.pane?.pane_id;
  } catch {}
  if (!newPane) return { error: `Could not parse new herdr pane id: ${split.out}` };
  const run = runHerdr(["pane", "run", newPane, command]);
  if (!run.ok) return { error: `herdr run failed: ${run.out}` };
}

/**
 * Write the *active branch* (root→current leaf, so /tree rewinds are respected) into a new session file
 * that links back to the current one. Built by hand because SessionManager.createBranchedSession switches
 * the live session over to the new file, and SessionManager.forkFrom copies the whole tree from disk
 * (which may not be flushed yet).
 */
function writeForkFile(
  sm: ExtensionCommandContext["sessionManager"],
  uptoId?: string | null,
): { forkFile: string } | Failure {
  // uptoId === null means "before the first entry": fork with an empty history.
  const branch = uptoId === null ? [] : sm.getBranch(uptoId);
  if (branch.length === 0 && uptoId !== null) return { error: "Nothing to fork yet." };

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

/**
 * Let the user pick a point in the session tree with pi's own /tree selector. Same rule as /tree: picking a
 * user or custom message forks from just before it; picking anything else forks up to and including it.
 * Resolves to the last entry id to keep (null = empty history), or undefined if cancelled.
 */
async function pickForkPoint(ctx: ExtensionCommandContext): Promise<string | null | undefined> {
  const sm = ctx.sessionManager;
  const tree = sm.getTree();
  if (tree.length === 0) {
    ctx.ui.notify("Nothing to fork yet.", "error");
    return undefined;
  }
  const picked = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keys, done) =>
      new TreeSelectorComponent(tree, sm.getLeafId(), tui.terminal.rows, (id) => done(id), () => done(undefined)),
  );
  if (picked === undefined) return undefined;
  const entry = sm.getEntry(picked);
  if (!entry) return undefined;
  const rewinds = (entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message";
  return rewinds ? entry.parentId : entry.id;
}

async function forkInto(direction: Direction, prompt: string, ctx: ExtensionCommandContext, pick = false) {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return ctx.ui.notify("Not inside a herdr pane (HERDR_PANE_ID is not set).", "error");

  let uptoId: string | null | undefined;
  if (pick) {
    uptoId = await pickForkPoint(ctx);
    if (uptoId === undefined) return;
  }

  const written = writeForkFile(ctx.sessionManager, uptoId);
  if ("error" in written) return ctx.ui.notify(written.error, "error");
  const { forkFile } = written;

  const extra = process.env.PI_FORK_ARGS?.trim();
  let cmd = `pi${extra ? ` ${extra}` : ""} --session ${shellQuote(forkFile)}`;
  if (prompt.trim()) cmd += ` ${shellQuote(prompt.trim())}`;

  let failure: Failure | undefined;
  try {
    failure = openPane(paneId, direction, ctx.sessionManager.getCwd(), cmd);
  } catch (e) {
    failure = { error: `herdr failed: ${(e as Error).message}` };
  }
  if (failure) {
    rmSync(forkFile, { force: true });
    return ctx.ui.notify(failure.error, "error");
  }
  ctx.ui.notify(`Forked into a new herdr pane (${direction}).`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fork-right", {
    description: "Fork this conversation into a new herdr pane on the right",
    handler: (args, ctx) => forkInto("right", args ?? "", ctx),
  });
  pi.registerCommand("fork-down", {
    description: "Fork this conversation into a new herdr pane below",
    handler: (args, ctx) => forkInto("down", args ?? "", ctx),
  });
  pi.registerCommand("fork-right-from", {
    description: "Pick a point in the session tree and fork from it into a new herdr pane on the right",
    handler: (args, ctx) => forkInto("right", args ?? "", ctx, true),
  });
  pi.registerCommand("fork-down-from", {
    description: "Pick a point in the session tree and fork from it into a new herdr pane below",
    handler: (args, ctx) => forkInto("down", args ?? "", ctx, true),
  });
}
