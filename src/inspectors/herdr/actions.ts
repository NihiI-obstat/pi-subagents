import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { readMissionBinding } from "../../missions/lifecycle.ts";
import { listMissions, missionRecordPath, resolveMissionStoreLocation } from "../../missions/store.ts";
import type { MissionStoreConfig } from "../../missions/types.ts";
import { resolveAuthorityDecision, type AuthorityPolicyConfig } from "../../policy/authority.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { DIRS, type AsyncStatus, type Details, type SubagentState } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { resolveSubagentRunId } from "../../runs/background/run-id-resolver.ts";
import { resolveNodeExecutable } from "../../shared/node-executable.ts";
import { resolvePiPackageRoot } from "../../runs/shared/pi-spawn.ts";
import { createHerdrClient, detectHerdr, type HerdrClient, type HerdrErrorCode, type HerdrResult } from "./client.ts";
import { encodeSessionRoots } from "./session-roots-codec.ts";
import { formatShellCommand } from "./shell-command.ts";

export const HERDR_INSPECTOR_ACTIONS = ["inspector.open", "inspector.status", "inspector.close"] as const;
export type HerdrInspectorAction = typeof HERDR_INSPECTOR_ACTIONS[number];

export interface HerdrInspectorBinding {
	schemaVersion: 1;
	kind: "herdr-inspector";
	runId: string;
	asyncDir: string;
	childIndex?: number;
	missionId?: string;
	missionPath?: string;
	paneId: string;
	openedAt: string;
	lastFocusedAt?: string;
	herdrVersion?: string;
	command: string;
}

interface InspectorParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	focus?: boolean;
}

interface InspectorDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	client?: HerdrClient;
	missions?: MissionStoreConfig;
	authorityPolicy?: AuthorityPolicyConfig;
	sessionRoots?: string[];
	cwd: string;
	signal?: AbortSignal;
	now?: () => Date;
	runnerPath?: string;
	piPackageRoot?: string;
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [] } };
}

function formatHerdrError(input: { code: HerdrErrorCode; message: string }): string {
	return `Herdr inspector error (${input.code}): ${input.message}`;
}

function bindingPath(asyncDir: string, index?: number): string {
	return path.join(asyncDir, "inspectors", `herdr${index === undefined ? "" : `-${index}`}.json`);
}

function parseBinding(value: unknown): HerdrInspectorBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<HerdrInspectorBinding>;
	if (input.schemaVersion !== 1 || input.kind !== "herdr-inspector") return undefined;
	if (typeof input.runId !== "string" || typeof input.asyncDir !== "string" || typeof input.paneId !== "string" || typeof input.openedAt !== "string" || typeof input.command !== "string") return undefined;
	if (input.childIndex !== undefined && (!Number.isInteger(input.childIndex) || input.childIndex < 0)) return undefined;
	return input as HerdrInspectorBinding;
}

export function readHerdrInspectorBinding(asyncDir: string, index?: number): HerdrInspectorBinding | undefined {
	try { return parseBinding(JSON.parse(fs.readFileSync(bindingPath(asyncDir, index), "utf-8"))); } catch { return undefined; }
}

function extractPaneId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const pane = record.pane && typeof record.pane === "object" && !Array.isArray(record.pane) ? record.pane as Record<string, unknown> : record;
	for (const key of ["pane_id", "paneId", "id"]) if (typeof pane[key] === "string") return pane[key];
	return undefined;
}

function inspectorCommand(input: {
	runnerPath: string;
	asyncDir: string;
	runId: string;
	index?: number;
	missionPath?: string;
	allowSteer: boolean;
	allowStop: boolean;
	sessionRoots: string[];
	transcriptRoots?: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
	transcriptPath?: string;
	sessionFile?: string;
	cwd?: string;
	agent?: string;
	lifecycle?: boolean;
	piPackageRoot?: string;
}): string {
	const args = [input.runnerPath, "--async-dir", input.asyncDir, "--run-id", input.runId, "--allow-steer", String(input.allowSteer), "--allow-stop", String(input.allowStop), "--session-roots", encodeSessionRoots(input.sessionRoots)];
	if (input.transcriptRoots?.length) args.push("--transcript-roots", encodeSessionRoots(input.transcriptRoots));
	if (input.trustedFiles?.length) args.push("--trusted-files", encodeSessionRoots(input.trustedFiles));
	if (input.trustedFileRoot) args.push("--trusted-file-root", input.trustedFileRoot);
	if (input.index !== undefined) args.push("--index", String(input.index));
	if (input.missionPath) args.push("--mission-path", input.missionPath);
	if (input.transcriptPath) args.push("--transcript-path", input.transcriptPath);
	if (input.sessionFile) args.push("--session-file", input.sessionFile);
	if (input.cwd) args.push("--cwd", input.cwd);
	if (input.agent) args.push("--agent", input.agent);
	if (input.lifecycle === false) args.push("--lifecycle", "false");
	if (input.piPackageRoot) args.push("--pi-package-root", input.piPackageRoot);
	return formatShellCommand(resolveNodeExecutable(), args);
}

