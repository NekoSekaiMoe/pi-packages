import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { ASK_USER_PROMPT_EVENT, type AskUserPromptEventPayload } from "./events.js";
import { displayLabel } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): void {
	const payload: AskUserPromptEventPayload = {
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	const hasAnyPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	for (const kind of sentinelsToAppend(question, hasAnyPreview)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question when the request is underspecified and you need concrete decisions (up to ${MAX_QUESTIONS} questions in one call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options: concise label + explanatory description). Options may carry a markdown preview for side-by-side comparison (single-select only); multiSelect allows several answers; put your recommended option first with "(Recommended)".`,
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description: "Ask the user 1-4 structured questions (2-4 options each) when requirements are ambiguous; options may carry markdown previews; group all questions into one call.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			// Emit event for external listeners (e.g., notification plugins)
			emitAskUserPromptEvent(pi, typed);

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			// Lazy — QuestionnaireSession pulls the ~560ms view/TUI render graph;
			// load it only when the tool runs, not at extension registration.
			const { QuestionnaireSession } = await import("./state/questionnaire-session.js");

			const result = await ctx.ui.custom<QuestionnaireResult>(
				(tui, theme, _kb, done) => {
					const session = new QuestionnaireSession({
						tui,
						theme,
						params: typed,
						itemsByTab,
						done,
					});
					return session.component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: { left: 0, right: 0, bottom: 0 },
					},
				},
			);

			return buildQuestionnaireResponse(result, typed);
		},
	});
}

export { buildQuestionnaireResponse, buildToolResult };
