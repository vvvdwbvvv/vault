/**
 * Cursor-style subagents for pi.
 *
 * Adds a `subagent` tool and a `/subagent` command. A subagent is a focused,
 * isolated, autonomous model loop: the parent agent delegates a detailed,
 * self-contained task to a named subagent definition, and the subagent runs
 * with its own fresh context and a restricted tool set. Multiple `subagent`
 * calls in one assistant message run concurrently (parallel subagents).
 *
 * Definitions are markdown (frontmatter + body) or JSON files. Bundled agents
 * ship under `agents/`; the user can add or override definitions in
 * `~/.pi/subagents/` (or `$PI_SUBAGENTS_DIR`).
 */

import { Type, type Static } from "typebox";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "./definitions.ts";
import { runSubagent, type SubagentOutcome } from "./runner.ts";

const SubagentParams = Type.Object({
  name: Type.String({
    description:
      "The subagent type to spawn (e.g. \"general-purpose\" or \"code-reviewer\").",
  }),
  task: Type.String({
    description:
      "Detailed, self-contained task for the subagent. Provide all necessary context: the subagent has a fresh context and cannot see your conversation. State exactly what it should return in its final report.",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional extra context (paths, constraints, background) appended to the subagent's system prompt.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional provider/model override, e.g. \"openai/gpt-5\". Defaults to the current model.",
    }),
  ),
});
type SubagentParamsT = Static<typeof SubagentParams>;

const ResultSchema = Type.Object({
  status: Type.String(),
  agent: Type.String(),
  turns: Type.Number(),
  toolsUsed: Type.Array(Type.String()),
  usage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    totalTokens: Type.Number(),
  }),
  result: Type.String(),
});

const TOOL_DESCRIPTION =
  "Delegate a complex, multi-step, exploratory, or open-ended task to a focused " +
  "subagent that runs with its own isolated context and its own tool budget. " +
  "Choose the subagent by name and pass a detailed, self-contained task. " +
  "Spawn several subagents in parallel (multiple tool calls in one message) when " +
  "independent areas can be explored concurrently. Do NOT use this for narrow " +
  "queries you can answer with one or two direct tool calls.";

export default function (pi: ExtensionAPI) {
  const agents = new AgentRegistry();
  agents.seed();
  agents.load();

  pi.on("session_start", () => {
    agents.seed();
    agents.load();
  });

  pi.registerCommand("subagent", {
    description:
      "List, inspect, or reload cursor-style subagents. Usage: /subagent [list|show <name>|reload]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");

      if (verb === "reload") {
        agents.load();
        ctx.ui.notify(`Reloaded ${agents.list().length} subagents`, "info");
        return;
      }

      if (verb === "show" && arg) {
        const def = agents.get(arg);
        if (!def) {
          ctx.ui.notify(`No subagent named "${arg}"`, "warning");
          return;
        }
        const tools =
          def.tools === "*" ? "all callable tools (except subagent)" : def.tools.join(", ");
        ctx.ui.notify(
          `${def.name} — ${def.description}\n` +
            `Tools: ${tools}\n` +
            `Max turns: ${def.maxTurns}\n` +
            `Model: ${def.model ?? "current"}\n\n` +
            def.instructions,
          "info",
        );
        return;
      }

      const defs = agents.list();
      if (defs.length === 0) {
        ctx.ui.notify("No subagents found", "warning");
        return;
      }
      if (verb && verb !== "list") {
        ctx.ui.notify(`Unknown /subagent verb "${verb}". Try: list, show <name>, reload`, "warning");
        return;
      }
      const text = defs.map((d) => `• ${d.name} — ${d.description}`).join("\n");
      ctx.ui.notify(`Subagents (${defs.length}):\n${text}`, "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    parameters: SubagentParams,
    outputSchema: ResultSchema,
    // The tool orchestrates other tools and is not itself meant to be reached
    // from child agents (we exclude it from children by default).
    executionMode: "parallel",
    execute: async (toolCallId, params: SubagentParamsT, signal, onUpdate, ctx) => {
      const def = agents.get(params.name);
      if (!def) {
        const available = agents.list().map((d) => d.name).join(", ");
        throw new Error(`Unknown subagent "${params.name}". Available: ${available}`);
      }

      let outcome: SubagentOutcome;
      try {
        outcome = await runSubagent(ctx, def, params, signal, onUpdate);
      } catch (error) {
        throw error;
      }

      const summary =
        `[subagent:${outcome.agent}] ${outcome.status === "max_turns" ? "reached turn cap; " : "done in "}` +
        `${outcome.turns} turn(s), used ${outcome.toolsUsed.length} tool(s).\n\n` +
        outcome.text;

      return {
        content: [{ type: "text", text: summary }],
        details: {
          agent: outcome.agent,
          status: outcome.status,
          turns: outcome.turns,
          toolsUsed: outcome.toolsUsed,
          usage: outcome.usage,
          result: outcome.text,
        },
        structuredContent: {
          status: outcome.status,
          agent: outcome.agent,
          turns: outcome.turns,
          toolsUsed: outcome.toolsUsed,
          usage: {
            input: outcome.usage.input,
            output: outcome.usage.output,
            totalTokens: outcome.usage.totalTokens,
          },
          result: outcome.text,
        },
        // Report the subagent's nested model usage so session totals stay accurate.
        usage: outcome.usage,
      };
    },
  });
}
