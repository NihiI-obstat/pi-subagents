import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	promptAuditRuntimeAdditions,
	readPersistedPromptAudits,
	writePersistedPromptAudit,
} from "../../src/runs/shared/prompt-audit-store.ts";

describe("persisted Prompt Audit", () => {
	it("stores private authored, runtime, and effective prompt views", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-audit-"));
		try {
			const effective = "[Read from: context.md]\n\nReview the patch\n\nWrite to report.md";
			writePersistedPromptAudit(root, {
				id: "run-1:0",
				runId: "run-1",
				index: 0,
				agent: "reviewer",
				authoredTask: "Review the patch",
				finalEffectivePrompt: effective,
				cwd: "/workspace/project",
				model: "openai/gpt-test",
				startedAt: 10,
				updatedAt: 20,
			});

			const records = readPersistedPromptAudits(root);
			assert.equal(records.length, 1);
			assert.equal(records[0]?.authoredTask, "Review the patch");
			assert.equal(records[0]?.runtimeAdditions, "[Read from: context.md]\n\nWrite to report.md");
			assert.equal(records[0]?.finalEffectivePrompt, effective);
			const files = fs.readdirSync(path.join(root, "prompt-audit"));
			assert.equal(files.length, 1);
			if (process.platform !== "win32") {
				assert.equal(fs.statSync(path.join(root, "prompt-audit", files[0]!)).mode & 0o777, 0o600);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("updates a stable record and ignores malformed files", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-audit-update-"));
		try {
			const base = {
				id: "run-2:0",
				runId: "run-2",
				index: 0,
				agent: "worker",
				authoredTask: "Implement it",
				startedAt: 10,
			};
			writePersistedPromptAudit(root, { ...base, finalEffectivePrompt: "Implement it" });
			writePersistedPromptAudit(root, { ...base, finalEffectivePrompt: "Implement it\n\nAcceptance checks" });
			fs.writeFileSync(path.join(root, "prompt-audit", "malformed.json"), "{bad", "utf-8");

			const records = readPersistedPromptAudits(root);
			assert.equal(records.length, 1);
			assert.equal(records[0]?.finalEffectivePrompt, "Implement it\n\nAcceptance checks");
			assert.equal(records[0]?.runtimeAdditions, "Acceptance checks");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports unavailable additions when runtime replacement removes the authored task", () => {
		assert.equal(promptAuditRuntimeAdditions("{previous}", "Resolved predecessor output"), "(runtime additions unavailable)");
	});
});