function missionForRun(asyncDir: string, cwd: string, config: MissionStoreConfig | undefined, runId: string): { id: string; path: string } | undefined {
	try {
		const binding = readMissionBinding(asyncDir);
		if (binding) return { id: binding.missionId, path: missionRecordPath(binding.location, binding.missionId) };
		const location = resolveMissionStoreLocation({ projectRoot: cwd, ...(config ? { config } : {}) });
		const mission = listMissions(location).records.find((record) => record.runs.some((run) => run.runId === runId));
		return mission ? { id: mission.id, path: missionRecordPath(location, mission.id) } : undefined;
	} catch {
		return undefined;
	}
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function availablePaneCwd(preferred: string | undefined, fallback: string): string {
	for (const candidate of [preferred, fallback]) {
		if (!candidate) continue;
		try {
			if (fs.statSync(candidate).isDirectory()) return path.resolve(candidate);
		} catch {
			// Completed managed worktrees may already be removed; use the owner cwd.
		}
	}
	return path.resolve(fallback);
}

function herdrSessionRoots(target: { runId: string }, deps: InspectorDeps): string[] {
	const roots = deps.sessionRoots ?? deps.state?.trustedSessionRoots ?? [];
	const job = deps.state?.asyncJobs.get(target.runId) ?? deps.state?.fleetJobs?.get(target.runId);
	return [...new Set([...roots, ...(job?.sessionRoot ? [job.sessionRoot] : [])])];
}

function herdrTranscriptRoots(target: { runId: string; asyncDir: string }, status: AsyncStatus, deps: InspectorDeps): string[] {
	const job = deps.state?.asyncJobs.get(target.runId) ?? deps.state?.fleetJobs?.get(target.runId);
	const cwd = job?.cwd ?? status.cwd ?? deps.cwd;
	return [...new Set([
		path.resolve(target.asyncDir),
		...(deps.state ? [getArtifactsDir(deps.state.parentSessionFile ?? null, cwd, deps.state.artifactDirPreference)] : []),
	])];
}

function isTrustedAsyncDir(asyncDir: string, deps: InspectorDeps): boolean {
	try {
		if (fs.lstatSync(asyncDir).isSymbolicLink() || !fs.statSync(asyncDir).isDirectory()) return false;
		const realDir = fs.realpathSync(asyncDir);
		const registered = [...(deps.state?.asyncJobs.values() ?? [])].some((job) => {
			try { return fs.realpathSync(job.asyncDir) === realDir; } catch { return false; }
		});
		if (registered) return true;
		const root = deps.asyncDirRoot ?? DIRS.async;
		if (!fs.existsSync(root) || !pathWithin(root, asyncDir)) return false;
		return pathWithin(fs.realpathSync(root), realDir);
	} catch {
		return false;
	}
}

function resolveAsyncTarget(params: InspectorParams, deps: InspectorDeps): { runId: string; asyncDir: string } | { error: string } {
	const requestedId = params.id ?? params.runId;
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		if (!isTrustedAsyncDir(asyncDir, deps)) return { error: `Async run directory '${asyncDir}' is outside trusted run roots.` };
		const status = readStatus(asyncDir);
		if (!status) return { error: `No async run status found in '${asyncDir}'.` };
		if (requestedId && requestedId !== status.runId && !status.runId.startsWith(requestedId)) return { error: `Run '${requestedId}' does not match status run '${status.runId}'.` };
		return { runId: status.runId, asyncDir };
	}
	if (!requestedId) return { error: "Herdr inspector actions require id or dir." };
	try {
		const resolved = resolveSubagentRunId(requestedId, { state: deps.state, asyncDirRoot: deps.asyncDirRoot ?? DIRS.async, resultsDir: deps.resultsDir ?? DIRS.results });
		if (!resolved) return { error: `No subagent run found for '${requestedId}'.` };
		if (resolved.kind !== "async" || !resolved.location.asyncDir) return { error: `Run '${resolved.id}' is not an inspectable async run with lifecycle artifacts.` };
		return { runId: resolved.id, asyncDir: resolved.location.asyncDir };
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
}

async function paneExists(client: HerdrClient, paneId: string, signal?: AbortSignal): Promise<HerdrResult<unknown>> {
	return client.run(["pane", "get", paneId], { timeoutMs: 5_000, signal });
}

export interface HerdrTranscriptPaneTarget {
	runId: string;
	bindingDir: string;
	index?: number;
	agent: string;
	cwd: string;
	state: string;
	transcriptPath?: string;
	sessionFile?: string;
	trustedRoots: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
}

export async function handleHerdrInspectorAction(action: HerdrInspectorAction, params: InspectorParams, deps: InspectorDeps): Promise<AgentToolResult<Details>> {
	const target = resolveAsyncTarget(params, deps);
	if ("error" in target) return result(target.error, true);
	const status = readStatus(target.asyncDir);
	if (!status) return result(`No lifecycle status exists for async run '${target.runId}'.`, true);
	if (params.index !== undefined && (params.index < 0 || params.index >= (status.steps?.length ?? 0))) {
		return result(`Async run '${target.runId}' has ${status.steps?.length ?? 0} children. Index ${params.index} is out of range.`, true);
	}
	const existing = readHerdrInspectorBinding(target.asyncDir, params.index);
	const client = deps.client ?? createHerdrClient();

	if (action === "inspector.status") {
		if (!existing) return result(`No Herdr inspector binding exists for async run ${target.runId}${params.index === undefined ? "" : ` child ${params.index}`}.`);
		const live = await paneExists(client, existing.paneId, deps.signal);
		if (live.ok === false) return result(`${formatHerdrError(live.error)}\nBinding: ${bindingPath(target.asyncDir, params.index)}\nRun state remains authoritative: ${status.state}.`, true);
		return result(`Herdr inspector ${existing.paneId} is open for async run ${target.runId}.\nRun state: ${status.state}\nBinding: ${bindingPath(target.asyncDir, params.index)}`);
	}


	if (action === "inspector.close") {
		if (!existing) return result(`No Herdr inspector binding exists for async run ${target.runId}.`);
		const closed = await client.run(["pane", "close", existing.paneId], { timeoutMs: 10_000, signal: deps.signal });
		if (closed.ok === false && closed.error.code !== "NOT_FOUND" && closed.error.code !== "PANE_GONE") return result(formatHerdrError(closed.error), true);
		fs.rmSync(bindingPath(target.asyncDir, params.index), { force: true });
		return result(`Closed Herdr inspector pane ${existing.paneId} for async run ${target.runId}. The subagent run was not stopped.`);
	}

	const detected = await detectHerdr(client, deps.signal);
	if (detected.ok === false) return result(formatHerdrError(detected.error), true);
	if (existing) {
		const live = await paneExists(client, existing.paneId, deps.signal);
		if (live.ok) return result(`Herdr inspector pane ${existing.paneId} is already open for async run ${target.runId}.${params.focus ? " Herdr cannot refocus an arbitrary raw pane id; select it in the Herdr UI." : ""}`);
	}
	const paneCwd = availablePaneCwd(status.cwd, deps.cwd);
	const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", paneCwd];
	splitArgs.push(params.focus === true ? "--focus" : "--no-focus");
	const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: deps.signal });
	if (split.ok === false) return result(formatHerdrError(split.error), true);
	const paneId = extractPaneId(split.data);
	if (!paneId) return result("Herdr inspector error (PANE_GONE): pane split returned no pane id.", true);
	const mission = missionForRun(target.asyncDir, deps.cwd, deps.missions, target.runId);
	const runnerPath = deps.runnerPath ?? fileURLToPath(new URL("../../../inspector-runner.mjs", import.meta.url));
	const step = params.index !== undefined
		? status.steps?.[params.index]
		: status.steps?.length === 1 ? status.steps[0] : undefined;
	const command = inspectorCommand({
		runnerPath,
		asyncDir: target.asyncDir,
		runId: target.runId,
		index: params.index,
		missionPath: mission?.path,
		allowSteer: resolveAuthorityDecision({ action: "steerRun", policy: deps.authorityPolicy }) === "auto",
		allowStop: resolveAuthorityDecision({ action: "stopRun", policy: deps.authorityPolicy }) === "auto",
		sessionRoots: herdrSessionRoots(target, deps),
		transcriptRoots: herdrTranscriptRoots(target, status, deps),
		...(step?.transcriptPath ? { transcriptPath: step.transcriptPath } : {}),
		...(step?.sessionFile ? { sessionFile: step.sessionFile } : status.sessionFile ? { sessionFile: status.sessionFile } : {}),
		cwd: paneCwd,
		agent: step?.agent ?? (params.index === undefined ? status.mode : undefined),
		...(deps.state?.trustedSessionFileRoot ? { trustedFileRoot: deps.state.trustedSessionFileRoot } : {}),
		...(step?.sessionFile ? { trustedFiles: [step.sessionFile] } : status.sessionFile ? { trustedFiles: [status.sessionFile] } : {}),
		piPackageRoot: deps.piPackageRoot ?? resolvePiPackageRoot(),
	});
	const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: deps.signal });
	if (started.ok === false) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return result(formatHerdrError(started.error), true);
	}
	const now = (deps.now?.() ?? new Date()).toISOString();
	const binding: HerdrInspectorBinding = {
		schemaVersion: 1,
		kind: "herdr-inspector",
		runId: target.runId,
		asyncDir: target.asyncDir,
		...(params.index !== undefined ? { childIndex: params.index } : {}),
		...(mission ? { missionId: mission.id, missionPath: mission.path } : {}),
		paneId,
		openedAt: now,
		...(params.focus === true ? { lastFocusedAt: now } : {}),
		herdrVersion: detected.data.versionText,
		command,
	};
	writeAtomicJson(bindingPath(target.asyncDir, params.index), binding);
	return result(`Opened Pi-style Herdr transcript pane ${paneId} for async run ${target.runId}. Closing the pane does not stop the run.\nPane controls: scroll, search, expand tools, or close; run controls remain in Fleet.`);
}

