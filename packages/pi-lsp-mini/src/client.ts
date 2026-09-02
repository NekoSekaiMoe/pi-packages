import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { RpcConnection } from "./jsonrpc.ts";
import { Methods, type CallHierarchyItem, type Diagnostic, type DocumentSymbol, type Location, type SymbolInformation, type TextEdit, type WorkspaceEdit } from "./lsp-types.ts";
import type { LspServerConfig } from "./config.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

export function filePathToUri(file: string): string {
	return `file://${encodeURI(file.split(path.sep).join("/")).replace(/[?#]/g, encodeURIComponent)}`;
}

export function uriToFilePath(uri: string): string {
	return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

export interface OpenDocument {
	file: string;
	uri: string;
	languageId: string;
	version: number;
	text: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => timer && clearTimeout(timer));
}

interface ServerCapabilitiesLike {
	callHierarchyProvider?: unknown;
	renameProvider?: unknown;
	textDocumentSync?: number | { save?: unknown };
}

export class LspClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private connection: RpcConnection | undefined;
	private capabilities: ServerCapabilitiesLike | undefined;
	private readonly documents = new Map<string, OpenDocument>();
	private startPromise: Promise<void> | undefined;
	private failureReason: string | undefined;
	private stderrTail = "";

	constructor(
		readonly server: LspServerConfig,
		readonly root: string,
		private readonly command: { bin: string; args: string[] },
		private readonly onDiagnostics: (file: string, diagnostics: Diagnostic[]) => void,
	) {}

	get dead(): boolean {
		return !!this.failureReason;
	}

	get reason(): string | undefined {
		return this.failureReason;
	}

	get supportsCallHierarchy(): boolean {
		return !!this.capabilities?.callHierarchyProvider;
	}

	get supportsRename(): boolean {
		return !!this.capabilities?.renameProvider;
	}

	async ensureStarted(signal?: AbortSignal): Promise<void> {
		if (this.connection && !this.failureReason) return;
		if (this.failureReason) throw new Error(this.failureReason);
		this.startPromise ??= this.start(signal);
		await this.startPromise;
	}

	private async start(signal?: AbortSignal): Promise<void> {
		const child = spawn(this.command.bin, this.command.args, {
			cwd: this.root,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2000);
		});
		child.on("exit", (code, sig) => {
			this.fail(`${this.server.id}: server exited (${code ?? sig ?? "unknown"})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ""}`);
		});
		child.on("error", (error: Error) => {
			this.fail(`${this.server.id}: spawn failed: ${error.message}`);
		});

		const connection = new RpcConnection(child.stdout, child.stdin);
		this.connection = connection;
		this.registerHandlers(connection);

		const init = (await withTimeout(
			connection.sendRequest<{ capabilities: ServerCapabilitiesLike }>(Methods.initialize, this.initializeParams()),
			STARTUP_TIMEOUT_MS,
			`${this.server.id} initialize`,
		)) as { capabilities: ServerCapabilitiesLike };
		this.capabilities = init.capabilities;

		await connection.sendNotification(Methods.initialized, {});
		if (this.server.settings !== undefined) {
			await connection.sendNotification(Methods.didChangeConfig, { settings: this.server.settings });
		}
		if (signal?.aborted) throw new Error("aborted");
	}

	private fail(reason: string): void {
		this.failureReason = reason;
		try {
			this.connection?.dispose();
		} catch {
			// dispose may reject pending responses; ignore
		}
		this.connection = undefined;
	}

	private initializeParams() {
		const rootUri = filePathToUri(this.root);
		return {
			processId: process.pid,
			rootUri,
			workspaceFolders: [{ name: path.basename(this.root), uri: rootUri }],
			capabilities: {
				window: { workDoneProgress: true },
				workspace: { configuration: true, workspaceFolders: true },
				textDocument: {
					synchronization: { didOpen: true, didChange: true, didSave: true },
					publishDiagnostics: { relatedInformation: true },
					references: {},
					rename: {},
					documentSymbol: {},
					callHierarchy: {},
				},
			},
			initializationOptions: this.server.initializationOptions ?? {},
		};
	}

	private registerHandlers(connection: RpcConnection): void {
		connection.onNotification(Methods.publishDiagnostics, (params) => {
			const p = params as { uri: string; diagnostics: Diagnostic[] };
			this.onDiagnostics(uriToFilePath(p.uri), p.diagnostics ?? []);
		});
		connection.onRequest("workspace/configuration", (params) => {
			const items = (params as { items?: unknown[] })?.items ?? [];
			return items.map(() => this.server.settings ?? {});
		});
		connection.onRequest("workspace/workspaceFolders", () => [{ name: path.basename(this.root), uri: filePathToUri(this.root) }]);
		connection.onRequest("client/registerCapability", () => null);
		connection.onRequest("client/unregisterCapability", () => null);
		connection.onRequest("window/workDoneProgress/create", () => null);
		connection.onRequest("window/showMessageRequest", () => null);
		connection.onNotification("window/logMessage", () => undefined);
		connection.onNotification("window/showMessage", () => undefined);
		connection.onNotification("telemetry/event", () => undefined);
	}

	private req<T>(label: string, method: string, params: unknown): Promise<T> {
		if (!this.connection) throw new Error(`${this.server.id}: connection unavailable`);
		return withTimeout(this.connection.sendRequest<T>(method, params), REQUEST_TIMEOUT_MS, label);
	}

	/** Opens (or updates) the file on the server so it matches disk content. */
	async openOrChange(file: string, languageId: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.ensureStarted(signal);
		if (!this.connection) throw new Error(`${this.server.id}: connection unavailable`);
		const uri = filePathToUri(file);
		const existing = this.documents.get(file);
		if (!existing) {
			const doc: OpenDocument = { file, uri, languageId, version: 1, text };
			this.documents.set(file, doc);
			await this.connection.sendNotification(Methods.didOpen, {
				textDocument: { uri, languageId, version: doc.version, text },
			});
			return;
		}
		const version = existing.version + 1;
		this.documents.set(file, { ...existing, version, text });
		await this.connection.sendNotification(Methods.didChange, {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	async references(file: string, line: number, character: number, includeDeclaration: boolean): Promise<Location[] | null> {
		return this.req<Location[] | null>(`${this.server.id} references`, Methods.references, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
			context: { includeDeclaration },
		});
	}

	async prepareCallHierarchy(file: string, line: number, character: number): Promise<CallHierarchyItem[] | null> {
		return this.req<CallHierarchyItem[] | null>(`${this.server.id} prepareCallHierarchy`, Methods.prepareCallHierarchy, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
		});
	}

	async incomingCalls(item: CallHierarchyItem): Promise<{ from: CallHierarchyItem; fromRanges: Location[] }[] | null> {
		return this.req(`${this.server.id} incomingCalls`, Methods.incomingCalls, { item });
	}

	async outgoingCalls(item: CallHierarchyItem): Promise<{ to: CallHierarchyItem; fromRanges: Location[] }[] | null> {
		return this.req(`${this.server.id} outgoingCalls`, Methods.outgoingCalls, { item });
	}

	async rename(file: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
		return this.req<WorkspaceEdit | null>(`${this.server.id} rename`, Methods.rename, {
			textDocument: { uri: filePathToUri(file) },
			position: { line, character },
			newName,
		});
	}

	async documentSymbol(file: string): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
		return this.req<DocumentSymbol[] | SymbolInformation[] | null>(`${this.server.id} documentSymbol`, Methods.documentSymbol, {
			textDocument: { uri: filePathToUri(file) },
		});
	}

	async shutdown(): Promise<void> {
		const connection = this.connection;
		const child = this.process;
		this.connection = undefined;
		this.process = undefined;
		try {
			if (child && child.exitCode === null) {
				const send = (msg: string) => child.stdin?.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
				send('{"jsonrpc":"2.0","id":9999,"method":"shutdown"}');
				send('{"jsonrpc":"2.0","method":"exit"}');
			}
		} catch {
			// best effort
		}
		connection?.dispose();
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
		}
	}
}
