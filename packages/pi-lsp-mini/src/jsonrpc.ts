import type { Writable, Readable } from "node:stream";

/**
 * Minimal JSON-RPC 2.0 connection over stdio with Content-Length framing,
 * replacing vscode-jsonrpc so this package has zero runtime dependencies.
 */

export interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

type NotificationHandler = (params: unknown) => void;
type RequestHandler = (params: unknown) => unknown;

const CRLF_CRLF = Buffer.from("\r\n\r\n");

export class RpcConnection {
	private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly notificationHandlers = new Map<string, NotificationHandler>();
	private readonly requestHandlers = new Map<string, RequestHandler>();
	private closed = false;

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
	) {
		input.on("data", (chunk: Buffer) => {
			this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
			this.drain();
		});
		input.on("error", () => this.failAll("input stream error"));
		input.on("close", () => this.failAll("input stream closed"));
	}

	/** Parses as many framed messages as the buffer holds (byte-accurate via Buffer). */
	private drain(): void {
		for (;;) {
			const headerEnd = this.buffer.indexOf(CRLF_CRLF);
			if (headerEnd < 0) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return; // incomplete frame
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			try {
				this.handleMessage(JSON.parse(body) as RpcMessage);
			} catch {
				// skip malformed message
			}
		}
	}

	private handleMessage(message: RpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				// server -> client request
				const handler = this.requestHandlers.get(message.method);
				Promise.resolve(handler ? handler(message.params) : null)
					.catch(() => null)
					.then((result) => {
						void this.write({ jsonrpc: "2.0", id: message.id, result: result ?? null });
					});
			} else {
				this.notificationHandlers.get(message.method)?.(message.params);
			}
			return;
		}
		if (message.id !== undefined) {
			const id = typeof message.id === "number" ? message.id : Number(message.id);
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (message.error) pending.reject(new Error(`RPC ${message.error.code}: ${message.error.message}`));
			else pending.resolve(message.result);
		}
	}

	private write(payload: Record<string, unknown>): Promise<void> {
		return new Promise((resolve) => {
			if (this.closed || !this.output.writable) return resolve();
			const json = JSON.stringify(payload);
			this.output.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`, () => resolve());
		});
	}

	sendRequest<T>(method: string, params?: unknown): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (this.closed) return reject(new Error("connection closed"));
			const id = this.nextId++;
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			void this.write({ jsonrpc: "2.0", id, method, params: params ?? null }).catch((e) => {
				this.pending.delete(id);
				reject(e as Error);
			});
		});
	}

	async sendNotification(method: string, params?: unknown): Promise<void> {
		await this.write({ jsonrpc: "2.0", method, params: params ?? null });
	}

	onNotification(method: string, handler: NotificationHandler): void {
		this.notificationHandlers.set(method, handler);
	}

	onRequest(method: string, handler: RequestHandler): void {
		this.requestHandlers.set(method, handler);
	}

	private failAll(reason: string): void {
		for (const { reject } of this.pending.values()) reject(new Error(reason));
		this.pending.clear();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.failAll("disposed");
		this.input.removeAllListeners("data");
	}
}
