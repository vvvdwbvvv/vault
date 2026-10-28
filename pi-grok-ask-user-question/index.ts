import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type CardAnswer, type CardOutcome, type CardQuestion, openQuestionCard } from "./dialog.ts";
import {
	CANCEL_TEXT,
	formatAccepted,
	formatChatAboutThis,
	formatSkipInterview,
	NO_OPERATOR_TEXT,
	NO_QUESTIONS_TEXT,
	OTHER,
	unansweredText,
	waitBudgetMs,
} from "./format.ts";

const RESERVED = new Set([OTHER, "Done", "Respond to agent", "Finish plan interview"]);

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short option label. Put the recommended choice first and append (Recommended)." }),
	description: Type.String({ description: "What picking this option means." }),
	preview: Type.Optional(Type.String({ description: "Text shown while this option is focused. Ignored when multi_select is true." })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ description: "The question, as a full question. Must be unique in this call." }),
	options: Type.Array(OptionSchema, { description: "Choices. Other is added automatically." }),
	multi_select: Type.Optional(Type.Boolean({ description: "Allow more than one choice. Default false." })),
});

const Params = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "At least one question." }),
});

interface Details {
	outcome: CardOutcome["kind"] | "no-operator" | "empty";
	pairs: { question: string; answer: string }[];
}

let planMode = process.env.PI_ASK_USER_QUESTION_MODE === "plan";

function textResult(text: string, details: Details) {
	return { content: [{ type: "text" as const, text }], details };
}

function pairsFrom(questions: CardQuestion[], answers: CardAnswer[]): { question: string; answer: string }[] {
	return questions.flatMap((q, i) => {
		const labels = answers[i]?.labels ?? [];
		if (labels.length === 0) return [];
		const notes = answers[i]?.notes;
		return [{ question: q.question, answer: notes ? `${labels.join(", ")} (${notes})` : labels.join(", ") }];
	});
}

function validate(raw: { question: string; options: { label: string; description: string; preview?: string }[]; multi_select?: boolean }[]): CardQuestion[] {
	const seen = new Set<string>();
	return raw.map((q) => {
		if (!q.question.trim()) throw new Error("Question text is empty");
		if (!seen.add(q.question)) throw new Error(`Duplicate question text: "${q.question}"`);
		if (q.options.length === 0) throw new Error(`No options for: "${q.question}"`);
		const labels = new Set<string>();
		for (const opt of q.options) {
			if (!opt.label.trim() || !opt.description.trim()) throw new Error(`Option label and description are required: "${q.question}"`);
			if (RESERVED.has(opt.label)) throw new Error(`Reserved option label: "${opt.label}"`);
			if (!labels.add(opt.label)) throw new Error(`Duplicate option label "${opt.label}" in "${q.question}"`);
		}
		return {
			question: q.question,
			multiSelect: q.multi_select === true,
			options: q.options.map((opt) => ({
				label: opt.label,
				description: opt.description,
				preview: q.multi_select ? undefined : opt.preview,
			})),
		};
	});
}

function modelText(questions: CardQuestion[], outcome: CardOutcome): string {
	if (outcome.kind === "cancelled" || outcome.kind === "timeout") return unansweredText(false);
	if (outcome.kind === "aborted") return unansweredText(false);
	const answers = new Map<string, string[]>();
	const annotations = new Map<string, { preview?: string; notes?: string }>();
	const partial = new Map<string, string>();
	questions.forEach((q, i) => {
		const row = outcome.answers[i];
		if (!row?.labels.length) return;
		answers.set(q.question, row.labels);
		partial.set(q.question, row.labels.join(", "));
		const ann: { preview?: string; notes?: string } = {};
		if (row.notes) ann.notes = row.notes;
		if (!q.multiSelect && row.labels.length === 1) {
			ann.preview = q.options.find((opt) => opt.label === row.labels[0])?.preview;
		}
		if (ann.notes || ann.preview) annotations.set(q.question, ann);
	});
	if (outcome.kind === "chat") return formatChatAboutThis(questions, partial);
	if (outcome.kind === "skip") return formatSkipInterview(questions, partial);
	return formatAccepted(questions, answers, annotations);
}

