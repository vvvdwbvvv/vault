/**
 * Pure request/response mapping between pi's classifier abstraction and
 * Inception's Decisions API (`POST /v1/decisions`).
 *
 * This module has no runtime dependency on pi packages (only type-only imports),
 * so it can be unit-tested with `node --experimental-strip-types` in isolation.
 *
 * Wire-level mapping (pi -> Inception):
 *   - `bool`   -> `noul`  (probability of true). Inception's noul question has
 *                  no criteria field, so the true/false meanings are folded into
 *                  the instructions, mirroring OpenAI's predicate behavior.
 *   - `choice` -> `choice` (criteria labels -> descriptions)
 *   - `score`  -> `score`  (criteria string array defines ordered scale levels)
 *
 * Response mapping (Inception -> pi):
 *   - `noul.noul`   -> `bool.probability`
 *   - `choice`      -> `choice` (choice, probabilities, confidence)
 *   - `score`       -> `score` (score, confidence; Inception provides confidence)
 */

import type {
  ClassifierAnswer,
  ClassifierBoolQuestion,
  ClassifierContext,
  ClassifierQuestion,
} from "@earendil-works/pi-ai";

export const MAX_IMAGES = 16;

/** Image inputs pi passes alongside `state`. */
export interface InputImage {
  type: "image";
  data: string;
  mimeType: string;
}

/** Inception wire question shapes. */
export type WireNoulQuestion = { type: "noul"; instructions: string };
export type WireChoiceQuestion = {
  type: "choice";
  instructions?: string;
  criteria: Record<string, string>;
};
export type WireScoreQuestion = {
  type: "score";
  instructions?: string;
  criteria: string[];
};
export type WireQuestion = WireNoulQuestion | WireChoiceQuestion | WireScoreQuestion;

/** Inception wire image part, injected into `state`. */
export type WireImagePart = {
  type: "image_url";
  image_url: { url: string };
};

function requiredNumber(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Inception Decisions returned an invalid ${label}`);
  }
  return value;
}

function boolInstructions(question: ClassifierBoolQuestion): string {
  const meanings = [
    question.criteria.true ? `True means: ${question.criteria.true}` : "",
    question.criteria.false ? `False means: ${question.criteria.false}` : "",
  ].filter(Boolean);
  return meanings.length > 0
    ? `${question.instructions}\n\n${meanings.join("\n")}`
    : question.instructions;
}

/** Map a pi question to an Inception question (wire form). */
export function wireQuestion(id: string, question: ClassifierQuestion): WireQuestion {
  switch (question.type) {
    case "choice": {
      const wire: WireChoiceQuestion = {
        type: "choice",
        criteria: Object.fromEntries(Object.entries(question.criteria)),
      };
      if (question.instructions) wire.instructions = question.instructions;
      return wire;
    }
    case "score": {
      const wire: WireScoreQuestion = {
        type: "score",
        criteria: [...question.criteria],
      };
      if (question.instructions) wire.instructions = question.instructions;
      return wire;
    }
    case "bool":
      return { type: "noul", instructions: boolInstructions(question) };
    default:
      throw new Error(`Inception Decisions: unsupported question type for "${id}"`);
  }
}

/** Map pi context to the Inception `state`. Images are injected as image_url parts. */
export function wireState(context: ClassifierContext): Record<string, unknown> {
  const images: InputImage[] = (context.images ?? []) as InputImage[];
  if (images.length === 0) return context.state;
  if (images.length > MAX_IMAGES) {
    throw new Error(
      `Inception Decisions accepts at most ${MAX_IMAGES} images, got ${images.length}`,
    );
  }
  const parts: WireImagePart[] = images.map((image) => ({
    type: "image_url",
    image_url: {
      url: `data:${image.mimeType};base64,${image.data}`,
    },
  }));
  return { ...context.state, images: parts };
}

function parseChoiceProbabilities(value: unknown, id: string): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Inception Decisions returned invalid probabilities for "${id}"`);
  }
  const out: Record<string, number> = {};
  for (const [label, prob] of Object.entries(value)) {
    out[label] = requiredNumber(
      `probability for "${id}.${label}"`,
      (prob as { probability?: number }).probability ?? prob,
    );
  }
  return out;
}

/** Map an Inception answer to a pi answer. */
export function parseAnswer(
  id: string,
  question: ClassifierQuestion,
  answer: Record<string, unknown>,
): ClassifierAnswer {
  if (answer.type === "refusal") {
    throw new Error(`Inception Decisions refused to answer "${id}"`);
  }
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string") {
      throw new Error(`Inception Decisions did not return a choice answer for "${id}"`);
    }
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: parseChoiceProbabilities(answer.probabilities, id),
      confidence: requiredNumber(`confidence for "${id}"`, answer.confidence),
    };
  }
  if (question.type === "score") {
    if (answer.type !== "score") {
      throw new Error(`Inception Decisions did not return a score answer for "${id}"`);
    }
    return {
      type: "score",
      score: requiredNumber(`score for "${id}"`, answer.score),
      confidence: requiredNumber(`confidence for "${id}"`, answer.confidence),
    };
  }
  if (answer.type !== "noul") {
    throw new Error(`Inception Decisions did not return a noul answer for "${id}"`);
  }
  return {
    type: "bool",
    probability: requiredNumber(`probability for "${id}"`, answer.noul),
  };
}

/** Parse all answers back into pi shape, keyed by question id. */
export function parseAnswers(
  answers: unknown,
  context: ClassifierContext,
): Record<string, ClassifierAnswer> {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("Inception Decisions returned an unexpected response");
  }
  const out: Record<string, ClassifierAnswer> = {};
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = (answers as Record<string, Record<string, unknown>>)[id];
    if (!answer) {
      throw new Error(`Inception Decisions did not return an answer for "${id}"`);
    }
    out[id] = parseAnswer(id, question, answer);
  }
  return out;
}

/** Token/usage from `{ input_tokens, output_tokens }`. */
export function parseUsageTokens(value: unknown): { input: number; output: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const input = typeof v.input_tokens === "number" && Number.isFinite(v.input_tokens) && v.input_tokens > 0
    ? v.input_tokens
    : 0;
  const output = typeof v.output_tokens === "number" && Number.isFinite(v.output_tokens) && v.output_tokens > 0
    ? v.output_tokens
    : 0;
  return input === 0 && output === 0 ? undefined : { input, output };
}
