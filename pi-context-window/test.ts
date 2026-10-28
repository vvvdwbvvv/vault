import assert from "node:assert/strict";
import test from "node:test";
import { applyContextWindow, parseModelsDocument } from "./models-file.ts";

test("parseModelsDocument keeps unrelated keys and rejects non-objects", () => {
	const doc = parseModelsDocument('{"providers":{},"theme":"dark"}');
	assert.equal(doc.theme, "dark");
	assert.deepEqual(parseModelsDocument("[]"), { providers: {} });
	assert.deepEqual(parseModelsDocument("{"), { providers: {} });
});

test("applyContextWindow updates a catalog entry and leaves siblings", () => {
	const doc = parseModelsDocument(
		JSON.stringify({
			providers: {
				openai: {
					models: [{ id: "gpt", contextWindow: 128000, name: "GPT" }],
					baseUrl: "https://example.test",
				},
			},
		}),
	);
	assert.deepEqual(applyContextWindow(doc, "openai", "gpt", 256000), { before: 128000, after: 256000 });
	assert.deepEqual(doc, {
		providers: {
			openai: {
				models: [{ id: "gpt", contextWindow: 256000, name: "GPT" }],
				baseUrl: "https://example.test",
			},
		},
	});
});

test("applyContextWindow writes an override when the catalog has no window", () => {
	const doc: Record<string, unknown> = {
		providers: { openai: { models: [{ id: "gpt", name: "GPT" }] } },
	};
	assert.deepEqual(applyContextWindow(doc, "openai", "gpt", 32000), { before: undefined, after: 32000 });
	assert.deepEqual(doc, {
		providers: {
			openai: {
				models: [{ id: "gpt", name: "GPT", contextWindow: 32000 }],
				modelOverrides: { gpt: { contextWindow: 32000 } },
			},
		},
	});
});

test("applyContextWindow refuses a providers value that is not an object", () => {
	const doc: Record<string, unknown> = { providers: "nope" };
	assert.throws(() => applyContextWindow(doc, "openai", "gpt", 1), /providers is not an object/);
	assert.equal(doc.providers, "nope");
});

test("applyContextWindow records the previous override for an unknown model", () => {
	const doc: Record<string, unknown> = {
		providers: { openai: { modelOverrides: { gpt: { contextWindow: 8000, note: "keep" } } } },
	};
	assert.deepEqual(applyContextWindow(doc, "openai", "gpt", 16000), { before: 8000, after: 16000 });
	assert.deepEqual(doc, {
		providers: {
			openai: { modelOverrides: { gpt: { contextWindow: 16000, note: "keep" } } },
		},
	});
});
