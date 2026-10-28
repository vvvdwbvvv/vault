/**
 * Subagent execution loop.
 *
 * A subagent is an autonomous, freshly-contexted model loop run inside a tool's
 * `execute()`: one "turn" is a `modelRegistry.complete()` call (with the
 * subagent's system prompt and a restricted tool set); if the model asks for
 * tools, they are run through `ctx.executeTool()`, their results are fed back,
 * and the loop continues until the model stops, hits the turn cap, or is
 * aborted. Multiple `subagent` calls issued in a single assistant message run
 * concurrently, giving Cursor-style parallel subagents.
 */

import type {
  AgentToolUpdateCallback,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";
import type { AgentDef } from "./definitions.ts";

/** Aggregate usage across the subagent's nested model calls. */
export interface UsedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export const zeroUsage = (): UsedUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function addUsage(
  a: UsedUsage,
  b?: Partial<Omit<UsedUsage, "cost">> & { cost?: UsedUsage["cost"] },
): UsedUsage {
  return {
    input: a.input + (b?.input ?? 0),
    output: a.output + (b?.output ?? 0),
    cacheRead: a.cacheRead + (b?.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b?.cacheWrite ?? 0),
    totalTokens: a.totalTokens + (b?.totalTokens ?? 0),
    cost: {
      input: a.cost.input + (b?.cost?.input ?? 0),
      output: a.cost.output + (b?.cost?.output ?? 0),
      cacheRead: a.cost.cacheRead + (b?.cost?.cacheRead ?? 0),
      cacheWrite: a.cost.cacheWrite + (b?.cost?.cacheWrite ?? 0),
      total: a.cost.total + (b?.cost?.total ?? 0),
    },
  };
}

/** Tools we never hand to a child by default (prevents unbounded recursion). */
const SELF_TOOLS = new Set(["subagent"]);

/** Resolve the tool declarations to hand to the child model. */
export function buildToolDecls(
  ctx: Pick<ExtensionToolContext, "tools">,
  def: AgentDef,
  excluded: ReadonlySet<string> = SELF_TOOLS,
) {
  const callable = ctx.tools;
  const byName = new Map(callable.map((tool) => [tool.name, tool]));
  const names: string[] =
    def.tools === "*"
      ? callable.map((tool) => tool.name).filter((name) => !excluded.has(name))
      : def.tools;
  return names.map((name) => byName.get(name)).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
}

export interface SubagentParams {
  name: string;
  task: string;
  context?: string;
  model?: string;
}

/** Resolve the chat model for this subagent (per-call override, def, then current). */
export function resolveModel(
  ctx: Pick<ExtensionToolContext, "modelRegistry" | "model">,
  def: AgentDef,
  params?: Pick<SubagentParams, "model">,
): Model<any> | undefined {
  const spec = params?.model || def.model;
  if (spec && spec.includes("/")) {
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const candidate = ctx.modelRegistry.find(provider, id);
    if (candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)) return candidate;
  }
  return ctx.model;
}

/** Concatenate the plain-text portion of an assistant message. */
export function assistantText(assistant: AssistantMessage): string {
  return assistant.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Build the child system prompt from a definition plus optional caller context. */
export function buildSystemPrompt(def: AgentDef, contextStr?: string): string {
  const lines: string[] = [];
  lines.push(`# Subagent: ${def.name}`);
  lines.push("");
  lines.push(`You are a specialized subagent named "${def.name}" spawned by the main agent.`);
  lines.push("");
  lines.push("## Your role");
  lines.push(def.instructions);
  lines.push("");
  lines.push("## Operating rules");
  lines.push("- You have a fresh context: you cannot see the caller's conversation or prior steps.");
  lines.push("- Work autonomously using only the tools made available to you.");
  lines.push("- Be thorough and self-contained; re-read any files you need.");
  lines.push("- When finished, give a concise final report that delivers exactly what you were asked to return.");
  lines.push("- If the request is ambiguous or you are genuinely stuck, say so plainly instead of guessing.");
  if (contextStr) {
    lines.push("");
    lines.push("## Additional context from the caller");
    lines.push(contextStr);
  }
  return lines.join("\n");
}

function toolResultMessage(call: ToolCall, outcome: AgentToolCallOutcomeLike): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: outcome.result.content,
    details: outcome.result.details as never,
    isError: outcome.isError,
    timestamp: Date.now(),
  };
}

