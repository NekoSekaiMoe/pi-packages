import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Inlined (was @juicesharp/rpiv-config) — reads optional guidance overrides. */
export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
}

export function loadConfig(): AskUserQuestionConfig {
	try {
		const file = path.join(os.homedir(), ".config", "rpiv", "rpiv-ask-user-question.json");
		return JSON.parse(fs.readFileSync(file, "utf8")) as AskUserQuestionConfig;
	} catch {
		return {};
	}
}

export function validateGuidanceFields(g: GuidanceFields | undefined): GuidanceFields {
	return g && typeof g === "object" ? g : {};
}
