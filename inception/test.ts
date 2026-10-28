/**
 * Unit tests for the pure Inception Decisions mapping module.
 *
 * The format module has only type-only imports, and this file avoids any Node
 * built-in imports (so it needs no `@types/node`). It runs with Node's native
 * TypeScript support:
 *
 *   node --experimental-strip-types test.ts
 */

import {
  MAX_IMAGES,
  parseAnswer,
  parseAnswers,
  parseUsageTokens,
  wireQuestion,
  wireState,
} from "./inception-decisions-format.ts";

type Fail = { name: string; error: unknown };

const failures: Fail[] = [];

function run(name: string, fn: () => void) {
  try {
    fn();
    // pi-lens-ignore: no-console-except-error -- test harness stdout contract
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
  }
}

class AssertionError extends Error {}

function fail(message: string): never {
  throw new AssertionError(message);
}

const assert = {
  equal<T>(actual: T, expected: T, message?: string) {
    if (actual !== expected) fail(message ?? `expected ${expected}, got ${actual}`);
  },
  // pi-lens-ignore: no-unknown-parameters -- assertion comparand must accept any value
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) fail(message ?? `expected ${a}, got ${e}`);
  },
  match(actual: string, re: RegExp, message?: string) {
    if (!re.test(actual)) fail(message ?? `expected ${actual} to match ${re}`);
  },
  throws(fn: () => unknown, re?: RegExp) {
    let threw = false;
    try {
      fn();
    } catch (error) {
      threw = true;
      if (re && !(error instanceof Error && re.test(error.message))) {
        fail(`error ${String(error)} did not match ${re}`);
      }
    }
    if (!threw) fail("expected function to throw");
  },
};

run("wireQuestion: bool -> noul with folded criteria", () => {
  const wired = wireQuestion("b", {
    type: "bool",
    instructions: "Is this about billing?",
    criteria: { true: "Yes, payment", false: "No" },
  });
  assert.equal(wired.type, "noul");
  if (wired.type === "noul") {
    assert.match(wired.instructions, /True means: Yes, payment/);
    assert.match(wired.instructions, /False means: No/);
  }
});

run("wireQuestion: choice passes criteria through", () => {
  const wired = wireQuestion("c", {
    type: "choice",
    instructions: "Pick one",
    criteria: { billing: "Payments", support: "Support" },
  });
  assert.equal(wired.type, "choice");
  if (wired.type === "choice") {
    assert.deepEqual(wired.criteria, { billing: "Payments", support: "Support" });
  }
});

run("wireQuestion: score passes ordered criteria", () => {
  const wired = wireQuestion("s", {
    type: "score",
    instructions: "How urgent?",
    criteria: ["Can wait", "Today"],
  });
  assert.equal(wired.type, "score");
  if (wired.type === "score") {
    assert.deepEqual(wired.criteria, ["Can wait", "Today"]);
  }
});

run("wireState: no images returns state unchanged", () => {
  assert.deepEqual(wireState({ state: { a: 1 }, questions: {} }), { a: 1 });
});

run("wireState: injects images as image_url parts", () => {
  const state = wireState({
    state: { task: "x" },
    images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    questions: {},
  });
  assert.deepEqual(state.images, [
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
  assert.equal(state.task, "x");
});

run("wireState: enforces image limit", () => {
  const images = Array.from({ length: MAX_IMAGES + 1 }, () => ({
    type: "image" as const,
    data: "a",
    mimeType: "image/png",
  }));
  assert.throws(
    () => wireState({ state: {}, images, questions: {} }),
    /at most 16/,
  );
});

run("parseAnswer: choice", () => {
  const answer = parseAnswer(
    "c",
    { type: "choice", instructions: "", criteria: { a: "", b: "" } },
    {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.96, b: 0.04 },
      confidence: 0.96,
    },
  );
  assert.deepEqual(answer, {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.96, b: 0.04 },
    confidence: 0.96,
  });
});

run("parseAnswer: score", () => {
  const answer = parseAnswer(
    "s",
    { type: "score", instructions: "", criteria: ["a", "b", "c"] },
    { type: "score", score: 1.1, legend: {}, probabilities: {}, confidence: 0.9 },
  );
  assert.deepEqual(answer, { type: "score", score: 1.1, confidence: 0.9 });
});

run("parseAnswer: noul -> bool", () => {
  const answer = parseAnswer(
    "b",
    { type: "bool", instructions: "", criteria: { true: "", false: "" } },
    { type: "noul", noul: 0.97 },
  );
  assert.deepEqual(answer, { type: "bool", probability: 0.97 });
});

run("parseAnswer: refusal errors", () => {
  assert.throws(
    () =>
      parseAnswer(
        "b",
        { type: "bool", instructions: "", criteria: { true: "", false: "" } },
        { type: "refusal" },
      ),
    /refused/,
  );
});

run("parseAnswers: maps all questions", () => {
  const answers = parseAnswers(
    {
      b: { type: "noul", noul: 0.9 },
      c: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 },
    },
    {
      state: {},
      questions: {
        b: { type: "bool", instructions: "", criteria: { true: "", false: "" } },
        c: { type: "choice", instructions: "", criteria: { x: "" } },
      },
    },
  );
  assert.equal(answers.b.type, "bool");
  assert.equal(answers.c.type, "choice");
});

run("parseAnswers: missing answer errors", () => {
  assert.throws(
    () =>
      parseAnswers(
        { b: { type: "noul", noul: 0.9 } },
        {
          state: {},
          questions: {
            b: { type: "bool", instructions: "", criteria: { true: "", false: "" } },
            c: { type: "bool", instructions: "", criteria: { true: "", false: "" } },
          },
        },
      ),
    /did not return an answer for "c"/,
  );
});

run("parseUsageTokens: parses input/output", () => {
  assert.deepEqual(parseUsageTokens({ input_tokens: 120, output_tokens: 3 }), {
    input: 120,
    output: 3,
  });
});

run("parseUsageTokens: missing usage -> undefined", () => {
  assert.equal(parseUsageTokens(undefined), undefined);
  assert.equal(parseUsageTokens({}), undefined);
});

if (failures.length > 0) {
  // pi-lens-ignore: no-console-except-error -- test harness stderr contract
  console.error(`\n${failures.length} test(s) failed:`);
  for (const { name, error } of failures) {
    // pi-lens-ignore: no-console-except-error -- test harness stderr contract
    console.error(`- ${name}: ${String(error)}`);
  }
  throw new Error(`${failures.length} test(s) failed`);
} else {
  // pi-lens-ignore: no-console-except-error -- test harness stdout contract
  console.log("\nAll tests passed.");
}
