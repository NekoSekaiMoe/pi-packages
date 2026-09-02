/**
 * Minimal LSP types + method names (subset actually used),
 * inlined so this package has zero runtime dependencies.
 */

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface Diagnostic {
	range: Range;
	severity?: number; // 1 Error, 2 Warning, 3 Information, 4 Hint
	code?: number | string;
	source?: string;
	message: string;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number; // 6 Variable, 12 Function, 13 Method
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
	containerName?: string | null;
}

export interface CallHierarchyItem {
	name: string;
	kind?: number;
	detail?: string;
	uri: string;
	range: Range;
	selectionRange: Range;
}

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: Array<{
		kind?: string;
		textDocument?: { uri: string; version?: number };
		edits?: TextEdit[];
		uri?: string;
		oldUri?: string;
	}>;
}

export const Methods = {
	initialize: "initialize",
	initialized: "initialized",
	shutdown: "shutdown",
	exit: "exit",
	didOpen: "textDocument/didOpen",
	didChange: "textDocument/didChange",
	didSave: "textDocument/didSave",
	didChangeConfig: "workspace/didChangeConfiguration",
	publishDiagnostics: "textDocument/publishDiagnostics",
	references: "textDocument/references",
	prepareCallHierarchy: "textDocument/prepareCallHierarchy",
	incomingCalls: "callHierarchy/incomingCalls",
	outgoingCalls: "callHierarchy/outgoingCalls",
	rename: "textDocument/rename",
	documentSymbol: "textDocument/documentSymbol",
} as const;
