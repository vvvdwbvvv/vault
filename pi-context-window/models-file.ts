function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModelsDocument(text: string): Record<string, unknown> {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return { providers: {} };
	}
	return isRecord(doc) ? doc : { providers: {} };
}

function providerRecord(doc: Record<string, unknown>, provider: string): Record<string, unknown> {
	if (doc.providers === undefined) doc.providers = {};
	if (!isRecord(doc.providers)) {
		throw new Error("models.json providers is not an object");
	}
	if (doc.providers[provider] === undefined) doc.providers[provider] = {};
	const prov = doc.providers[provider];
	if (!isRecord(prov)) {
		throw new Error(`models.json provider "${provider}" is not an object`);
	}
	return prov;
}

export function applyContextWindow(
	doc: Record<string, unknown>,
	provider: string,
	modelId: string,
	tokens: number,
): { before: number | undefined; after: number } {
	const prov = providerRecord(doc, provider);
	let before: number | undefined;
	let writeOverride = true;

	if (Array.isArray(prov.models)) {
		for (const entry of prov.models) {
			if (!isRecord(entry) || entry.id !== modelId) continue;
			if (entry.contextWindow !== undefined) writeOverride = false;
			if (typeof entry.contextWindow === "number") before = entry.contextWindow;
			entry.contextWindow = tokens;
			break;
		}
	}

	if (writeOverride) {
		if (prov.modelOverrides === undefined) prov.modelOverrides = {};
		if (!isRecord(prov.modelOverrides)) {
			throw new Error(`models.json modelOverrides for "${provider}" is not an object`);
		}
		if (prov.modelOverrides[modelId] === undefined) prov.modelOverrides[modelId] = {};
		const override = prov.modelOverrides[modelId];
		if (!isRecord(override)) {
			throw new Error(`models.json override for "${provider}/${modelId}" is not an object`);
		}
		if (typeof override.contextWindow === "number") before = override.contextWindow;
		override.contextWindow = tokens;
	}

	return { before, after: tokens };
}
