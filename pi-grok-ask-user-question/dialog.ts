import type { TUI, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { OTHER } from "./format.ts";

export interface CardOption {
	label: string;
	description: string;
	preview?: string;
}

export interface CardQuestion {
	question: string;
	options: CardOption[];
	multiSelect: boolean;
}

export interface CardAnswer {
	labels: string[];
	notes?: string;
}

export type CardOutcome =
	| { kind: "accepted"; answers: CardAnswer[] }
	| { kind: "chat" | "skip"; answers: CardAnswer[] }
	| { kind: "cancelled" | "timeout" | "aborted" };

type Row = { kind: "option"; index: number } | { kind: "other" } | { kind: "respond" } | { kind: "finish" };

const SHORTCUTS = "123456789abcdef";

export function openQuestionCard(
	tui: TUI,
	theme: Theme,
	done: (result: CardOutcome) => void,
	questions: CardQuestion[],
	planMode: boolean,
	budgetMs: number | null,
	signal: AbortSignal | undefined,
): { render: (width: number) => string[]; invalidate: () => void; handleInput: (data: string) => void; dispose: () => void } {
	let qIndex = 0;
	let cursor = 0;
	let editing = false;
	let settled = false;
	let cached: string[] | undefined;
	const answers: CardAnswer[] = questions.map(() => ({ labels: [] }));

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	function finish(result: CardOutcome) {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		done(result);
	}

	const timer =
		budgetMs == null
			? undefined
			: setTimeout(() => finish({ kind: "timeout" }), budgetMs);
	const onAbort = () => finish({ kind: "aborted" });
	signal?.addEventListener("abort", onAbort, { once: true });

	function rows(): Row[] {
		const q = questions[qIndex]!;
		const list: Row[] = q.options.map((_, index) => ({ kind: "option", index }));
		list.push({ kind: "other" });
		if (planMode) list.push({ kind: "respond" }, { kind: "finish" });
		return list;
	}

	function refresh() {
		cached = undefined;
		tui.requestRender();
	}

	function current(): CardAnswer {
		return answers[qIndex]!;
	}

	function selectOption(index: number, advance: boolean) {
		const q = questions[qIndex]!;
		const label = q.options[index]!.label;
		const answer = current();
		answer.notes = undefined;
		if (q.multiSelect) {
			const at = answer.labels.indexOf(label);
			if (at >= 0) answer.labels.splice(at, 1);
			else answer.labels.push(label);
		} else {
			answer.labels = [label];
		}
		if (advance && !q.multiSelect) advanceQuestion();
		else refresh();
	}

	function advanceQuestion() {
		if (qIndex < questions.length - 1) {
			qIndex++;
			cursor = 0;
			refresh();
			return;
		}
		finish({ kind: "accepted", answers });
	}

	editor.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) {
			editing = false;
			refresh();
			return;
		}
		current().labels = [OTHER];
		current().notes = trimmed;
		editing = false;
		editor.setText("");
		advanceQuestion();
	};

	function handleInput(data: string) {
		if (settled) return;
		if (editing) {
			if (matchesKey(data, Key.escape)) {
				editing = false;
				editor.setText("");
				refresh();
				return;
			}
			editor.handleInput(data);
			refresh();
			return;
		}

		const list = rows();
		const q = questions[qIndex]!;

		if (matchesKey(data, Key.escape) || data === "X") {
			finish({ kind: "cancelled" });
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			cursor = Math.max(0, cursor - 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			cursor = Math.min(list.length - 1, cursor + 1);
			refresh();
			return;
		}
		if (matchesKey(data, Key.left) || data === "h" || data === "[") {
			if (qIndex > 0) {
				qIndex--;
				cursor = 0;
				refresh();
			}
			return;
		}
		if (matchesKey(data, Key.right) || data === "l" || data === "]") {
			if (qIndex < questions.length - 1) {
				qIndex++;
				cursor = 0;
				refresh();
			}
			return;
		}
		if (data === "z") {
			cursor = q.options.length;
			editing = true;
			editor.setText(current().notes ?? "");
			refresh();
			return;
		}

		const shortcut = SHORTCUTS.indexOf(data);
		if (shortcut >= 0 && shortcut < q.options.length) {
			cursor = shortcut;
			selectOption(shortcut, true);
			return;
		}

		const row = list[cursor];
		if (!row) return;

		if (data === " " || matchesKey(data, Key.space)) {
			if (row.kind === "option" && q.multiSelect) selectOption(row.index, false);
			else if (row.kind === "other") {
				editing = true;
				editor.setText(current().notes ?? "");
				refresh();
			}
			return;
		}

		if (!matchesKey(data, Key.enter)) return;

		if (row.kind === "option") {
			if (q.multiSelect && !current().labels.includes(q.options[row.index]!.label)) {
				selectOption(row.index, false);
			} else if (!q.multiSelect) {
				selectOption(row.index, false);
			}
			advanceQuestion();
			return;
		}
		if (row.kind === "other") {
			editing = true;
			editor.setText(current().notes ?? "");
			refresh();
			return;
		}
		if (row.kind === "respond") finish({ kind: "chat", answers });
		if (row.kind === "finish") finish({ kind: "skip", answers });
	}

	function render(width: number): string[] {
		if (cached) return cached;
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const q = questions[qIndex]!;
		const list = rows();
		const answer = current();

		function add(prefix: string, text: string) {
			const pw = visibleWidth(prefix);
			const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - pw));
			const pad = " ".repeat(Math.min(pw, renderWidth));
			wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : pad}${line}`));
		}

		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		add(" ", theme.fg("accent", theme.bold(`Q${qIndex + 1}/${questions.length}`)) + theme.fg("text", ` ${q.question}`));
		if (q.multiSelect) add(" ", theme.fg("dim", "multi-select"));
		lines.push("");

		for (let i = 0; i < list.length; i++) {
			const row = list[i]!;
			const selected = i === cursor;
			const prefix = selected ? theme.fg("accent", "> ") : "  ";
			if (row.kind === "option") {
				const opt = q.options[row.index]!;
				const mark = q.multiSelect ? (answer.labels.includes(opt.label) ? "[x] " : "[ ] ") : "";
				const key = SHORTCUTS[row.index] ? `${SHORTCUTS[row.index]} ` : "  ";
				add(prefix, theme.fg(selected ? "accent" : "text", `${key}${mark}${opt.label}`));
				if (opt.description) add("     ", theme.fg("muted", opt.description));
			} else if (row.kind === "other") {
				const wrote = answer.labels.includes(OTHER) && answer.notes ? `: ${answer.notes}` : "";
				add(prefix, theme.fg(selected || editing ? "accent" : "text", `z ${OTHER}${editing ? " ✎" : wrote}`));
			} else if (row.kind === "respond") {
				add(prefix, theme.fg(selected ? "accent" : "warning", "Respond to agent"));
			} else {
				add(prefix, theme.fg(selected ? "accent" : "warning", "Finish plan interview"));
			}
		}

		const focused = list[cursor];
		if (!editing && focused?.kind === "option") {
			const preview = q.multiSelect ? undefined : q.options[focused.index]?.preview;
			if (preview) {
				lines.push("");
				for (const line of preview.split("\n").slice(0, 8)) add(" ", theme.fg("dim", line));
			}
		}
		if (editing) {
			lines.push("");
			add(" ", theme.fg("muted", "Your answer:"));
			for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
			add(" ", theme.fg("dim", "Enter submits · Esc back to options"));
		} else {
			lines.push("");
			add(
				" ",
				theme.fg(
					"dim",
					"↑↓/jk move · 1-9/a-f pick · z other · ←→ questions · Enter advance · Esc cancel",
				),
			);
		}
		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		cached = lines;
		return lines;
	}

	return {
		render,
		invalidate: () => {
			cached = undefined;
		},
		handleInput,
		dispose() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

