# pi-extras

Small extensions for the [Pi](https://pi.dev) coding agent.

```bash
pi install git:github.com/nicksenap/pi-extras
```

Load only one of them:

```json
{ "packages": [{ "source": "git:github.com/nicksenap/pi-extras", "extensions": ["extensions/bionic.ts"] }] }
```

## pane-fork

Fork the current conversation into a new terminal pane and keep both going. Works in herdr, tmux, and cmux.

| Command | What it does |
|---|---|
| `/fork-right [prompt]` | Split right and open the fork there |
| `/fork-down [prompt]` | Split below and open the fork there |

- Forks the active branch (respects `/tree` rewinds), not the whole session file.
- The new session records the original as its `parentSession`.
- An optional prompt is sent as the first message in the fork.
- Set `PI_FORK_ARGS` to pass extra flags to the forked `pi`, e.g. `PI_FORK_ARGS="--no-skills"`.

The terminal is detected from the environment, innermost multiplexer first:

| Terminal | Detected by | Notes |
|---|---|---|
| herdr | `HERDR_PANE_ID` | Uses `HERDR_BIN_PATH` or `herdr` on `PATH` |
| tmux | `TMUX` | Splits `TMUX_PANE` when set |
| cmux | `CMUX_SURFACE_ID` | |

Set `PI_FORK_BACKEND=herdr|tmux|cmux` to force one. Outside all of them, the command reports an error.

## bionic

Bionic reading for assistant replies and thinking: the start of each word is bolded to guide the eye.

| Command | What it does |
|---|---|
| `/bionic` | Toggle |
| `/bionic on` / `/bionic off` | Set explicitly |

- Display only. Session history and model context are untouched.
- Skips code blocks, inline code, links, URLs, paths, identifiers, headings, and text that is already bold or italic.
- Off by default each session. A `bionic` status shows while on.
- Toggling repaints the transcript by re-applying the current theme. If your `theme` setting is automatic (`light/dark`) or `system`, it skips the repaint and the change applies to new messages.
- How thick bold looks is up to your terminal font.

## License

MIT
