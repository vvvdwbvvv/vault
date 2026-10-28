/** Model-visible strings. Pinned to grok-build ask_user_question/format.rs. */

import { pathToFileURL } from "node:url";

export const CANCEL_TEXT =
	"User declined to answer the questions. Continue with the task using your best judgment, or ask different questions.";

export const NO_OPERATOR_TEXT =
	"No user is available to answer questions in this non-interactive session. Continue with your best judgment; do not wait for clarification.";

export const NO_QUESTIONS_TEXT = "No questions provided. Continue with the task.";

export const OTHER = "Other";

export function unansweredText(nonInteractive: boolean): string {
	return nonInteractive ? NO_OPERATOR_TEXT : CANCEL_TEXT;
}

export interface QuestionAnnotation {
	preview?: string;
	notes?: string;
}

export interface FormatQuestion {
	question: string;
	id?: string;
	options: { label: string; id?: string; preview?: string }[];
}

export function formatAccepted(
	questions: { question: string }[],
	answers: Map<string, string[]>,
	annotations?: Map<string, QuestionAnnotation>,
): string {
	const entries: string[] = [];
	for (const q of questions) {
		const labels = answers.get(q.question);
		if (!labels?.length) continue;
		const parts = [`"${q.question}"="${labels.join(", ")}"`];
		const ann = annotations?.get(q.question);
		if (ann?.preview) parts.push(`selected preview:\n${ann.preview}`);
		if (ann?.notes) parts.push(`user notes: ${ann.notes}`);
		entries.push(parts.join(" "));
	}
	return `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind.`;
}

export function formatIdKeyed(
	questions: FormatQuestion[],
	answers: Map<string, string[]>,
	annotations?: Map<string, QuestionAnnotation>,
): string {
	const lines: string[] = [];
	for (const q of questions) {
		if (!q.id) continue;
		const labels = answers.get(q.question);
		if (!labels) continue;
		const oids = labels.flatMap((label) => {
			const id = q.options.find((o) => o.label === label)?.id;
			return id ? [id] : [];
		});
		if (oids.length === 0) {
			const notes = annotations?.get(q.question)?.notes?.trim();
			if (!notes) continue;
			lines.push(`Question ${q.id}: ${notes}`);
			continue;
		}
		lines.push(`Question ${q.id}: Selected option(s) ${oids.join(", ")}`);
	}
	if (lines.length === 0) return "User questions responses:";
	return `User questions responses:\n${lines.join("\n")}`;
}

function questionLines(questions: { question: string }[], partial: Map<string, string>): string {
	return questions
		.map((q) => {
			const answer = partial.get(q.question);
			return answer !== undefined
				? `- "${q.question}"\n  Answer: ${answer}`
				: `- "${q.question}"\n  (No answer provided)`;
		})
		.join("\n");
}

export function formatChatAboutThis(questions: { question: string }[], partial: Map<string, string>): string {
	return (
		"The user wants to clarify these questions.\n" +
		"    This means they may have additional information, context or questions for you.\n" +
		"    Take their response into account and then reformulate the questions if appropriate.\n" +
		"    Start by asking them what they would like to clarify.\n" +
		"\n" +
		"    Questions asked:\n" +
		questionLines(questions, partial)
	);
}

