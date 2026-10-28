# always-on

Persistent agent workers for pi: each worker is a full, interactive pi session
living in its own detached tmux session, so it survives terminal-window closes.

The main agent can spawn workers, feed them prompts, and read their screens; a
human can take a worker over at any time with `tmux attach`.

## Why

A worker is an independent pi process with its own conversation history and
working directory. It keeps running after you close the window or quit the
terminal app — the main session and the worker do not share state.

Caveats:

- The machine sleeping (lid closed / idle) pauses workers too.
- Reboot clears all tmux sessions; workers are not persisted across reboot.

## Tools (for the agent)

| Tool | Purpose |
|---|---|
| `always_on_start` | Start a worker (`name`, optional `dir`) |
| `always_on_send` | Type text into a worker and press Enter (`name`, `text`) |
| `always_on_log` | Read the worker's screen (`name`, optional `lines`) |
| `always_on_status` | List workers / check one worker (`name` optional) |
| `always_on_stop` | Stop a worker (`name`) |

All tools live in the namespace `always-on` (alias `alwayson`).

## Command (for humans)

Behaves like `/subagent`:

- `/always-on` or `/always-on list` — list running workers
- `/always-on show <name>` — inspect one worker (directory + last screen excerpt)
- `/always-on run <name> <task>` — delegate a task like a subagent: sends the
  task, waits until the worker settles, then reports the worker's reply
- `/always-on start [name] [dir]` — start a worker
- `/always-on stop <name>` — stop a worker
- `/always-on attach <name>` — print the `tmux attach` command for a human takeover

## Configuration (environment variables)

- `ALWAYS_ON_WORKERS_DIR` — worker working-directory root (default `~/.pi/workers`)
- `ALWAYS_ON_PI_BIN` — pi binary for workers (default `pi`)
- `ALWAYS_ON_PI_ARGS` — extra args passed to worker pi, e.g.
  `ALWAYS_ON_PI_ARGS="--provider openai --model gpt-5"` to pin a provider/model.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # functional smoke test (starts/stops a real worker)
```
