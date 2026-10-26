# pi-extras

Small extensions for the [Pi](https://pi.dev) coding agent.

```bash
pi install git:github.com/nicksenap/pi-extras@v0.4.0
```

Pinned to a release tag; drop `@v0.4.0` to track `main`. Releases are listed under [tags](https://github.com/nicksenap/pi-extras/tags).

Load only one of them:

```json
{ "packages": [{ "source": "git:github.com/nicksenap/pi-extras@v0.4.0", "extensions": ["extensions/bionic.ts"] }] }
```

## herdr-fork

Fork the current conversation into a new herdr pane and keep both going.

| Command | What it does |
|---|---|
| `/fork-right [prompt]` | Split right and open the fork there |
| `/fork-down [prompt]` | Split below and open the fork there |
| `/fork-right-from [prompt]` | Pick an earlier user message; fork from just before it, split right |
| `/fork-down-from [prompt]` | Same, split below |

- Forks the active branch (respects `/tree` rewinds), not the whole session file.
- The new session records the original as its `parentSession`.
- An optional prompt is sent as the first message in the fork.
- Set `PI_FORK_ARGS` to pass extra flags to the forked `pi`, e.g. `PI_FORK_ARGS="--no-skills"`.

Requires running Pi inside a herdr pane (`HERDR_PANE_ID` set). Uses `HERDR_BIN_PATH` or `herdr` on `PATH`.

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
