# Subagents for pi — a Cursor-style subagent plugin

A `pi` extension that adds **subagents**: focused, isolated, autonomous model
loops that the main agent can spawn to do heavy or exploratory work on its
behalf. The design mirrors Cursor's subagents:

- Each subagent is a **declarative definition** (name, description, tool
  allow-list, optional model override, max turns, and system instructions).
- Spawning a subagent gives it a **fresh context** — it cannot see the caller's
  conversation, so the caller must provide a detailed, self-contained task.
- Multiple `subagent` calls issued in one assistant message **run in parallel**.
- The subagent runs its own tool loop with a **restricted tool set** and returns
  a single report to the caller.

## Install

The extension is a directory extension, so it loads automatically from
`~/.pi/agent/extensions/subagents/`. Confirm it is registered:

```sh
pi
# then
/subagent
```

It should list the bundled subagents (`general-purpose`, `code-reviewer`).

## What it adds

### `subagent` tool (for the model)

The main agent calls a tool named `subagent` with:

| field | meaning |
| --- | --- |
| `name` | which subagent definition to spawn |
| `task` | detailed, self-contained task; say exactly what to return |
| `context` | (optional) extra background/paths appended to the child system prompt |
| `model` | (optional) provider/model override, e.g. `openai/gpt-5` |

The tool returns the subagent's final report plus structured metadata (turns,
tools used, and the child's token/cost usage, which is folded into the session
totals).

**When to use it:** complex, multi-step, exploratory, or open-ended work that is
not a narrow query you can answer with one or two direct tool calls. Prefer
parallel spawning when independent areas can be explored concurrently.

### `/subagent` command (for the user)

- `/subagent` — list available subagents.
- `/subagent show <name>` — inspect a definition (tools, turns, instructions).
- `/subagent reload` — re-scan the definition directories.

## Defining your own subagents

Create a markdown file in `~/.pi/subagents/` (or `$PI_SUBAGENTS_DIR`), or add
a `.json` file. Markdown format uses frontmatter + a body:

```markdown
---
name: my-reviewer
description: Reviews code and returns prioritized findings.
tools:
  - read
  - bash
max_turns: 6
model: openai/gpt-5   # optional override
thinking: medium       # optional
---

You are a specialized reviewer. Do the task...
```

Supported frontmatter fields:

| key | type | default | notes |
| --- | --- | --- | --- |
| `name` | string | filename | must be unique; user defs override bundled ones |
| `description` | string | `""` | shown to the spawning model |
| `tools` | `*` or list | `*` | `*` = all callable tools except `subagent`; otherwise an explicit allow-list |
| `model` | string | current model | `"provider/model"` override |
| `thinking` | `low|medium|high` | unset | used when the provider supports it |
| `max_turns` | int | 8 | cap on the child's tool loop, prevents runaway |
| `temperature` | number | provider default | |
| body | markdown | required | the child's system instructions |

## How it works

The subagent runs inside the `subagent` tool's `execute()`, as a nested loop:

1. Resolve the model (per-call override → definition → current session model).
2. Build the child system prompt from the definition + caller context.
3. Loop: call `ctx.modelRegistry.complete()` with the child prompt, transcript,
   and only the allowed tools. If the model emits tool calls, execute each via
   `ctx.executeTool()` (same validation/permission hooks as normal calls), feed
   the results back, and continue. Stop when the model finishes, the turn cap is
   hit, or the parent turn is aborted.
4. Return the final text plus structured details and the aggregated usage.

Because tool calls in one assistant message run in parallel, several
`subagent` calls spawned together execute concurrently.

## Files

| file | purpose |
| --- | --- |
| `index.ts` | extension entry point: registers the `subagent` tool and `/subagent` command |
| `definitions.ts` | types, YAML-lite frontmatter parser, and the agent registry |
| `runner.ts` | the autonomous subagent execution loop |
| `agents/general-purpose.md`, `agents/code-reviewer.md` | bundled example subagents |
| `test.ts` | offline unit/integration tests |

## Run the tests

```sh
npm test        # node --experimental-strip-types test.ts
```

All tests run offline (no network, no API key). Test coverage includes the
YAML-lite parser, definition loading, tool allow-list resolution, usage
aggregation, and the full subagent loop (done path, tool-call path, and the
turn-cap path) against a fake model.

## Limitations

- **In-process, not a separate process.** Subagents run inside the current pi
  process as nested model loops. They are context-isolated and parallel, but
  they share the session's credentials and permission hooks.
- **No cross-session resumption (yet).** The `task`/`resume` model of Cursor's
  cloud agents is not implemented; each spawn starts fresh.
- **Model override requires a configured provider.** If the override's provider
  lacks credentials, the current model is used instead.
- **Child tool budget is the definition's `tools` list.** With `tools: "*"`,
  the child can reach every callable tool except `subagent` itself (to prevent
  unbounded recursion).