export async function openHerdrTranscriptPane(target: HerdrTranscriptPaneTarget, deps: InspectorDeps): Promise<AgentToolResult<Details>> {
	if (!target.runId.trim()) return result("Herdr transcript pane requires a run id.", true);
	const resultsRoot = path.resolve(deps.resultsDir ?? DIRS.results);
	const bindingDir = path.resolve(target.bindingDir);
	if (!pathWithin(resultsRoot, bindingDir)) return result(`Herdr transcript binding directory '${bindingDir}' is outside trusted result roots.`, true);
	fs.mkdirSync(bindingDir, { recursive: true });
	const existing = readHerdrInspectorBinding(bindingDir, target.index);
	const client = deps.client ?? createHerdrClient();
	const detected = await detectHerdr(client, deps.signal);
	if (detected.ok === false) return result(formatHerdrError(detected.error), true);
	if (existing) {
		const live = await paneExists(client, existing.paneId, deps.signal);
		if (live.ok) return result(`Herdr transcript pane ${existing.paneId} is already open for ${target.agent}.`);
	}
	const paneCwd = availablePaneCwd(target.cwd, deps.cwd);
	const splitArgs = ["pane", "split", "--current", "--direction", "right", "--cwd", paneCwd, "--focus"];
	const split = await client.run(splitArgs, { timeoutMs: 15_000, signal: deps.signal });
	if (split.ok === false) return result(formatHerdrError(split.error), true);
	const paneId = extractPaneId(split.data);
	if (!paneId) return result("Herdr inspector error (PANE_GONE): pane split returned no pane id.", true);
	const runnerPath = deps.runnerPath ?? fileURLToPath(new URL("../../../inspector-runner.mjs", import.meta.url));
	const command = inspectorCommand({
		runnerPath,
		asyncDir: bindingDir,
		runId: target.runId,
		index: target.index,
		allowSteer: false,
		allowStop: false,
		sessionRoots: [],
		transcriptRoots: target.trustedRoots,
		trustedFiles: target.trustedFiles,
		trustedFileRoot: target.trustedFileRoot,
		transcriptPath: target.transcriptPath,
		sessionFile: target.sessionFile,
		cwd: paneCwd,
		agent: target.agent,
		lifecycle: false,
		piPackageRoot: deps.piPackageRoot ?? resolvePiPackageRoot(),
	});
	const started = await client.run(["pane", "run", paneId, command], { timeoutMs: 15_000, signal: deps.signal });
	if (started.ok === false) {
		await client.run(["pane", "close", paneId], { timeoutMs: 5_000 });
		return result(formatHerdrError(started.error), true);
	}
	const now = (deps.now?.() ?? new Date()).toISOString();
	const binding: HerdrInspectorBinding = {
		schemaVersion: 1,
		kind: "herdr-inspector",
		runId: target.runId,
		asyncDir: bindingDir,
		...(target.index !== undefined ? { childIndex: target.index } : {}),
		paneId,
		openedAt: now,
		lastFocusedAt: now,
		herdrVersion: detected.data.versionText,
		command,
	};
	writeAtomicJson(bindingPath(bindingDir, target.index), binding);
	return result(`Opened Pi-style Herdr transcript pane ${paneId} for ${target.agent} (${target.state}). Closing the pane does not stop or alter the run.`);
}
