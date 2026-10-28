/**
 * Offline unit tests for the subagents extension. No network, no API key.
 *
 * Run with `node --experimental-strip-types test.ts` (or `npm test`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentRegistry,
  loadDefFromFile,
  normalizeDef,
  parseFrontmatter,
  parseScalar,
  parseYamlLite,
  scanDir,
} from "./definitions.ts";
import {
  addUsage,
  assistantText,
  buildSystemPrompt,
  buildToolDecls,
  resolveModel,
  runSubagent,
  zeroUsage,
} from "./runner.ts";

// ---------------------------------------------------------------------------
// YAML-lite
// ---------------------------------------------------------------------------

test("parseScalar handles scalars, arrays, booleans, numbers", () => {
  assert.equal(parseScalar("hello"), "hello");
  assert.equal(parseScalar('"quoted"'), "quoted");
  assert.equal(parseScalar("'single'"), "single");
  assert.equal(parseScalar("true"), true);
  assert.equal(parseScalar("false"), false);
  assert.equal(parseScalar("12"), 12);
  assert.equal(parseScalar("3.5"), 3.5);
  assert.deepEqual(parseScalar("[a, b, c]"), ["a", "b", "c"]);
  assert.deepEqual(parseScalar("[1, 2]"), [1, 2]);
  assert.equal(parseScalar("null"), null);
});

test("parseYamlLite handles scalars, inline arrays, and block lists", () => {
  const yaml = [
    "name: code-reviewer",
    "description: Reviews code",
    "tools:",
    "  - read",
    "  - bash",
    "max_turns: 6",
    "thinking: medium",
    "# a comment",
  ].join("\n");
  const meta = parseYamlLite(yaml);
  assert.equal(meta.name, "code-reviewer");
  assert.equal(meta.description, "Reviews code");
  assert.deepEqual(meta.tools, ["read", "bash"]);
  assert.equal(meta.max_turns, 6);
  assert.equal(meta.thinking, "medium");
});

test("parseYamlLite handles inline array tools", () => {
  const meta = parseYamlLite("tools: [read, bash]\nfoo: bar");
  assert.deepEqual(meta.tools, ["read", "bash"]);
  assert.equal(meta.foo, "bar");
});

test("parseFrontmatter splits meta and body", () => {
  const md = "---\nname: x\n---\nBody text here";
  const { meta, body } = parseFrontmatter(md);
  assert.equal(meta.name, "x");
  assert.equal(body, "Body text here");
});

test("parseFrontmatter returns whole doc when no frontmatter", () => {
  const { meta, body } = parseFrontmatter("just body\nno meta");
  assert.deepEqual(meta, {});
  assert.equal(body, "just body\nno meta");
});

// ---------------------------------------------------------------------------
// normalizeDef / loader
// ---------------------------------------------------------------------------

test("normalizeDef applies defaults and overrides", () => {
  const def = normalizeDef(
    { name: "n", description: "d", tools: ["read"], max_turns: 3, model: "openai/gpt-5" },
    "Instructions",
    "test",
    "fallback",
  );
  assert.equal(def.name, "n");
  assert.equal(def.maxTurns, 3);
  assert.deepEqual(def.tools, ["read"]);
  assert.equal(def.model, "openai/gpt-5");
  assert.equal(def.instructions, "Instructions");

  const def2 = normalizeDef({}, "Body", "test", "fb");
  assert.equal(def2.name, "fb");
  assert.equal(def2.tools, "*");
  assert.equal(def2.maxTurns, 8);
});

test("loadDefFromFile parses markdown definitions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  const file = path.join(dir, "agent.md");
  fs.writeFileSync(
    file,
    [
      "---",
      "name: my-agent",
      "description: Something",
      "tools:",
      "  - read",
      "max_turns: 4",
      "---",
      "Do the thing.",
    ].join("\n"),
  );
  const def = loadDefFromFile(file);
  assert.equal(def.name, "my-agent");
  assert.deepEqual(def.tools, ["read"]);
  assert.equal(def.maxTurns, 4);
  assert.equal(def.instructions, "Do the thing.");
});

test("loadDefFromFile parses JSON definitions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  const file = path.join(dir, "agent.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ name: "j-agent", description: "J", tools: ["bash"], instructions: "JSON body" }),
  );
  const def = loadDefFromFile(file);
  assert.equal(def.name, "j-agent");
  assert.equal(def.instructions, "JSON body");
  assert.deepEqual(def.tools, ["bash"]);
});

test("scanDir skips broken files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
  fs.writeFileSync(path.join(dir, "ok.md"), "---\nname: ok\n---\nBody");
  fs.writeFileSync(path.join(dir, "broken.md"), "---\nname: broken\n---\n"); // empty body
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  const defs = scanDir(dir);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, "ok");
});

test("AgentRegistry loads bundled and user agents, user wins", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-user-"));
  fs.writeFileSync(
    path.join(userDir, "general-purpose.md"),
    "---\nname: general-purpose\ndescription: overridden\n---\nUser body",
  );
  const registry = new AgentRegistry({ userDir });
  registry.load();
  const all = registry.list();
  assert.ok(all.some((d) => d.name === "code-reviewer"), "bundled code-reviewer present");
  const gp = registry.get("general-purpose");
  assert.equal(gp?.description, "overridden");
  assert.equal(gp?.instructions, "User body");
});

// ---------------------------------------------------------------------------
// runner helpers
// ---------------------------------------------------------------------------

test("addUsage aggregates numbers and cost", () => {
  const a = zeroUsage();
  const b = addUsage(a, { input: 10, output: 5, totalTokens: 15, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } });
  const c = addUsage(b, { input: 2, output: 1, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.equal(c.input, 12);
  assert.equal(c.output, 6);
  assert.equal(c.totalTokens, 18);
  assert.equal(c.cost.input, 1);
  assert.equal(c.cost.total, 3);
});

test("buildToolDecls resolves allow-list and star-minus-self", () => {
  const fakeCtx = {
    tools: [
      { name: "read" },
      { name: "bash" },
      { name: "edit" },
      { name: "subagent" },
    ] as { name: string }[],
  };
  const starDef = { tools: "*" } as any;
  const starNames = buildToolDecls(fakeCtx as any, starDef).map((t: any) => t.name);
  assert.ok(starNames.includes("read"));
  assert.ok(!starNames.includes("subagent"), "self tool excluded");

  const listDef = { tools: ["bash"] } as any;
  const listNames = buildToolDecls(fakeCtx as any, listDef).map((t: any) => t.name);
  assert.deepEqual(listNames, ["bash"]);
});

test("buildSystemPrompt embeds instructions and caller context", () => {
  const def = { name: "x", instructions: "Core instructions" } as any;
  const p = buildSystemPrompt(def, "extra context");
  assert.ok(p.includes("Core instructions"));
  assert.ok(p.includes("extra context"));
  const p2 = buildSystemPrompt(def);
  assert.ok(!p2.includes("extra context"));
});

test("assistantText joins text blocks only", () => {
  const msg = {
    content: [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: " world" },
    ],
  } as any;
  assert.equal(assistantText(msg), "hello\n world");
});

test("resolveModel prefers per-call override, then def, then current", () => {
  const defOverride = { model: "anthropic/claude" } as any;
  const ctx = {
    model: { id: "current" },
    modelRegistry: {
      find: (p: string, id: string) => (p === "anthropic" && id === "claude" ? { id: "found" } : undefined),
      hasConfiguredAuth: () => true,
    },
  };
  assert.equal((resolveModel(ctx as any, defOverride) as any).id, "found");
  assert.equal((resolveModel(ctx as any, { model: undefined } as any, { model: "anthropic/claude" }) as any).id, "found");
  assert.equal((resolveModel(ctx as any, { model: undefined } as any) as any).id, "current");
});

// ---------------------------------------------------------------------------
// runSubagent integration (fake model + tools)
// ---------------------------------------------------------------------------

function fakeAssistant(content: any[], stopReason: string, usage?: any): any {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage: usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

test("runSubagent returns final text when model stops immediately", async () => {
  let calls = 0;
  const ctx = {
    model: { id: "fake-model", maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      complete: async () => {
        calls++;
        return fakeAssistant([{ type: "text", text: "the answer" }], "stop");
      },
    },
    tools: [{ name: "read" }],
    executeTool: async () => ({ result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
  };
  const def = { name: "t", description: "d", tools: "*", maxTurns: 4, instructions: "work" } as any;
  const outcome = await runSubagent(ctx as any, def, { name: "t", task: "do it" });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.text, "the answer");
  assert.equal(outcome.turns, 1);
  assert.equal(calls, 1);
  assert.deepEqual(outcome.toolsUsed, []);
});

test("runSubagent executes tool calls and feeds results back", async () => {
  let calls = 0;
  const executed: string[] = [];
  const ctx = {
    model: { id: "fake-model", maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      complete: async () => {
        calls++;
        if (calls === 1) {
          return fakeAssistant(
            [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
            "toolUse",
          );
        }
        return fakeAssistant([{ type: "text", text: "done after tool" }], "stop");
      },
    },
    tools: [{ name: "bash" }],
    executeTool: async (name: string) => {
      executed.push(name);
      return { result: { content: [{ type: "text", text: "tool output" }] }, isError: false };
    },
  };
  const def = { name: "t", description: "d", tools: "*", maxTurns: 4, instructions: "work" } as any;
  const outcome = await runSubagent(ctx as any, def, { name: "t", task: "do it" });
  assert.equal(outcome.turns, 2);
  assert.deepEqual(executed, ["bash"]);
  assert.deepEqual(outcome.toolsUsed, ["bash"]);
  assert.equal(outcome.text, "done after tool");
});

test("runSubagent caps at maxTurns", async () => {
  const ctx = {
    model: { id: "fake-model", maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => true,
      complete: async () =>
        fakeAssistant(
          [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
          "toolUse",
        ),
    },
    tools: [{ name: "bash" }],
    executeTool: async () => ({ result: { content: [{ type: "text", text: "t" }] }, isError: false }),
  };
  const def = { name: "t", description: "d", tools: "*", maxTurns: 3, instructions: "work" } as any;
  const outcome = await runSubagent(ctx as any, def, { name: "t", task: "x" });
  assert.equal(outcome.status, "max_turns");
  assert.equal(outcome.turns, 3);
});
