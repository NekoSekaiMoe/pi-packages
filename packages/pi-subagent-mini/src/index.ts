import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-subagent-mini — one tool, four actions.
 * Children run `pi --mode json -p --no-session -ne` and their final output is
 * delivered back via a steering message on completion (a new turn).
 */

const MAX_CONCURRENT = 4;
const DEFAULT_TOOLS = "read,bash,grep,find,ls";
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_REPORT_CHARS = 6000;
/** Same widget key pi-subagents uses, so pi-ui's flat skin picks this up too. */
const WIDGET_KEY = "subagent-async";

interface Job {
	id: string;
	task: string;
	proc: ChildProcess;
	startedAt: number;
	status: "running" | "completed" | "failed" | "killed" | "timeout";
	finalOutput: string;
	errorMessage?: string;
	usage?: { input: number; output: number };
	done: Promise<void>;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function resolvePiBin(): { cmd: string; args: string[] } {
	try {
		const dir = getPackageDir();
		const bin = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin?.pi;
		if (typeof bin === "string") return { cmd: process.execPath, args: [path.join(dir, bin)] };
	} catch {
		// fall through
	}
	return { cmd: "pi", args: [] };
}

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

export default function subagentMini(pi: ExtensionAPI): void {
	const jobs = new Map<string, Job>();
	let counter = 0;
	const piBin = resolvePiBin();
	let uiRef: { setWidget(key: string, content: unknown, options?: unknown): void } | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;

	const widgetLines = (): string[] | undefined => {
		const running = [...jobs.values()].filter((j) => j.status === "running");
		if (running.length === 0) return undefined;
		const lines = [`● ${running.length} subagent${running.length > 1 ? "s" : ""} running`];
		for (const j of running) {
			const elapsed = Math.round((Date.now() - j.startedAt) / 1000);
			const task = j.task.length > 60 ? `${j.task.slice(0, 60)}…` : j.task.replace(/\s+/g, " ");
			lines.push(`  └ ${j.id} · ${elapsed}s · ${task}`);
		}
		return lines;
	};

	const refreshWidget = (): void => {
		if (!uiRef?.setWidget) return;
		try {
			uiRef.setWidget(WIDGET_KEY, widgetLines(), { placement: "belowEditor" });
		} catch {
			// widget is cosmetic; never break the tool flow
		}
	};

	const ensureWidgetTimer = (): void => {
		if (widgetTimer) return;
		widgetTimer = setInterval(() => {
			if (![...jobs.values()].some((j) => j.status === "running")) {
				clearInterval(widgetTimer);
				widgetTimer = undefined;
			refreshWidget(); // clears it (undefined lines)
				return;
			}
			refreshWidget();
		}, 1000);
		widgetTimer.unref?.();
	};

	const notify = (job: Job): void => {
		const report = job.finalOutput || job.errorMessage || "(no output)";
		const clipped = report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n…(truncated, use action=status for full output)` : report;
		try {
			pi.sendMessage(
				{
					customType: "subagent-complete",
					content: `Subagent ${job.id} ${job.status}${job.usage ? ` (${job.usage.input}+${job.usage.output} tok)` : ""}:\n\n${clipped}`,
					display: true,
					details: { jobId: job.id, status: job.status },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// notification is best-effort; status/wait still work
		}
	};

	const spawnJob = (params: { task: string; tools?: string; cwd?: string; model?: string; timeoutSec?: number }, ctxCwd: string): Job => {
		const id = `sa-${++counter}`;
		const args = [
			...piBin.args,
			"--mode", "json", "-p", "--no-session", "-ne",
			"--no-skills", "--no-prompt-templates", "--no-context-files",
			"-t", params.tools || DEFAULT_TOOLS,
		];
		if (params.model) args.push("-m", params.model);
		args.push(`Task: ${params.task}`);

		const proc = spawn(piBin.cmd, args, {
			cwd: params.cwd || ctxCwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let lastAssistant: { text: string; usage?: { input: number; output: number } } | undefined;
		let stderrTail = "";
		let settled = false;

		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const job: Job = {
			id, task: params.task, proc, startedAt: Date.now(),
			status: "running", finalOutput: "", done,
		};

		const finish = (status: Job["status"], errorMessage?: string): void => {
			if (settled) return;
			settled = true;
			job.status = status;
			job.errorMessage = errorMessage;
			job.finalOutput = lastAssistant?.text ?? "";
			job.usage = lastAssistant?.usage;
			jobs.set(id, job); // keep for status/wait queries
			notify(job);
			resolveDone();
			refreshWidget();
		};

		let buffer = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const event = JSON.parse(line) as {
						type: string;
						message?: { role: string; content?: Array<{ type: string; text?: string }>; usage?: { input: number; output: number }; stopReason?: string };
					};
					if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason && event.message.stopReason !== "pending") {
						lastAssistant = {
							text: textOf(event.message),
							usage: event.message.usage ? { input: event.message.usage.input ?? 0, output: event.message.usage.output ?? 0 } : undefined,
						};
					}
				} catch {
					// skip malformed line
				}
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = `${stderrTail}${chunk.toString()}`.slice(-1500);
		});
		proc.on("error", (error: Error) => finish("failed", `spawn failed: ${error.message}`));
		proc.on("close", (code) => {
			if (settled) return;
			if (code === 0 && lastAssistant) finish("completed");
			else if (code === 0) finish("failed", `no assistant output${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
			else finish("failed", `exit ${code}${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
		});

		const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
		const timer = setTimeout(() => {
			if (!settled) {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000).unref();
				finish("timeout", `timed out after ${timeoutSec}s`);
			}
		}, timeoutSec * 1000);
		timer.unref?.();

		jobs.set(id, job);
		refreshWidget();
		ensureWidgetTimer();
		return job;
	};

	pi.on("session_start", async (_event, ctx) => {
		uiRef = ctx.ui as typeof uiRef;
	});

	pi.on("session_shutdown", async () => {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
		for (const job of jobs.values()) {
			if (job.status === "running") {
				job.proc.kill("SIGKILL");
				job.status = "killed";
			}
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a fresh isolated subagent (own minimal pi session) for a self-contained task and receive its report via a subagent-complete notification (new turn). spawn returns a jobId immediately — keep working meanwhile; wait blocks until done; status shows state + output tail; kill stops it. Re-delegate follow-ups as a new spawn with context from the previous report.",
		promptSnippet: "Delegate self-contained tasks to an isolated subagent; result arrives via completion notification",
		promptGuidelines: [
			"Delegate context-heavy but self-contained work (multi-file reconnaissance, code review, long test/build runs) to subagent spawn with read-only tools; keep only the final report in this conversation. Add write/edit to tools only when the subagent should modify files.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("spawn"), Type.Literal("wait"), Type.Literal("status"), Type.Literal("kill")], { description: "default flow: spawn, then wait for the notification" }),
			task: Type.Optional(Type.String({ description: "spawn: full task incl. role (e.g. 'You are a reviewer…')" })),
			tools: Type.Optional(Type.String({ description: `spawn: comma list, default ${DEFAULT_TOOLS}` })),
			cwd: Type.Optional(Type.String({ description: "spawn: working directory" })),
			model: Type.Optional(Type.String({ description: "spawn: model id" })),
			timeoutSec: Type.Optional(Type.Number({ description: "spawn: max seconds, default 600" })),
			jobId: Type.Optional(Type.String({ description: "wait/status/kill: job id" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!uiRef) uiRef = ctx.ui as typeof uiRef;
			if (params.action === "spawn") {
				if (!params.task?.trim()) return textResult("spawn requires 'task'");
				const running = [...jobs.values()].filter((j) => j.status === "running").length;
				if (running >= MAX_CONCURRENT) return textResult(`concurrency limit: ${running}/${MAX_CONCURRENT} subagents running; wait or kill one first`);
				const job = spawnJob({ task: params.task, tools: params.tools, cwd: params.cwd, model: params.model, timeoutSec: params.timeoutSec }, ctx.cwd);
				return textResult(
					`subagent ${job.id} spawned (cwd: ${params.cwd || ctx.cwd}, tools: ${params.tools || DEFAULT_TOOLS}).\n` +
					"A subagent-complete notification with its report arrives when done — continue other work meanwhile. action=status peeks, action=wait blocks, action=kill stops it.",
				);
			}

			const job = params.jobId ? jobs.get(params.jobId) : [...jobs.values()].filter((j) => j.status === "running").pop();
			if (!job) return textResult(`no subagent found (jobId: ${params.jobId ?? "?"}); running: ${[...jobs.values()].filter((j) => j.status === "running").map((j) => j.id).join(", ") || "none"}`);

			if (params.action === "status") {
				const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
				const tail = (job.finalOutput || job.errorMessage || "(still running, no final output yet)").slice(-1500);
				return textResult(`subagent ${job.id}: ${job.status} (${elapsed}s)\ntask: ${job.task.slice(0, 200)}\n\n${tail}`);
			}
			if (params.action === "wait") {
				const timeout = setTimeout(() => undefined, 120_000);
				await Promise.race([job.done, new Promise((r) => setTimeout(r, 120_000))]);
				clearTimeout(timeout);
				return textResult(`subagent ${job.id}: ${job.status}\n\n${(job.finalOutput || job.errorMessage || "(no output)").slice(-MAX_REPORT_CHARS)}`);
			}
			// kill
			job.proc.kill("SIGTERM");
			job.status = "killed";
			refreshWidget();
			return textResult(`subagent ${job.id} killed`);
		},
	});
}
