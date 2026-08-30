import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InspectorTranscriptProjection } from "../../src/inspectors/herdr/transcript-projection.ts";

function line(value: unknown): string {
	return JSON.stringify(value);
}

describe("Herdr transcript projection", () => {
	it("reconstructs a streaming assistant message and tool execution", () => {
		const projection = new InspectorTranscriptProjection();
		projection.consumeLine(line({ recordType: "message_start", message: { role: "assistant", content: [], model: "gpt-test" } }));
		projection.consumeLine(line({ recordType: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }));
		projection.consumeLine(line({ recordType: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Working" } }));
		projection.consumeLine(line({ recordType: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" } }));
		projection.consumeLine(line({ recordType: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"command\":\"pwd\"}" } }));
		projection.consumeLine(line({ recordType: "tool_start", toolCallId: "call-1", toolName: "bash", argsPayload: "{\"command\":\"pwd\"}" }));
		projection.consumeLine(line({ recordType: "tool_update", toolCallId: "call-1", toolName: "bash", partialResult: "{\"content\":[{\"type\":\"text\",\"text\":\"/repo\"}]}" }));

		const snapshot = projection.snapshot();
		assert.equal(snapshot.pendingAssistantIndex, 0);
		assert.deepEqual(snapshot.messages[0]!.content, [
			{ type: "text", text: "Working" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
		]);
		assert.equal(snapshot.tools.get("call-1")?.started, true);
		assert.equal(snapshot.tools.get("call-1")?.partialResult?.content[0]?.text, "/repo");
	});

	it("replaces the streaming message with the final message and attaches its result", () => {
		const projection = new InspectorTranscriptProjection();
		projection.consumeLine(line({ recordType: "message_start", message: { role: "assistant", content: [] } }));
		projection.consumeLine(line({ recordType: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } }));
		projection.consumeLine(line({ recordType: "message", role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "final" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }], model: "gpt-test", stopReason: "toolUse" } }));
		projection.consumeLine(line({ recordType: "message", role: "toolResult", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "source" }], isError: false } }));

		const snapshot = projection.snapshot();
		assert.equal(snapshot.pendingAssistantIndex, undefined);
		assert.equal((snapshot.messages[0]!.content as Array<{ text?: string }>)[0]?.text, "final");
		assert.equal(snapshot.tools.get("call-1")?.argsComplete, true);
		assert.equal(snapshot.tools.get("call-1")?.result?.content[0]?.text, "source");
	});

	it("reads native Pi session messages and raw process output", () => {
		const projection = new InspectorTranscriptProjection();
		assert.equal(projection.consumeLine(line({ type: "session", id: "s" })), false);
		assert.equal(projection.consumeLine(line({ type: "message", message: { role: "user", content: "hello", timestamp: 1 } })), true);
		assert.equal(projection.consumeLine(line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "gpt-test", stopReason: "stop", timestamp: 2 } })), true);
		assert.equal(projection.consumeLine(line({ recordType: "stdout", text: "external progress" })), true);
		assert.equal(projection.consumeLine(line({ recordType: "stderr", text: "external warning" })), true);
		const snapshot = projection.snapshot();
		assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
		assert.deepEqual(snapshot.notices, [
			{ tone: "muted", text: "external progress" },
			{ tone: "error", text: "external warning" },
		]);
	});
});
