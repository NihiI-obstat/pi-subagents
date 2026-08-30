import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SubagentChildStatusEvent, SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { deliverStopRequest } from "../background/control-channel.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { isStoppableAsyncStatusStep, resolveAsyncStatusChild, type ResolvedAsyncStatusChild } from "../shared/child-identity.ts";

function getAsyncStopTarget(
	state: SubagentState,
	runId: string | undefined,
	location?: { asyncDir: string | null; resolvedId?: string },
): { asyncId: string; asyncDir: string } | undefined {
	if (location?.asyncDir) {
		return {
			asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
			asyncDir: location.asyncDir,
		};
	}
	if (!runId) return undefined;
	const direct = state.asyncJobs.get(runId);
	return direct ? { asyncId: direct.asyncId, asyncDir: direct.asyncDir } : undefined;
}

function touchTrackedRun(state: SubagentState, ...runIds: string[]): void {
	for (const jobs of [state.asyncJobs, state.fleetJobs]) {
		if (!jobs) continue;
		for (const runId of runIds) {
			const tracked = jobs.get(runId);
			if (!tracked) continue;
			tracked.activityState = undefined;
			tracked.updatedAt = Date.now();
		}
	}
}

function appendWorkflowChildStoppingEvent(asyncDir: string, workflowRunId: string, child: ResolvedAsyncStatusChild): void {
	try {
		fs.appendFileSync(path.join(asyncDir, "events.jsonl"), `${JSON.stringify({
			type: "subagent.child-status",
			version: 1,
			runId: workflowRunId,
			childId: child.id,
			status: "stopping",
			ts: Date.now(),
			reason: "subagent-action",
			source: "async",
			stepIndex: child.index,
			agent: child.step.agent,
			...(child.step.runId ? { childRunId: child.step.runId } : {}),
			...(child.step.workflowKey ? { workflowKey: child.step.workflowKey } : {}),
			...(child.step.phase ? { phase: child.step.phase } : {}),
			...(child.step.label ? { label: child.step.label } : {}),
		} satisfies SubagentChildStatusEvent)}\n`, "utf-8");
	} catch (error) {
		console.error(`Failed to append child status event for workflow ${workflowRunId}:`, error);
	}
}

function stopLiveWorkflow(
	state: SubagentState,
	target: { asyncId: string; asyncDir: string },
	childId?: string,
): AgentToolResult<Details> | null {
	const status = readStatus(target.asyncDir);
	const workflowRunId = [status?.runId, target.asyncId]
		.find((candidate): candidate is string => Boolean(candidate && state.workflowControllers?.has(candidate)));
	if (!workflowRunId) return null;
	const controller = state.workflowControllers?.get(workflowRunId);
	if (!controller) return null;
	if (childId === undefined) {
		controller.abort(new Error("Workflow stopped."));
		touchTrackedRun(state, workflowRunId, target.asyncId);
		return {
			content: [{ type: "text", text: `Stop requested for async workflow ${workflowRunId}.` }],
			details: { mode: "management", results: [] },
		};
	}
	if (!status) {
		return {
			content: [{ type: "text", text: `Status file not found for async workflow '${workflowRunId}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (state.currentSessionId && status.sessionId !== state.currentSessionId) {
		return {
			content: [{ type: "text", text: `Async run '${workflowRunId}' was not found in the active session.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const resolution = resolveAsyncStatusChild(status, childId);
	if (!resolution.ok) {
		return {
			content: [{ type: "text", text: resolution.message }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!isStoppableAsyncStatusStep(resolution.child.step)) {
		return {
			content: [{ type: "text", text: `Child '${childId}' in async run '${workflowRunId}' is ${resolution.child.step.status}; stop only supports pending or running children.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	const stopChild = state.workflowChildStops?.get(workflowRunId);
	if (!stopChild) {
		return {
			content: [{ type: "text", text: `Workflow ${workflowRunId} child stop is unavailable in this extension runtime.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!stopChild(resolution.child.id, `Workflow child '${resolution.child.id}' stopped.`)) {
		return {
			content: [{ type: "text", text: `Child '${childId}' in workflow ${workflowRunId} is not available to stop.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	appendWorkflowChildStoppingEvent(target.asyncDir, workflowRunId, resolution.child);
	touchTrackedRun(state, workflowRunId, target.asyncId);
	return {
		content: [{ type: "text", text: `Stop requested for child ${resolution.child.id} in async workflow ${workflowRunId}.` }],
		details: { mode: "management", results: [] },
	};
}

export function stopAsyncRun(
	state: SubagentState,
	runId: string | undefined,
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean,
	location?: { asyncDir: string | null; resolvedId?: string },
	childId?: string,
): AgentToolResult<Details> | null {
	const target = getAsyncStopTarget(state, runId, location);
	if (!target) return null;
	const liveWorkflowResult = stopLiveWorkflow(state, target, childId);
	if (liveWorkflowResult) return liveWorkflowResult;
	const status = reconcileAsyncRun(target.asyncDir, { kill }).status;
	if (state.currentSessionId && status?.sessionId !== state.currentSessionId) {
		return {
			content: [{ type: "text", text: `Async run '${target.asyncId}' was not found in the active session.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		return {
			content: [{ type: "text", text: `No running or queued async run was found for '${runId ?? "current"}'.` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
	let child: ResolvedAsyncStatusChild | undefined;
	if (childId !== undefined) {
		const resolution = resolveAsyncStatusChild(status, childId);
		if (!resolution.ok) {
			return {
				content: [{ type: "text", text: resolution.message }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		child = resolution.child;
		if (!isStoppableAsyncStatusStep(child.step)) {
			return {
				content: [{ type: "text", text: `Child '${childId}' in async run '${status.runId}' is ${child.step.status}; stop only supports pending or running children.` }],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
	}
	try {
		deliverStopRequest({ asyncDir: target.asyncDir, pid: typeof status.pid === "number" ? status.pid : undefined, kill, source: "stop-action", targetIndex: child?.index, childId: child?.id ?? childId });
		touchTrackedRun(state, target.asyncId, status.runId);
		return {
			content: [{ type: "text", text: child ? `Stop requested for child ${child.id} in async run ${target.asyncId}.` : `Stop requested for async run ${target.asyncId}.` }],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to stop async run ${target.asyncId}: ${message}` }],
			isError: true,
			details: { mode: "management", results: [] },
		};
	}
}