/** Minimal structural shape of `ctx.executeTool()`'s return value. */
export interface AgentToolCallOutcomeLike {
  result: { content: ToolResultMessage["content"]; details?: unknown };
  isError: boolean;
}

export interface SubagentOutcome {
  status: "done" | "max_turns";
  text: string;
  stopReason?: string;
  turns: number;
  toolsUsed: string[];
  usage: UsedUsage;
  agent: string;
}

const taskText = (task: string): string => `# Task\n\n${task.trim()}`;

/**
 * Run a subagent to completion.
 *
 * @param ctx tool execution context (provides `modelRegistry`, `tools`, `executeTool`)
 * @param def the subagent definition
 * @param params the caller-supplied task / overrides
 * @param signal abort signal from the parent turn
 * @param onUpdate progress callback forwarded to nested tool calls
 */
export async function runSubagent(
  ctx: ExtensionToolContext,
  def: AgentDef,
  params: SubagentParams,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<SubagentOutcome> {
  const model = resolveModel(ctx, def, params);
  if (!model) throw new Error(`No usable chat model for subagent "${def.name}"`);

  const tools = buildToolDecls(ctx, def);
  const systemPrompt = buildSystemPrompt(def, params.context);
  const maxTurns = def.maxTurns;
  const transcript: Message[] = [
    { role: "user", content: taskText(params.task), timestamp: Date.now() },
  ];

  let usage = zeroUsage();
  const usedTools = new Set<string>();
  let turns = 0;

  for (;;) {
    if (signal?.aborted) {
      return {
        status: "done",
        text: `(subagent ${def.name} aborted)`,
        turns,
        toolsUsed: [...usedTools],
        usage,
        agent: def.name,
      };
    }

    let assistant: AssistantMessage;
    try {
      assistant = await ctx.modelRegistry.complete(
        model,
        { systemPrompt, messages: transcript, tools },
        { signal, maxTokens: Math.min(def.temperature !== undefined ? 16384 : 16384, model.maxTokens) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Subagent "${def.name}" model call failed: ${message}`);
    }
    if (assistant.usage) {
      const cost = calculateCost(model, assistant.usage);
      usage = addUsage(usage, { ...assistant.usage, cost });
    }

    const calls = assistant.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    if (assistant.stopReason !== "toolUse" || calls.length === 0) {
      return {
        status: "done",
        text: assistantText(assistant) || `(subagent ${def.name} produced no text)`,
        stopReason: assistant.stopReason,
        turns: turns + 1,
        toolsUsed: [...usedTools],
        usage,
        agent: def.name,
      };
    }

    transcript.push(assistant);
    for (const call of calls) {
      usedTools.add(call.name);
      let outcome: AgentToolCallOutcomeLike;
      try {
        outcome = await ctx.executeTool(call.name, call.arguments, { signal, onUpdate });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          result: { content: [{ type: "text", text: `Tool execution failed: ${message}` }] },
          isError: true,
        };
      }
      transcript.push(toolResultMessage(call, outcome));
    }

    turns++;
    if (turns >= maxTurns) {
      const final = assistantText(assistant);
      return {
        status: "max_turns",
        text:
          final ||
          `(subagent ${def.name} reached the ${maxTurns}-turn cap; final tool round was reported above)`,
        stopReason: assistant.stopReason,
        turns,
        toolsUsed: [...usedTools],
        usage,
        agent: def.name,
      };
    }
  }
}
