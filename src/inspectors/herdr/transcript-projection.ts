type JsonObject = Record<string, unknown>;

export interface InspectorToolState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	started: boolean;
	argsComplete: boolean;
	partialResult?: { content: Array<Record<string, unknown>>; details?: unknown; isError: boolean };
	result?: { content: Array<Record<string, unknown>>; details?: unknown; isError: boolean };
}

export interface InspectorTranscriptSnapshot {
	messages: JsonObject[];
	pendingAssistantIndex?: number;
	tools: Map<string, InspectorToolState>;
	notices: Array<{ tone: "muted" | "error"; text: string }>;
}

function objectValue(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function emptyUsage(): JsonObject {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function normalizeContent(content: unknown): unknown[] {
	if (Array.isArray(content)) return content.map((entry) => objectValue(entry) ?? entry);
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

function normalizeMessage(value: unknown, timestamp = Date.now()): JsonObject | undefined {
	const message = objectValue(value);
	const role = stringValue(message?.role);
	if (!message || !role) return undefined;
	if (role === "assistant") {
		return {
			...message,
			role,
			content: normalizeContent(message.content),
			api: stringValue(message.api) ?? "unknown",
			provider: stringValue(message.provider) ?? "unknown",
			model: stringValue(message.model) ?? "unknown",
			usage: objectValue(message.usage) ?? emptyUsage(),
			stopReason: stringValue(message.stopReason) ?? "pending",
			timestamp: typeof message.timestamp === "number" ? message.timestamp : timestamp,
		};
	}
	if (role === "user") {
		return {
			...message,
			role,
			content: typeof message.content === "string" ? message.content : normalizeContent(message.content),
			timestamp: typeof message.timestamp === "number" ? message.timestamp : timestamp,
		};
	}
	if (role === "toolResult" || role === "tool_result") {
		return {
			...message,
			role: "toolResult",
			toolCallId: stringValue(message.toolCallId) ?? "unknown-tool-call",
			toolName: stringValue(message.toolName) ?? "tool",
			content: normalizeContent(message.content),
			isError: message.isError === true,
			timestamp: typeof message.timestamp === "number" ? message.timestamp : timestamp,
		};
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((entry) => {
		const block = objectValue(entry);
		return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

function messageKey(message: JsonObject): string {
	const role = stringValue(message.role) ?? "unknown";
	if (role === "toolResult") return `${role}\0${stringValue(message.toolCallId) ?? ""}\0${textFromContent(message.content)}`;
	return `${role}\0${textFromContent(message.content)}\0${JSON.stringify(normalizeContent(message.content).filter((entry) => objectValue(entry)?.type === "toolCall"))}`;
}

function parsePayload(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try { return JSON.parse(value); } catch { return value; }
}

function normalizeToolResult(value: unknown, isError = false): InspectorToolState["result"] | undefined {
	const parsed = parsePayload(value);
	const result = objectValue(parsed);
	if (!result) return undefined;
	const content = Array.isArray(result.content)
		? result.content.map((entry) => objectValue(entry) ?? { type: "text", text: String(entry) }) as Array<Record<string, unknown>>
		: typeof result.content === "string"
			? [{ type: "text", text: result.content }]
			: [];
	return { content, ...(result.details !== undefined ? { details: result.details } : {}), isError: result.isError === true || isError };
}

function ensureContentIndex(content: unknown[], index: number, block: JsonObject): JsonObject {
	while (content.length <= index) content.push({ type: "text", text: "" });
	const current = objectValue(content[index]);
	if (!current || current.type !== block.type) content[index] = block;
	return objectValue(content[index])!;
}

export class InspectorTranscriptProjection {
	private readonly messages: JsonObject[] = [];
	private pendingAssistantIndex: number | undefined;
	private readonly tools = new Map<string, InspectorToolState>();
	private readonly notices: Array<{ tone: "muted" | "error"; text: string }> = [];
	private readonly toolArgumentBuffers = new Map<number, string>();

	reset(): void {
		this.messages.length = 0;
		this.pendingAssistantIndex = undefined;
		this.tools.clear();
		this.notices.length = 0;
		this.toolArgumentBuffers.clear();
	}

	snapshot(): InspectorTranscriptSnapshot {
		return {
			messages: this.messages,
			...(this.pendingAssistantIndex !== undefined ? { pendingAssistantIndex: this.pendingAssistantIndex } : {}),
			tools: this.tools,
			notices: this.notices,
		};
	}

	consumeLine(line: string): boolean {
		let record: JsonObject | undefined;
		try { record = objectValue(JSON.parse(line)); } catch { return false; }
		if (!record) return false;
		const recordType = stringValue(record.recordType);
		if (recordType) return this.consumeArtifactRecord(recordType, record);
		if (record.type === "message") return this.appendFinalMessage(objectValue(record.message));
		if (typeof record.role === "string") return this.appendFinalMessage(record);
		return false;
	}

	private appendFinalMessage(value: unknown): boolean {
		const message = normalizeMessage(value);
		if (!message) return false;
		if (message.role === "assistant" && this.pendingAssistantIndex !== undefined) {
			this.messages[this.pendingAssistantIndex] = message;
			this.pendingAssistantIndex = undefined;
			this.indexAssistantTools(message, true);
			return true;
		}
		const key = messageKey(message);
		if (this.messages.some((candidate) => messageKey(candidate) === key)) return false;
		this.messages.push(message);
		if (message.role === "assistant") this.indexAssistantTools(message, true);
		if (message.role === "toolResult") this.applyToolResultMessage(message);
		return true;
	}

	private consumeArtifactRecord(recordType: string, record: JsonObject): boolean {
		if (recordType === "message_start") {
			const message = normalizeMessage(record.message, typeof record.ts === "number" ? record.ts : Date.now());
			if (!message || message.role !== "assistant") return false;
			if (this.pendingAssistantIndex === undefined) {
				this.pendingAssistantIndex = this.messages.length;
				this.messages.push(message);
			} else this.messages[this.pendingAssistantIndex] = message;
			return true;
		}
		if (recordType === "message_update") return this.applyAssistantUpdate(objectValue(record.assistantMessageEvent));
		if (recordType === "message") return this.appendFinalMessage(record.message ?? {
			role: record.role,
			content: typeof record.text === "string" ? [{ type: "text", text: record.text }] : [],
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			isError: record.isError,
			model: record.model,
			timestamp: record.ts,
		});
		if (recordType === "tool_start") {
			const id = stringValue(record.toolCallId) ?? `tool-${this.tools.size + 1}`;
			const name = stringValue(record.toolName) ?? "tool";
			const args = objectValue(parsePayload(record.argsPayload)) ?? {};
			const current = this.tools.get(id);
			this.tools.set(id, { toolCallId: id, toolName: name, args, started: true, argsComplete: current?.argsComplete ?? false, ...(current?.partialResult ? { partialResult: current.partialResult } : {}), ...(current?.result ? { result: current.result } : {}) });
			this.ensureLatestAssistantToolCall(id, name, args);
			return true;
		}
		if (recordType === "tool_update") {
			const id = stringValue(record.toolCallId);
			if (!id) return false;
			const current = this.tools.get(id) ?? { toolCallId: id, toolName: stringValue(record.toolName) ?? "tool", args: {}, started: true, argsComplete: false };
			const partialResult = normalizeToolResult(record.partialResult);
			this.tools.set(id, { ...current, ...(partialResult ? { partialResult } : {}) });
			return true;
		}
		if (recordType === "tool_end") {
			const id = stringValue(record.toolCallId);
			if (!id) return false;
			const current = this.tools.get(id) ?? { toolCallId: id, toolName: stringValue(record.toolName) ?? "tool", args: {}, started: true, argsComplete: true };
			this.tools.set(id, { ...current, argsComplete: true, ...(record.isError === true && !current.result ? { result: { content: [], isError: true } } : {}) });
			return true;
		}
		if (recordType === "stdout" && typeof record.text === "string") {
			this.notices.push({ tone: "muted", text: record.text });
			return true;
		}
		if (recordType === "stderr" && typeof record.text === "string") {
			this.notices.push({ tone: "error", text: record.text });
			return true;
		}
		if (recordType === "truncated") {
			this.notices.push({ tone: "muted", text: stringValue(record.message) ?? "Transcript was truncated." });
			return true;
		}
		return false;
	}

	private ensurePendingAssistant(): JsonObject {
		if (this.pendingAssistantIndex === undefined) {
			this.pendingAssistantIndex = this.messages.length;
			this.messages.push(normalizeMessage({ role: "assistant", content: [] })!);
		}
		return this.messages[this.pendingAssistantIndex]!;
	}

	private applyAssistantUpdate(event: JsonObject | undefined): boolean {
		if (!event) return false;
		const type = stringValue(event.type);
		if (!type) return false;
		const message = this.ensurePendingAssistant();
		const content = normalizeContent(message.content);
		message.content = content;
		const index = typeof event.contentIndex === "number" && Number.isInteger(event.contentIndex) ? event.contentIndex : 0;
		if (type === "text_start") ensureContentIndex(content, index, { type: "text", text: "" });
		else if (type === "text_delta") {
			const block = ensureContentIndex(content, index, { type: "text", text: "" });
			block.text = `${stringValue(block.text) ?? ""}${stringValue(event.delta) ?? ""}`;
		} else if (type === "text_end") ensureContentIndex(content, index, { type: "text", text: "" }).text = stringValue(event.content) ?? "";
		else if (type === "thinking_start") ensureContentIndex(content, index, { type: "thinking", thinking: "" });
		else if (type === "thinking_delta") {
			const block = ensureContentIndex(content, index, { type: "thinking", thinking: "" });
			block.thinking = `${stringValue(block.thinking) ?? ""}${stringValue(event.delta) ?? ""}`;
		} else if (type === "thinking_end") ensureContentIndex(content, index, { type: "thinking", thinking: "" }).thinking = stringValue(event.content) ?? "";
		else if (type === "toolcall_start") {
			const id = stringValue(event.id) ?? `tool-${index}`;
			const name = stringValue(event.toolName) ?? "tool";
			ensureContentIndex(content, index, { type: "toolCall", id, name, arguments: {} });
			this.toolArgumentBuffers.set(index, "");
			this.tools.set(id, { toolCallId: id, toolName: name, args: {}, started: false, argsComplete: false });
		} else if (type === "toolcall_delta") {
			const block = ensureContentIndex(content, index, { type: "toolCall", id: `tool-${index}`, name: "tool", arguments: {} });
			const buffer = `${this.toolArgumentBuffers.get(index) ?? ""}${stringValue(event.delta) ?? ""}`;
			this.toolArgumentBuffers.set(index, buffer);
			try { block.arguments = JSON.parse(buffer); } catch { /* incomplete JSON is expected */ }
			const id = stringValue(block.id) ?? `tool-${index}`;
			const state = this.tools.get(id);
			if (state) state.args = objectValue(block.arguments) ?? state.args;
		} else if (type === "toolcall_end") {
			const toolCall = objectValue(event.toolCall);
			if (toolCall) {
				content[index] = toolCall;
				const id = stringValue(toolCall.id) ?? `tool-${index}`;
				const name = stringValue(toolCall.name) ?? "tool";
				const args = objectValue(toolCall.arguments) ?? {};
				this.tools.set(id, { ...(this.tools.get(id) ?? {}), toolCallId: id, toolName: name, args, started: this.tools.get(id)?.started ?? false, argsComplete: true });
			}
		} else if ((type === "done" || type === "error") && (event.message || event.error)) {
			return this.appendFinalMessage(event.message ?? event.error);
		} else return type === "start";
		return true;
	}

	private indexAssistantTools(message: JsonObject, argsComplete: boolean): void {
		for (const entry of normalizeContent(message.content)) {
			const block = objectValue(entry);
			if (block?.type !== "toolCall") continue;
			const id = stringValue(block.id) ?? `tool-${this.tools.size + 1}`;
			const name = stringValue(block.name) ?? "tool";
			const args = objectValue(block.arguments) ?? {};
			const current = this.tools.get(id);
			this.tools.set(id, { toolCallId: id, toolName: name, args, started: current?.started ?? false, argsComplete, ...(current?.partialResult ? { partialResult: current.partialResult } : {}), ...(current?.result ? { result: current.result } : {}) });
		}
	}

	private ensureLatestAssistantToolCall(id: string, name: string, args: Record<string, unknown>): void {
		for (let index = this.messages.length - 1; index >= 0; index--) {
			const message = this.messages[index]!;
			if (message.role !== "assistant") continue;
			const content = normalizeContent(message.content);
			message.content = content;
			if (!content.some((entry) => objectValue(entry)?.type === "toolCall" && objectValue(entry)?.id === id)) content.push({ type: "toolCall", id, name, arguments: args });
			return;
		}
	}

	private applyToolResultMessage(message: JsonObject): void {
		const id = stringValue(message.toolCallId);
		if (!id) return;
		const current = this.tools.get(id) ?? { toolCallId: id, toolName: stringValue(message.toolName) ?? "tool", args: {}, started: true, argsComplete: true };
		this.tools.set(id, {
			...current,
			result: {
				content: normalizeContent(message.content).map((entry) => objectValue(entry) ?? { type: "text", text: String(entry) }) as Array<Record<string, unknown>>,
				...(message.details !== undefined ? { details: message.details } : {}),
				isError: message.isError === true,
			},
		});
	}
}
