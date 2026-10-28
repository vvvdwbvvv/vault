/**
 * pi-context-window
 *
 * 新增 /context-window 指令：調整 GPT model 的 context window。
 *
 * 用法：
 *   /context-window                -> 互動選單（預設間距 + 自訂）
 *   /context-window 128k           -> 預設間距
 *   /context-window 1000000        -> 直接給 tokens
 *   /context-window 256k openai/gpt-6.1-sol  -> 指定 model
 *
 * 寫入 ~/.pi/agent/models.json 的 providers.<provider>.modelOverrides.<model>.contextWindow
 * （若該 provider 的自訂 models 清單裡有這個 model，則直接更新該 entry）。
 * 新 session 生效；目前 session 可重開 /model 或重啟 pi。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { applyContextWindow, parseModelsDocument } from "./models-file.ts";

const PRESETS = [
	{ key: "32k", label: "32K (32,000)", value: 32_000 },
	{ key: "64k", label: "64K (64,000)", value: 64_000 },
	{ key: "128k", label: "128K (128,000) — 預設", value: 128_000 },
	{ key: "200k", label: "200K (200,000)", value: 200_000 },
	{ key: "256k", label: "256K (256,000)", value: 256_000 },
	{ key: "400k", label: "400K (400,000)", value: 400_000 },
	{ key: "1m", label: "1M (1,000,000)", value: 1_000_000 },
] as const;

function parseTokens(arg: string): number | null {
	const trimmed = arg.trim().toLowerCase();
	if (!trimmed) return null;
	const preset = PRESETS.find((p) => p.key === trimmed);
	if (preset) return preset.value;
	const match = /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(trimmed);
	if (!match) return null;
	let n = parseFloat(match[1]);
	const unit = match[2];
	if (unit === "k") n *= 1000;
	else if (unit === "m") n *= 1_000_000;
	if (!Number.isFinite(n) || n < 1000) return null;
	return Math.floor(n);
}

function formatTokens(n: number): string {
	return `${n.toLocaleString("en-US")} tokens`;
}

interface ModelRef {
	provider: string;
	id: string;
	display: string;
}

function readModelsFile(path: string): Record<string, unknown> {
	try {
		return parseModelsDocument(readFileSync(path, "utf8"));
	} catch {
		// 不存在或無法解析 → 重建
	}
	return { providers: {} };
}

function persistContextWindow(
	modelsPath: string,
	provider: string,
	modelId: string,
	tokens: number,
): { before: number | undefined; after: number } {
	const doc = readModelsFile(modelsPath);
	const result = applyContextWindow(doc, provider, modelId, tokens);
	writeFileSync(modelsPath, JSON.stringify(doc, null, 2) + "\n");
	return result;
}

async function resolveTargetModel(
	parts: string[],
	ctx: ExtensionCommandContext,
): Promise<ModelRef | undefined> {
	const explicit = parts.slice(1).join(" ").trim();

	if (explicit) {
		const all = ctx.modelRegistry.getAll();
		const slash = explicit.indexOf("/");
		if (slash > 0) {
			const provider = explicit.slice(0, slash);
			const id = explicit.slice(slash + 1);
			const found =
				all.find((m: Model<Api>) => m.provider === provider && m.id === id) ??
				ctx.modelRegistry.find(provider, id);
			if (found) return { provider, id, display: `${provider}/${id}` };
			return undefined;
		}
		const byId = all.filter((m: Model<Api>) => m.id === explicit);
		if (byId.length === 1) {
			return {
				provider: byId[0].provider,
				id: byId[0].id,
				display: `${byId[0].provider}/${byId[0].id}`,
			};
		}
		if (byId.length > 1) {
			const choice = await ctx.ui.select(
				`多個 model 同名為 ${explicit}，選一個`,
				byId.map((m) => `${m.provider}/${m.id}`),
			);
			if (!choice) return undefined;
			const [provider, id] = choice.split("/");
			return { provider, id, display: choice };
		}
		return undefined;
	}

	if (ctx.model && !(ctx.model.provider === "unknown" && ctx.model.id === "unknown")) {
		return {
			provider: ctx.model.provider,
			id: ctx.model.id,
			display: `${ctx.model.provider}/${ctx.model.id}`,
		};
	}

	const chatModels = ctx.modelRegistry.getAll();
	if (chatModels.length > 0) {
		const choice = await ctx.ui.select(
			"目前沒有 model，請選擇要調整的 model",
			chatModels.map((m: Model<Api>) => `${m.provider}/${m.id}`),
		);
		if (!choice) return undefined;
		const [provider, id] = choice.split("/");
		return { provider, id, display: choice };
	}
	return undefined;
}

export default function contextWindowExtension(pi: ExtensionAPI) {
	pi.registerCommand("context-window", {
		description: "調整 GPT model 的 context window（預設間距或自訂 tokens）",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const last = (parts[0] ?? "").toLowerCase();
				const items = PRESETS.filter((p) => p.key.startsWith(last)).map((p) => ({
					value: p.key,
					label: p.label,
				}));
				return [...items, { value: "custom", label: "自訂…" }];
			}
			return null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			let tokens: number | null = parts.length > 0 ? parseTokens(parts[0]) : null;

			if (parts[0]?.toLowerCase() === "custom") {
				const input = await ctx.ui.input("輸入 context window tokens（例如 256000）");
				if (!input) return;
				tokens = parseTokens(input);
			} else if (tokens === null && parts.length === 0) {
				const choices = [
					...PRESETS.map((p) => p.label),
					"自訂…",
				];
				const selected = await ctx.ui.select("選擇 context window 間距", choices);
				if (!selected) return;
				const preset = PRESETS.find((p) => p.label === selected);
				if (preset) {
					tokens = preset.value;
				} else {
					const input = await ctx.ui.input("輸入 context window tokens（例如 256000）");
					if (!input) return;
					tokens = parseTokens(input);
				}
			}

			if (tokens === null) {
				ctx.ui.notify(
					"無法解析 token 數：可用 /context-window 128k 或 /context-window 256000（k/m 單位、數字皆可）",
					"warning",
				);
				return;
			}

			const model = await resolveTargetModel(parts, ctx);
			if (!model) {
				ctx.ui.notify(`找不到 model：${parts.slice(1).join(" ") || "目前未選 model"}`, "error");
				return;
			}

			await ctx.waitForIdle();
			const activeModel = ctx.model;
			const isCurrentModel = activeModel?.provider === model.provider && activeModel.id === model.id;
			const modelsPath = join(getAgentDir(), "models.json");
			const { before, after } = persistContextWindow(modelsPath, model.provider, model.id, tokens);

			const from = before === undefined ? "未設定" : formatTokens(before);
			ctx.ui.notify(
				`已把 ${model.display} 的 context window 從 ${from} 調整為 ${formatTokens(after)}（寫入 ${modelsPath}）`,
				"info",
			);
			try {
				await ctx.modelRegistry.refresh();
				if (isCurrentModel && activeModel) {
					const refreshed = ctx.modelRegistry.find(model.provider, model.id) ?? activeModel;
					const applied = await pi.setModel({ ...refreshed, contextWindow: tokens });
					if (!applied) {
						ctx.ui.notify("設定已儲存，但目前模型驗證不可用，未能即時套用。", "warning");
						return;
					}
					ctx.ui.notify("已立即套用到目前對話，下一次請求使用新的上下文大小。", "info");
				} else {
					ctx.ui.notify("已更新模型設定；目前對話使用其他模型，因此不切換模型。", "info");
				}
			} catch (error) {
				ctx.ui.notify(`設定已儲存，但即時套用失敗：${String(error)}`, "error");
			}
		},
	});
}
