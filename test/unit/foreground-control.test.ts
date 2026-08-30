import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentProgress, ForegroundRunControl } from "../../src/shared/types.ts";
import {
	beginForegroundChild,
	finishForegroundChild,
	foregroundSchedulingSettled,
	retainForegroundSchedulingOwner,
	settleForegroundSchedulingOwner,
	updateForegroundChild,
} from "../../src/runs/foreground/foreground-control.ts";
import { getLivePromptAudit, updateLiveEffectivePrompt } from "../../src/runs/foreground/prompt-audit.ts";
import { readPersistedPromptAudits } from "../../src/runs/shared/prompt-audit-store.ts";

function progress(index: number, agent: string, tokens: number): AgentProgress {
	return {
		index,
		agent,
		sessionName: `  ${agent}: named task  `,
		status: "running",
		task: `${agent} task`,
		recentTools: [],
		recentOutput: [],
		toolCount: index + 1,
		tokens,
		model: "openai/gpt-5.6-terra:high",
		thinking: "high",
		inputTokens: tokens - 20,
		outputTokens: 20,
		window: 75,
		windowPeak: 90,
		durationMs: 10,
	};
}

describe("foreground child control", () => {
	it("tracks concurrent children independently and promotes the latest active child", () => {
		const control: ForegroundRunControl = {
			runId: "parallel-run",
			mode: "parallel",
			startedAt: 1,
			updatedAt: 1,
			activeChildren: new Map(),
		};
		let firstInterrupts = 0;
		let secondInterrupts = 0;
		let firstDetaches = 0;
		beginForegroundChild(control, {
			index: 0,
			agent: "reviewer",
			authoredTask: "review",
			effectivePrompt: "review",
			description: "Review correctness",
			interrupt: () => { firstInterrupts++; return true; },
			detach: () => { firstDetaches++; return true; },
		});
		beginForegroundChild(control, {
			index: 1,
			agent: "reviewer",
			authoredTask: "review next",
			effectivePrompt: "review next",
			description: "Review quality",
			rerun: { params: { agent: "reviewer", task: "review next" } },
			interrupt: () => { secondInterrupts++; return true; },
		});

		assert.equal(control.activeChildren?.size, 2);
		assert.equal(getLivePromptAudit(control, 1)?.authoredTask, "review next");
		assert.deepEqual(getLivePromptAudit(control, 1)?.rerun?.params, { agent: "reviewer", task: "review next" });
		assert.doesNotMatch(JSON.stringify(control), /review next/);
		assert.equal(control.currentIndex, 1);
		updateForegroundChild(control, 0, progress(0, "reviewer", 120));
		assert.equal(control.currentIndex, 0);
		assert.equal(control.sessionName, "  reviewer: named task  ");
		assert.equal(control.activeChildren?.get(0)?.sessionName, "  reviewer: named task  ");
		assert.equal(control.tokens, 120);
		assert.equal(control.inputTokens, 100);
		assert.equal(control.outputTokens, 20);
		assert.equal(control.window, 75);
		assert.equal(control.windowPeak, 90);
		assert.equal(control.model, "openai/gpt-5.6-terra:high");
		assert.equal(control.thinking, "high");
		assert.equal(control.activeChildren?.get(1)?.tokens, undefined);
		assert.equal(control.interrupt?.(), true);
		assert.equal(firstInterrupts, 1);
		assert.equal(secondInterrupts, 0);
		assert.equal(control.detach?.(), true);
		assert.equal(firstDetaches, 1);

		updateForegroundChild(control, 1, progress(1, "reviewer", 240));
		finishForegroundChild(control, 1);
		assert.equal(getLivePromptAudit(control, 1), undefined);
		assert.equal(control.currentIndex, 0);
		assert.equal(control.tokens, 120);
		assert.deepEqual([...control.activeChildren!.keys()], [0]);

		finishForegroundChild(control, 0);
		assert.equal(control.activeChildren?.size, 0);
		assert.equal(control.currentIndex, undefined);
		assert.equal(control.sessionName, undefined);
		assert.equal(control.model, undefined);
		assert.equal(control.inputTokens, undefined);
		assert.equal(control.outputTokens, undefined);
		assert.equal(control.window, undefined);
		assert.equal(control.windowPeak, undefined);
		assert.equal(control.interrupt, undefined);
		assert.equal(control.detach, undefined);
	});

	it("persists workflow-owned foreground prompts in the parent async run", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-prompt-audit-"));
		try {
			const asyncDir = path.join(root, "workflow-parent");
			const control: ForegroundRunControl = {
				runId: "child-run",
				parentWorkflowRunId: "workflow-parent",
				workflowKey: "review",
				workflowSteeringDir: path.join(asyncDir, "control", "workflow-foreground", "child-run"),
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				activeChildren: new Map(),
			};
			beginForegroundChild(control, {
				index: 0,
				agent: "reviewer",
				authoredTask: "Review the implementation",
				effectivePrompt: "Review the implementation",
				model: "openai/gpt-test",
				interrupt: () => true,
			});
			updateLiveEffectivePrompt(control, 0, "Review the implementation\n\nReturn findings only");
			finishForegroundChild(control, 0);

			const records = readPersistedPromptAudits(asyncDir);
			assert.equal(records.length, 1);
			assert.equal(records[0]?.runId, "child-run");
			assert.equal(records[0]?.parentWorkflowRunId, "workflow-parent");
			assert.equal(records[0]?.workflowKey, "review");
			assert.equal(records[0]?.runtimeAdditions, "Return findings only");
			assert.equal(records[0]?.finalEffectivePrompt, "Review the implementation\n\nReturn findings only");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("settles scheduling only after every owner releases", () => {
		const control: ForegroundRunControl = {
			runId: "owned-run",
			mode: "parallel",
			startedAt: 1,
			updatedAt: 1,
			schedulingOwners: 1,
		};

		retainForegroundSchedulingOwner(control);
		settleForegroundSchedulingOwner(control);
		assert.equal(foregroundSchedulingSettled(control), false);
		settleForegroundSchedulingOwner(control);
		assert.equal(foregroundSchedulingSettled(control), true);
		assert.equal(control.schedulingOwners, 0);
	});
});