async function askRpc(ctx: ExtensionContext, questions: CardQuestion[], budgetMs: number | null, signal: AbortSignal | undefined): Promise<CardOutcome> {
	const deadline = budgetMs == null ? null : Date.now() + budgetMs;
	const answers: CardAnswer[] = questions.map(() => ({ labels: [] }));
	const opts = () => {
		if (signal?.aborted) return { signal };
		if (deadline == null) return { signal };
		return { signal, timeout: Math.max(1, deadline - Date.now()) };
	};
	const dismissed = (): CardOutcome => {
		if (signal?.aborted) return { kind: "aborted" };
		if (deadline != null && Date.now() >= deadline - 50) return { kind: "timeout" };
		return { kind: "cancelled" };
	};

	for (let i = 0; i < questions.length; i++) {
		if (deadline != null && Date.now() >= deadline) return { kind: "timeout" };
		const q = questions[i]!;
		const title = `${i + 1}/${questions.length} ${q.question}`;
		const plan = planMode ? ["Respond to agent", "Finish plan interview"] : [];
		if (!q.multiSelect) {
			const choice = await ctx.ui.select(title, [...q.options.map((opt) => opt.label), OTHER, ...plan], opts());
			if (choice === undefined) return dismissed();
			if (choice === "Respond to agent") return { kind: "chat", answers };
			if (choice === "Finish plan interview") return { kind: "skip", answers };
			if (choice === OTHER) {
				const text = await ctx.ui.input(q.question, OTHER, opts());
				if (!text?.trim()) return dismissed();
				answers[i] = { labels: [OTHER], notes: text.trim() };
			} else {
				answers[i] = { labels: [choice] };
			}
			continue;
		}
		const picked: string[] = [];
		for (;;) {
			const choice = await ctx.ui.select(
				title,
				[...q.options.map((opt) => `${picked.includes(opt.label) ? "[x] " : "[ ] "}${opt.label}`), OTHER, "Done", ...plan],
				opts(),
			);
			if (choice === undefined) return dismissed();
			if (choice === "Respond to agent") return { kind: "chat", answers };
			if (choice === "Finish plan interview") return { kind: "skip", answers };
			if (choice === "Done") {
				answers[i] = { labels: picked };
				break;
			}
			if (choice === OTHER) {
				const text = await ctx.ui.input(q.question, OTHER, opts());
				if (!text?.trim()) return dismissed();
				answers[i] = { labels: [OTHER], notes: text.trim() };
				break;
			}
			const label = choice.replace(/^\[.\] /, "");
			const at = picked.indexOf(label);
			if (at >= 0) picked.splice(at, 1);
			else picked.push(label);
		}
	}
	return { kind: "accepted", answers };
}

export default function (pi: ExtensionAPI) {
	pi.events.on("plan-mode", (data) => {
		if (typeof data === "boolean") planMode = data;
		else if (data && typeof data === "object" && "enabled" in data) planMode = Boolean((data as { enabled?: boolean }).enabled);
	});

	pi.registerTool({
		name: "AskUserQuestion",
		label: "AskUserQuestion",
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description: `Ask the user one or more multiple-choice questions.

- Every question automatically gets an "Other" choice where the user can type their own answer.
- Put your recommended option first and append "(Recommended)" to its label.
- In plan mode the card also offers Respond to agent and Finish plan interview.`,
		promptSnippet: "Ask structured questions instead of guessing when a choice blocks the task.",
		promptGuidelines: [
			'Every question automatically gets an "Other" choice. Do not add that option yourself.',
			'Put the recommended option first and append "(Recommended)" to its label.',
			"Question text must be unique within the call. Use one call for every question you need.",
			"Cancel, timeout, and a non-interactive session are not failures. Continue with your best judgment.",
			"If the result says the user wants to clarify, ask what they want to clarify. If it says to finish the plan, stop asking and finish the plan.",
		],
		parameters: Params,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.questions.length === 0) return textResult(NO_QUESTIONS_TEXT, { outcome: "empty", pairs: [] });
			const questions = validate(params.questions);
			if (ctx.mode === "json" || ctx.mode === "print" || !ctx.hasUI) {
				return textResult(NO_OPERATOR_TEXT, { outcome: "no-operator", pairs: [] });
			}
			const budgetMs = waitBudgetMs();
			const outcome =
				ctx.mode === "tui"
					? await ctx.ui.custom<CardOutcome>((tui, theme, _kb, done) =>
							openQuestionCard(tui, theme, done, questions, planMode, budgetMs, signal),
						)
					: await askRpc(ctx, questions, budgetMs, signal);
			if (outcome.kind === "aborted" || signal?.aborted) {
				throw new Error("Aborted");
			}
			const answers = outcome.kind === "cancelled" || outcome.kind === "timeout" ? [] : outcome.answers;
			return textResult(modelText(questions, outcome), {
				outcome: outcome.kind,
				pairs: pairsFrom(questions, answers),
			});
		},
		renderCall(args, theme) {
			const n = args.questions?.length ?? 0;
			return new Text(theme.fg("toolTitle", theme.bold("AskUserQuestion ")) + theme.fg("muted", `${n} question${n === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as Details | undefined;
			if (!details) {
				const text = result.content.find((part) => part.type === "text");
				return new Text(text && "text" in text ? text.text : "", 0, 0);
			}
			if (details.outcome === "cancelled" || details.outcome === "timeout") {
				return new Text(theme.fg("warning", details.outcome === "timeout" ? "Timed out" : "Cancelled"), 0, 0);
			}
			if (details.outcome === "no-operator") return new Text(theme.fg("muted", "No operator"), 0, 0);
			if (!options.expanded) {
				return new Text(theme.fg("success", `${details.pairs.length} answered`), 0, 0);
			}
			const lines = details.pairs.map((pair) => `${theme.fg("accent", pair.question)} ${theme.fg("text", pair.answer)}`);
			return new Text(lines.join("\n") || theme.fg("muted", details.outcome), 0, 0);
		},
	});
}

export { CANCEL_TEXT, NO_OPERATOR_TEXT };
