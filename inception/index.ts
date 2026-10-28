/**
 * Inception provider for pi (Inception Labs / Mercury / Mercury Decide).
 *
 * Registers the `inception` provider:
 *
 *  - Chat models — Mercury 2 / 2.5 / 3 — driven by pi's built-in OpenAI-compatible
 *    `openai-completions` adapter, with pi thinking levels mapped onto Inception's
 *    `reasoning_effort` (instant/low/medium/high).
 *  - Mercury Decide — a classifier backed by `POST /v1/decisions`. This exposes
 *    Inception's binary (noul), categorical (choice), and ordinal (score)
 *    questions through pi's `models.classify()` and codemode's
 *    `models.classify()`.
 *
 * Model/capacity/pricing data is from Inception's public docs and models page.
 * Note: launch discounts (e.g. Mercury 3 50% off, Mercury Decide 50% off) are not
 * reflected; the standard rates are stored.
 *
 * Usage:
 *   - Set `INCEPTION_API_KEY` (or supply the key in pi's provider dialog).
 *   - Load the extension from `~/.pi/agent/extensions/inception/` or via
 *     `pi -e <path>`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AnyModel,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  Usage,
} from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";

import { parseAnswer, parseUsageTokens, wireQuestion, wireState } from "./inception-decisions-format.ts";

const BASE_URL = "https://api.inceptionlabs.ai/v1";
const LABEL = "Inception Decisions";
const NO_RETRY_STATUSES = [401, 402, 404, 429];

/** Map pi thinking levels to Inception's `reasoning_effort`. */
const thinkingLevelMap = {
  off: "instant",
  minimal: "instant",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

const cost = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

/** Supported input modalities for text-only chat models. */
const TEXT_INPUT = ["text"] as ("text" | "image")[];
/** Supported input modalities for the image-aware Decide classifier. */
const TEXT_IMAGE_INPUT = ["text", "image"] as ("text" | "image")[];

/** Chat models (OpenAI-compatible completions). */
const chatModels = [
  {
    id: "mercury-2",
    name: "Mercury 2",
    type: "chat" as const,
    input: TEXT_INPUT,
    reasoning: true,
    thinkingLevelMap,
    compat: { supportsReasoningEffort: true },
    contextWindow: 128_000,
    maxTokens: 50_000,
    cost: cost(0.25, 0.75, 0.025),
  },
  {
    id: "mercury-2.5",
    name: "Mercury 2.5",
    type: "chat" as const,
    input: TEXT_INPUT,
    reasoning: true,
    thinkingLevelMap,
    compat: { supportsReasoningEffort: true },
    contextWindow: 260_000,
    maxTokens: 65_536,
    cost: cost(0.2, 0.75, 0.02),
  },
  {
    id: "mercury-3",
    name: "Mercury 3",
    type: "chat" as const,
    input: TEXT_INPUT,
    reasoning: true,
    thinkingLevelMap,
    compat: { supportsReasoningEffort: true },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: cost(0.2, 0.7, 0.02),
  },
];

/** Mercury Decide classifier model. */
const classifyModel = {
  id: "mercury-decide",
  name: "Mercury Decide",
  type: "classifier" as const,
  api: "inception-decisions" as const,
  input: TEXT_IMAGE_INPUT,
  contextWindow: 260_000,
  cost: cost(0.04, 0),
};

/** Minimal JSON POST with bearer auth, cancellation, and bounded retries. */
async function postJson(
  url: string,
  model: ClassifierModel<ClassifierApi>,
  payload: unknown,
  options: ClassifierOptions | undefined,
): Promise<unknown> {
  const apiKey = options?.apiKey;
  if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
  const requestFetch = options?.fetch ?? globalThis.fetch;

  let body: unknown = payload;
  const transformed = await options?.onPayload?.(body, model);
  if (transformed !== undefined) body = transformed;

  const attempt = async () => {
    const timeoutSignal = options?.timeoutMs !== undefined
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
    const signal = options?.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : (options?.signal ?? timeoutSignal);

    const res = await requestFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const err = new Error(`${LABEL} returned ${res.status}: ${await res.text()}`) as Error & {
        status: number;
      };
      err.status = res.status;
      throw err;
    }

    await options?.onResponse?.(
      { status: res.status, headers: Object.fromEntries(res.headers.entries()) },
      model,
    );
    return res.json();
  };

  const maxRetries = options?.maxRetries ?? 2;
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      const status = (error as { status?: number })?.status;
      const retriable = status === undefined || (status >= 500 && !NO_RETRY_STATUSES.includes(status));
      if (!retriable || i >= maxRetries) throw error;
      const delay = Math.min(1000 * 2 ** i, options?.maxRetryDelayMs ?? 8000);
      if (options?.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Build the `Usage` object and price it with the model's catalog rates. */
function buildUsage(model: AnyModel, tokens: { input: number; output: number }): Usage {
  const usage: Usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens.input + tokens.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  usage.cost = calculateCost(model, usage);
  return usage;
}

/**
 * Classification through Inception's Decisions API. This is the implementation
 * registered under the `inception-decisions` classifier API.
 */
export async function classify(
  model: ClassifierModel<ClassifierApi>,
  context: ClassifierContext,
  options?: ClassifierOptions,
): Promise<ClassifierResult> {
  const output: ClassifierResult = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    if (model.api !== "inception-decisions") {
      throw new Error(`Unsupported classifier API: ${model.api}`);
    }

    const body = await postJson(`${BASE_URL}/decisions`, model, {
      model: model.id,
      state: wireState(context),
      questions: Object.fromEntries(
        Object.entries(context.questions).map(([id, question]) => [id, wireQuestion(id, question)]),
      ),
    }, options);

    if (typeof body !== "object" || body === null) {
      throw new Error(`${LABEL} returned an unexpected response`);
    }

    // Set usage before parsing answers: a request with refused/malformed answers
    // was still billed.
    const tokens = parseUsageTokens((body as Record<string, unknown>).usage);
    if (tokens) output.usage = buildUsage(model, tokens);

    const answers = (body as Record<string, unknown>).answers;
    for (const [id, question] of Object.entries(context.questions)) {
      const answer = (answers as Record<string, Record<string, unknown>>)[id];
      if (!answer) throw new Error(`${LABEL} did not return an answer for "${id}"`);
      output.answers[id] = parseAnswer(id, question, answer);
    }
    return output;
  } catch (error) {
    output.answers = {};
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    return output;
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerProvider("inception", {
    name: "Inception",
    api: "openai-completions",
    baseUrl: BASE_URL,
    apiKey: "$INCEPTION_API_KEY",
    models: [...chatModels, classifyModel],
    classifiers: {
      "inception-decisions": { classify },
    },
  });
}
