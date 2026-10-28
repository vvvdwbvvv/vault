import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

/** Wrap native completion instead of replacing slash/file completion. */
export function withDollarSkills(provider: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
	return {
		triggerCharacters: [...new Set([...(provider.triggerCharacters ?? []), "$"])],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const prefix = lines[cursorLine].slice(0, cursorCol);
			if (cursorLine === 0 && /^\$[a-z0-9-]*$/.test(prefix)) {
				const items = pi.getCommands()
					.filter((entry) => entry.source === "skill")
					.map((entry) => ({
						value: `$${entry.name.slice("skill:".length)}`,
						label: `$${entry.name.slice("skill:".length)}`,
						description: entry.description,
					}))
					.filter((item) => item.value.startsWith(prefix));
				return items.length ? { items, prefix } : null;
			}
			return provider.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (cursorLine === 0 && prefix.startsWith("$") && item.value.startsWith("$")) {
				const updated = [...lines];
				const suffix = lines[0].slice(cursorCol);
				const completion = item.value + (suffix.startsWith(" ") ? "" : " ");
				updated[0] = completion + suffix;
				return { lines: updated, cursorLine: 0, cursorCol: completion.length };
			}
			return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
	};
}

/** Codex-style skill invocation, using Pi's native skill expansion. */
export default function dollarSkills(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((provider) => withDollarSkills(provider, pi));
	});
	pi.on("input", (event) => {
		// Do not reinterpret messages injected by another extension.
		if (event.source === "extension") return { action: "continue" };
		const match = /^\$([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)([\s\S]*)$/.exec(event.text);
		if (!match) return { action: "continue" };
		const command = `skill:${match[1]}`;
		if (!pi.getCommands().some((entry) => entry.source === "skill" && entry.name === command)) {
			return { action: "continue" };
		}
		const args = match[2].trimStart();
		return {
			action: "transform",
			text: `/${command}${args ? ` ${args}` : ""}`,
			images: event.images,
		};
	});
}