export function formatSkipInterview(questions: { question: string }[], partial: Map<string, string>): string {
	return (
		"The user has indicated they have provided enough answers for the plan interview.\n" +
		"Stop asking clarifying questions and proceed to finish the plan with the information you have.\n" +
		"\n" +
		"Questions asked and answers provided:\n" +
		questionLines(questions, partial)
	);
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** `null` waits forever. `0` is not forever. Invalid env falls back to 30 minutes. */
export function waitBudgetMs(env: NodeJS.ProcessEnv = process.env): number | null {
	const enabled = env.PI_ASK_USER_QUESTION_TIMEOUT ?? env.GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED;
	if (enabled === "0" || enabled === "false" || enabled === "off") return null;
	const raw = env.PI_ASK_USER_QUESTION_TIMEOUT_SECS ?? env.GROK_ASK_USER_QUESTION_TIMEOUT_SECS;
	if (raw == null || raw === "") return DEFAULT_TIMEOUT_MS;
	if (!/^[1-9]\d*$/.test(raw)) return DEFAULT_TIMEOUT_MS;
	return Number(raw) * 1000;
}

function demo(): void {
	const answers = new Map<string, string[]>([["Which database?", ["Redis (Recommended)"]]]);
	const accepted = formatAccepted([{ question: "Which database?" }], answers);
	if (!accepted.includes('"Which database?"="Redis (Recommended)"')) throw new Error(accepted);
	if (!accepted.startsWith("User has answered your questions: ")) throw new Error(accepted);

	const multi = formatAccepted([{ question: "Which features?" }], new Map([["Which features?", ["Auth", "Logging"]]]));
	if (!multi.includes('"Which features?"="Auth, Logging"')) throw new Error(multi);

	const anns = new Map<string, QuestionAnnotation>([["Which database?", { notes: "I want to use DynamoDB" }]]);
	const free = formatAccepted([{ question: "Which database?" }], new Map([["Which database?", [OTHER]]]), anns);
	if (!free.includes('"Which database?"="Other"') || !free.includes("user notes: I want to use DynamoDB")) {
		throw new Error(free);
	}

	const empty = formatAccepted([], new Map());
	if (empty !== "User has answered your questions: . You can now continue with the user's answers in mind.") {
		throw new Error(empty);
	}

	const qs: FormatQuestion[] = [
		{
			question: "Pick one",
			id: "random_one",
			options: [
				{ label: "Ocean", id: "ocean" },
				{ label: "Mountains", id: "mountains" },
			],
		},
	];
	const idFree = formatIdKeyed(qs, new Map([["Pick one", [OTHER]]]), new Map([["Pick one", { notes: "nvm" }]]));
	if (idFree !== "User questions responses:\nQuestion random_one: nvm") throw new Error(idFree);
	const idPick = formatIdKeyed(qs, new Map([["Pick one", ["Ocean"]]]));
	if (idPick !== "User questions responses:\nQuestion random_one: Selected option(s) ocean") throw new Error(idPick);
	if (formatIdKeyed(qs, new Map()) !== "User questions responses:") throw new Error("header");

	const chat = formatChatAboutThis(
		[{ question: "Which database?" }, { question: "Which framework?" }],
		new Map([["Which database?", "Redis"]]),
	);
	if (!chat.includes("    Questions asked:\n- \"Which database?\"\n  Answer: Redis\n- \"Which framework?\"\n  (No answer provided)")) {
		throw new Error(chat);
	}
	if (!chat.startsWith("The user wants to clarify these questions.\n    This means")) throw new Error(chat);

	const skip = formatSkipInterview([{ question: "Q?" }], new Map());
	if (skip.split("\n")[0]?.startsWith(" ")) throw new Error("skip indent");
	if (!skip.includes("\nQuestions asked and answers provided:\n- \"Q?\"\n  (No answer provided)")) throw new Error(skip);

	if (unansweredText(false) !== CANCEL_TEXT || unansweredText(true) !== NO_OPERATOR_TEXT) throw new Error("unanswered");
	if (waitBudgetMs({}) !== DEFAULT_TIMEOUT_MS) throw new Error("default budget");
	if (waitBudgetMs({ PI_ASK_USER_QUESTION_TIMEOUT: "off" }) !== null) throw new Error("disarm");
	if (waitBudgetMs({ PI_ASK_USER_QUESTION_TIMEOUT_SECS: "0" }) !== DEFAULT_TIMEOUT_MS) throw new Error("zero");
	if (waitBudgetMs({ GROK_ASK_USER_QUESTION_TIMEOUT_SECS: "5" }) !== 5000) throw new Error("env");
	console.log("format ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) demo();
