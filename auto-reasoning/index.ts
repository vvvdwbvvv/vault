/**
 * Auto-reasoning: automatically tune the thinking level based on prompt complexity.
 *
 * Toggle with `/auto-reasoning`. When enabled, before each user-initiated agent run
 * (`before_agent_start`) the extension asks Inception's Mercury Decide classifier to
 * score the prompt's complexity, maps the score to a pi thinking level
 * (`low` / `medium` / `high` / `xhigh`), and applies it via `pi.setThinkingLevel()`. This works
 * for ANY reasoning-capable chat model (Inception Mercury, GPT, Claude, ...) — pi
 * clamps the level to whatever the current provider/model supports.
 *
 * Guardrails:
 *  - Enabled by default for each new session. `/auto-reasoning` toggles it for the current session.
 *  - Only fires for real user-initiated turns, not tool-call continuations.
 *  - Per-session recall avoids re-judging the exact same prompt (retry/loop).
 *  - If Mercury Decide is not available or errors, the thinking level is left untouched.
 */

import type {
  ExtensionAPI,
  BeforeAgentStartEvent,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ClassifierModel, Model } from "@earendil-works/pi-ai";

const DECIDE_PROVIDER = "inception";
const DECIDE_MODEL = "mercury-decide";
const STATE_CUSTOM_TYPE = "auto-reasoning-state";

/** Score thresholds (0..2) that select each thinking level. */
const THRESHOLDS = { low: 0.7, medium: 1.3, high: 1.7 } as const;

/** Per-session enabled state, keyed by session id. */
const enabledBySession = new Map<string, boolean>();
/** Keep last judged prompt per session to avoid re-judging a retry/loop. */
const lastSeen = new Map<string, { prompt: string; level: string }>();

function extractPromptText(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized || normalized.startsWith("/")) return "";
  return normalized.slice(0, 4000);
}

function pickLevel(score: number): string {
  if (score < THRESHOLDS.low) return "low";
  if (score < THRESHOLDS.medium) return "medium";
  if (score < THRESHOLDS.high) return "high";
  return "xhigh";
}

/** Read the persisted toggle state from session entries (latest wins). */
function readPersistedState(ctx: ExtensionContext): boolean | undefined {
  let value: boolean | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
      value = (entry.data as { enabled?: boolean } | undefined)?.enabled;
    }
  }
  return value;
}

async function decideLevel(
  ctx: ExtensionContext,
  prompt: string,
): Promise<string | undefined> {
  const judge = ctx.modelRegistry.findOfType("classifier", DECIDE_PROVIDER, DECIDE_MODEL);
  if (!judge) return undefined;

  const result = await ctx.modelRegistry.classify(judge as ClassifierModel<any>, {
    state: { prompt },
    questions: {
      complexity: {
        type: "score",
        instructions:
          "How much careful reasoning does answering this prompt require? " +
          "Simple factual or short questions are 0; multi-step, ambiguous, " +
          "or code-heavy tasks are 2.",
        criteria: [
          "trivial: one-line fact, greeting, or pure echo",
          "moderate: a short explanation or a single simple step",
          "complex: multi-step task, ambiguous requirements, deep analysis, or code",
        ],
      },
    },
  });

  if (result.stopReason !== "stop") return undefined;
  const answer = result.answers?.complexity;
  if (!answer || answer.type !== "score") return undefined;
  return pickLevel(answer.score);
}

function shouldHandle(model: Model<any> | undefined): model is Model<any> {
  return !!model && model.type === "chat" && !!model.reasoning;
}

export default function (pi: ExtensionAPI) {
  // Restore per-session toggle from persisted state when a session starts.
  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const persisted = readPersistedState(ctx);
    enabledBySession.set(sessionId, persisted ?? true);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    if (event.messageType !== "user") return;
    if (!shouldHandle(ctx.model)) return;

    const sessionId = ctx.sessionManager.getSessionId();
    if (!enabledBySession.get(sessionId)) return;

    const prompt = extractPromptText(event.prompt);
    if (!prompt) return;

    const seen = lastSeen.get(sessionId);
    if (seen && seen.prompt === prompt) {
      pi.setThinkingLevel(seen.level as never);
      return;
    }

    const level = await decideLevel(ctx, prompt);
    if (!level) return;

    lastSeen.set(sessionId, { prompt, level });
    pi.setThinkingLevel(level as never);
  });

  pi.registerCommand("auto-reasoning", {
    description:
      "Toggle auto-reasoning: automatically set the thinking level from prompt complexity (uses Mercury Decide).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const current = !!enabledBySession.get(sessionId);

      let next: boolean;
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "enable") next = true;
      else if (arg === "off" || arg === "disable") next = false;
      else next = !current;

      enabledBySession.set(sessionId, next);
      pi.appendEntry(STATE_CUSTOM_TYPE, { enabled: next });
      ctx.ui.notify(
        `Auto-reasoning ${next ? "ON" : "OFF"}`,
        next ? "info" : "warning",
      );
      ctx.ui.setStatus("auto-reasoning", next ? "auto-reasoning: ON" : undefined);
    },
  });
}
