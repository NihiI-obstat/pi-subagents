import { findPackageJSON } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseMissionRecord } from "../../missions/store.ts";
import type { MissionRecord } from "../../missions/types.ts";
import { requestAsyncSteer, requestAsyncStop } from "../../runs/background/control-channel.ts";
import { formatAsyncRunTranscript } from "../../runs/background/fleet-view.ts";
import { steeringReceipt } from "../../runs/background/steering.ts";
import type { AsyncStatus } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { decodeSessionRoots } from "./session-roots-codec.ts";
import { InspectorTranscriptProjection, type InspectorTranscriptSnapshot } from "./transcript-projection.ts";

export interface RunnerOptions {
	asyncDir: string;
	runId: string;
	index?: number;
	missionPath?: string;
	refreshMs: number;
	allowSteer?: boolean;
	allowStop?: boolean;
	sessionRoots: string[];
	trustedFiles?: string[];
	trustedFileRoot?: string;
	transcriptPath?: string;
	sessionFile?: string;
	cwd?: string;
	agent?: string;
	lifecycle?: boolean;
	piPackageRoot?: string;
}

type JsonObject = Record<string, unknown>;

type PiUiRuntime = {
	AssistantMessageComponent: new (...args: any[]) => any;
	UserMessageComponent: new (...args: any[]) => any;
	ToolExecutionComponent: new (...args: any[]) => any;
	getMarkdownTheme(): unknown;
	initTheme(themeName?: string, enableWatcher?: boolean): void;
	theme: { fg(name: string, text: string): string; bold(text: string): string };
	Container: new () => any;
	ProcessTerminal: new () => any;
	Spacer: new (lines: number) => any;
	Text: new (text: string, paddingX?: number, paddingY?: number) => any;
	TuiAltScreen: new (...args: any[]) => any;
	matchesKey(data: string, key: string): boolean;
};

function objectValue(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readMission(filePath: string | undefined): MissionRecord | undefined {
	if (!filePath) return undefined;
	try { return parseMissionRecord(JSON.parse(fs.readFileSync(filePath, "utf-8")), filePath); } catch { return undefined; }
}

interface InspectorDisplayContext {
	status?: AsyncStatus;
	state: string;
	mission?: MissionRecord;
	fingerprint: string;
}

function inspectorDisplayContext(options: RunnerOptions): InspectorDisplayContext {
	const status = options.lifecycle === false ? undefined : readStatus(options.asyncDir);
	const step = options.index !== undefined ? status?.steps?.[options.index] : undefined;
	const state = step?.status ?? status?.state ?? (options.lifecycle === false ? "recorded" : "unavailable");
	const mission = readMission(options.missionPath);
	return {
		...(status ? { status } : {}),
		state,
		...(mission ? { mission } : {}),
		fingerprint: JSON.stringify([status?.state, status?.lastUpdate, step?.status, step?.lastActivityAt, mission?.updatedAt]),
	};
}

export function formatInspectorDashboard(input: { status: AsyncStatus; asyncDir: string; index?: number; mission?: MissionRecord; allowSteer?: boolean; allowStop?: boolean; sessionRoots?: string[] }): string {
	const { status, asyncDir, mission } = input;
	const lines = [
		`pi-subagents inspector for ${status.runId}`,
		"This pane mirrors lifecycle artifacts; closing it does not stop the run.",
		"",
	];
	if (mission) {
		lines.push(`Mission: ${mission.title} (${mission.status})`, `Mission id: ${mission.id}`);
		const open = mission.decisions.filter((decision) => decision.status === "open");
		if (open.length) lines.push(`Open decisions: ${open.map((decision) => `${decision.id}: ${decision.title}`).join(" | ")}`);
		lines.push("");
	}
	lines.push(formatAsyncRunTranscript(status, asyncDir, { index: input.index, lines: 60, sessionRoots: input.sessionRoots }));
	const controls = [input.allowSteer === false ? undefined : "steer <message>", input.allowStop === false ? undefined : "stop", "status"].filter(Boolean);
	lines.push("", `Controls: ${controls.join(" | ")}`, "Supervisor replies remain in the parent Pi session (subagent_supervisor/intercom).");
	return lines.join("\n");
}

function parseArgs(argv: string[]): RunnerOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid inspector argument '${key ?? ""}'.`);
		values.set(key, value);
	}
	const asyncDir = values.get("--async-dir");
	const runId = values.get("--run-id");
	if (!asyncDir || !runId) throw new Error("Inspector requires --async-dir and --run-id.");
	const indexRaw = values.get("--index");
	const childIndex = indexRaw === undefined ? undefined : Number(indexRaw);
	if (childIndex !== undefined && (!Number.isInteger(childIndex) || childIndex < 0)) throw new Error("--index must be a non-negative integer.");
	const sessionRootsRaw = values.get("--session-roots");
	const transcriptRootsRaw = values.get("--transcript-roots");
	const sessionRoots = [...new Set([
		...(sessionRootsRaw === undefined ? [] : decodeSessionRoots(sessionRootsRaw)),
		...(transcriptRootsRaw === undefined ? [] : decodeSessionRoots(transcriptRootsRaw)),
	])];
	const trustedFilesRaw = values.get("--trusted-files");
	const trustedFiles = trustedFilesRaw === undefined ? [] : decodeSessionRoots(trustedFilesRaw);
	const refreshRaw = values.get("--refresh-ms");
	const refreshMs = refreshRaw === undefined ? 500 : Number(refreshRaw);
	if (!Number.isInteger(refreshMs) || refreshMs < 250) throw new Error("--refresh-ms must be an integer >= 250.");
	return {
		asyncDir: path.resolve(asyncDir),
		runId,
		...(childIndex !== undefined ? { index: childIndex } : {}),
		...(values.get("--mission-path") ? { missionPath: path.resolve(values.get("--mission-path")!) } : {}),
		sessionRoots,
		...(trustedFiles.length ? { trustedFiles } : {}),
		...(values.get("--trusted-file-root") ? { trustedFileRoot: path.resolve(values.get("--trusted-file-root")!) } : {}),
		...(values.get("--transcript-path") ? { transcriptPath: path.resolve(values.get("--transcript-path")!) } : {}),
		...(values.get("--session-file") ? { sessionFile: path.resolve(values.get("--session-file")!) } : {}),
		...(values.get("--cwd") ? { cwd: path.resolve(values.get("--cwd")!) } : {}),
		...(values.get("--agent") ? { agent: values.get("--agent")! } : {}),
		...(values.get("--pi-package-root") ? { piPackageRoot: path.resolve(values.get("--pi-package-root")!) } : {}),
		lifecycle: values.get("--lifecycle") !== "false",
		refreshMs,
		allowSteer: values.get("--allow-steer") !== "false",
		allowStop: values.get("--allow-stop") !== "false",
	};
}

function isTerminal(status: AsyncStatus): boolean {
	return status.state !== "queued" && status.state !== "running";
}

export function submitInspectorControl(options: RunnerOptions, line: string): string {
	const command = line.trim();
	if (!command || command === "status") return "Status refreshed.";
	if (options.lifecycle === false) throw new Error("This transcript mirror has no live lifecycle controls.");
	const status = readStatus(options.asyncDir);
	if (!status || status.runId !== options.runId) throw new Error(`Lifecycle status for run '${options.runId}' is unavailable.`);
	if (command === "stop") {
		if (options.allowStop === false) throw new Error("Authority policy does not allow stop from this inspector.");
		if (isTerminal(status)) throw new Error(`Run '${options.runId}' is ${status.state} and cannot be stopped.`);
		requestAsyncStop(options.asyncDir, { source: "herdr-inspector" });
		return `Stop requested for run ${options.runId}.`;
	}
	if (command.startsWith("steer ")) {
		if (options.allowSteer === false) throw new Error("Authority policy does not allow steer from this inspector.");
		const message = command.slice("steer ".length).trim();
		if (!message) throw new Error("steer requires a message.");
		if (isTerminal(status)) throw new Error(`Run '${options.runId}' is ${status.state} and cannot be steered.`);
		const runningIndexes = (status.steps ?? []).map((step, index) => step.status === "running" ? index : undefined).filter((index): index is number => index !== undefined);
		const targetIndex = options.index ?? (status.mode === "single" ? 0 : undefined);
		if (targetIndex === undefined && runningIndexes.length === 0) throw new Error("No running child is available to steer. Open a child-specific inspector for a pending child.");
		requestAsyncSteer(options.asyncDir, {
			message,
			...(targetIndex !== undefined ? { targetIndex } : { targetIndexes: runningIndexes }),
			source: "herdr-inspector",
		});
		return steeringReceipt(message, `Steering queued for run ${options.runId}.`);
	}
	if (command.startsWith("reply ")) throw new Error("Supervisor replies are owned by the parent Pi session; use subagent_supervisor/intercom there.");
	throw new Error("Unknown control. Use steer <message>, stop, or status.");
}

function pathWithin(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function trustedSourcePath(candidate: string | undefined, options: RunnerOptions): string | undefined {
	if (!candidate) return undefined;
	const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(options.asyncDir, candidate);
	const exactTrustedFile = options.trustedFileRoot
		&& pathWithin(options.trustedFileRoot, resolved)
		&& options.trustedFiles?.some((file) => path.resolve(file) === resolved);
	if (!options.sessionRoots.some((root) => pathWithin(root, resolved)) && !exactTrustedFile) return undefined;
	try {
		const stat = fs.lstatSync(resolved);
		if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
		const real = fs.realpathSync(resolved);
		const trustedRealRoots = options.sessionRoots.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
		const trustedFileRoot = exactTrustedFile && options.trustedFileRoot && fs.existsSync(options.trustedFileRoot)
			? fs.realpathSync(options.trustedFileRoot)
			: undefined;
		if (!trustedRealRoots.some((root) => pathWithin(root, real)) && !(trustedFileRoot && pathWithin(trustedFileRoot, real))) return undefined;
		return real;
	} catch {
		return undefined;
	}
}

function statusSourceCandidates(options: RunnerOptions): Array<string | undefined> {
	if (options.lifecycle === false) return [options.transcriptPath, options.sessionFile];
	const status = readStatus(options.asyncDir);
	if (!status || status.runId !== options.runId) return [options.transcriptPath, options.sessionFile];
	const step = options.index !== undefined
		? status.steps?.[options.index]
		: status.steps?.length === 1 ? status.steps[0] : undefined;
	return [step?.transcriptPath, options.transcriptPath, step?.sessionFile, options.sessionFile, status.sessionFile];
}

function resolveConversationSource(options: RunnerOptions): string | undefined {
	for (const candidate of statusSourceCandidates(options)) {
		const trusted = trustedSourcePath(candidate, options);
		if (trusted) return trusted;
	}
	return undefined;
}

class IncrementalTranscriptReader {
	readonly projection = new InspectorTranscriptProjection();
	private sourcePath: string | undefined;
	private offset = 0;
	private remainder = "";

	refresh(sourcePath: string | undefined): boolean {
		if (!sourcePath) return false;
		let stat: fs.Stats;
		try { stat = fs.statSync(sourcePath); } catch { return false; }
		let changed = false;
		if (this.sourcePath !== sourcePath || stat.size < this.offset) {
			this.sourcePath = sourcePath;
			this.offset = 0;
			this.remainder = "";
			this.projection.reset();
			changed = true;
		}
		if (stat.size === this.offset) return changed;
		const length = stat.size - this.offset;
		const buffer = Buffer.alloc(length);
		let fd: number | undefined;
		try {
			const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
			fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
			const bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
			this.offset += bytesRead;
			const content = this.remainder + buffer.subarray(0, bytesRead).toString("utf-8");
			const lines = content.split(/\r?\n/);
			this.remainder = lines.pop() ?? "";
			for (const line of lines) if (line.trim()) changed = this.projection.consumeLine(line) || changed;
			return changed;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}

	get path(): string | undefined { return this.sourcePath; }
}

function packageMainEntry(specifier: string, parentEntry: string): string {
	const manifestPath = findPackageJSON(specifier, parentEntry);
	if (!manifestPath) throw new Error(`Cannot locate package '${specifier}' from '${parentEntry}'.`);
	let manifest: { main?: unknown };
	try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { main?: unknown }; }
	catch (cause) { throw new Error(`Cannot read package manifest '${manifestPath}': ${cause instanceof Error ? cause.message : String(cause)}`); }
	if (typeof manifest.main !== "string" || !manifest.main.trim()) throw new Error(`Package '${specifier}' has no importable main entry.`);
	const packageRoot = path.dirname(manifestPath);
	const entry = path.resolve(packageRoot, manifest.main);
	if (!pathWithin(packageRoot, entry) || !fs.existsSync(entry)) throw new Error(`Package '${specifier}' main entry '${entry}' is unavailable.`);
	return entry;
}

async function loadPiUiRuntime(piPackageRoot: string | undefined): Promise<PiUiRuntime> {
	if (!piPackageRoot) throw new Error("The parent Pi package root was not supplied; cannot load Pi transcript components.");
	const packageJson = path.join(piPackageRoot, "package.json");
	const piEntry = path.join(piPackageRoot, "dist", "index.js");
	if (!fs.existsSync(packageJson) || !fs.existsSync(piEntry)) throw new Error(`Pi package root '${piPackageRoot}' is incomplete.`);
	const tuiEntry = packageMainEntry("@earendil-works/pi-tui", piEntry);
	const [pi, tui, themeModule] = await Promise.all([
		import(pathToFileURL(piEntry).href),
		import(pathToFileURL(tuiEntry).href),
		import(pathToFileURL(path.join(piPackageRoot, "dist", "modes", "interactive", "theme", "theme.js")).href),
	]);
	return {
		AssistantMessageComponent: pi.AssistantMessageComponent,
		UserMessageComponent: pi.UserMessageComponent,
		ToolExecutionComponent: pi.ToolExecutionComponent,
		getMarkdownTheme: pi.getMarkdownTheme,
		initTheme: pi.initTheme,
		theme: themeModule.theme,
		Container: tui.Container,
		ProcessTerminal: tui.ProcessTerminal,
		Spacer: tui.Spacer,
		Text: tui.Text,
		TuiAltScreen: tui.TuiAltScreen,
		matchesKey: tui.matchesKey,
	};
}

function messageText(message: JsonObject): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.flatMap((entry) => {
		const block = objectValue(entry);
		return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
	}).join("\n");
}

function toolCalls(message: JsonObject): JsonObject[] {
	return Array.isArray(message.content)
		? message.content.map(objectValue).filter((entry): entry is JsonObject => entry?.type === "toolCall")
		: [];
}

function buildTranscriptDocument(input: {
	runtime: PiUiRuntime;
	tui: any;
	options: RunnerOptions;
	display: InspectorDisplayContext;
	snapshot: InspectorTranscriptSnapshot;
	sourcePath?: string;
	expandedTools: boolean;
}): any {
	const { runtime, tui, options, display, snapshot } = input;
	const root = new runtime.Container();
	const step = options.index !== undefined ? display.status?.steps?.[options.index] : undefined;
	const agent = options.agent ?? step?.agent ?? (options.index === undefined ? display.status?.mode : undefined) ?? "subagent";
	root.addChild(new runtime.Text(runtime.theme.fg("accent", runtime.theme.bold(`${agent} transcript`)), 1, 0));
	root.addChild(new runtime.Text(runtime.theme.fg("dim", `${options.runId}${options.index !== undefined ? ` · child ${options.index + 1}` : ""} · ${display.state}`), 1, 0));
	if (display.mission) {
		root.addChild(new runtime.Text(runtime.theme.fg("muted", `Mission: ${display.mission.title} (${display.mission.status})`), 1, 0));
		const openDecisions = display.mission.decisions.filter((decision) => decision.status === "open");
		if (openDecisions.length) root.addChild(new runtime.Text(runtime.theme.fg("muted", `Open decisions: ${openDecisions.map((decision) => `${decision.id}: ${decision.title}`).join(" | ")}`), 1, 0));
	}
	root.addChild(new runtime.Text(runtime.theme.fg("muted", input.sourcePath ? `Mirroring ${input.sourcePath}` : "Waiting for a trusted transcript or session file…"), 1, 0));
	root.addChild(new runtime.Spacer(1));

	const markdownTheme = runtime.getMarkdownTheme();
	const renderedTools = new Map<string, any>();
	const renderedToolIds = new Set<string>();
	for (const [messageIndex, message] of snapshot.messages.entries()) {
		const role = stringValue(message.role);
		if (role === "user") {
			if (root.children.length > 4) root.addChild(new runtime.Spacer(1));
			const text = messageText(message);
			if (text) root.addChild(new runtime.UserMessageComponent(text, markdownTheme, 0));
			continue;
		}
		if (role === "assistant") {
			const pending = snapshot.pendingAssistantIndex === messageIndex;
			let component: any;
			if (pending) {
				component = new runtime.AssistantMessageComponent(undefined, false, markdownTheme, "Thinking…", 0);
				component.updateContent(message, true);
			} else component = new runtime.AssistantMessageComponent(message, false, markdownTheme, "Thinking…", 0);
			root.addChild(component);
			for (const call of toolCalls(message)) {
				const id = stringValue(call.id) ?? `tool-${messageIndex}-${renderedToolIds.size}`;
				const name = stringValue(call.name) ?? "tool";
				const args = objectValue(call.arguments) ?? {};
				const tool = new runtime.ToolExecutionComponent(name, id, args, { showImages: true, imageWidthCells: 60 }, undefined, tui, options.cwd ?? display.status?.cwd ?? process.cwd());
				tool.setExpanded(input.expandedTools);
				const toolState = snapshot.tools.get(id);
				if (toolState?.started) tool.markExecutionStarted();
				if (toolState?.argsComplete || !pending) tool.setArgsComplete();
				if (toolState?.partialResult) tool.updateResult(toolState.partialResult, true);
				if (toolState?.result) tool.updateResult(toolState.result, false);
				root.addChild(tool);
				renderedTools.set(id, tool);
				renderedToolIds.add(id);
			}
			continue;
		}
		if (role === "toolResult") {
			const id = stringValue(message.toolCallId);
			const tool = id ? renderedTools.get(id) : undefined;
			if (tool) tool.updateResult({ content: Array.isArray(message.content) ? message.content : [], details: message.details, isError: message.isError === true }, false);
		}
	}
	for (const [id, toolState] of snapshot.tools) {
		if (renderedToolIds.has(id)) continue;
		const tool = new runtime.ToolExecutionComponent(toolState.toolName, id, toolState.args, { showImages: true, imageWidthCells: 60 }, undefined, tui, options.cwd ?? display.status?.cwd ?? process.cwd());
		tool.setExpanded(input.expandedTools);
		if (toolState.started) tool.markExecutionStarted();
		if (toolState.argsComplete) tool.setArgsComplete();
		if (toolState.partialResult) tool.updateResult(toolState.partialResult, true);
		if (toolState.result) tool.updateResult(toolState.result, false);
		root.addChild(tool);
	}
	for (const notice of snapshot.notices.slice(-20)) root.addChild(new runtime.Text(runtime.theme.fg(notice.tone === "error" ? "error" : "muted", notice.text), 1, 0));
	root.addChild(new runtime.Spacer(1));
	root.addChild(new runtime.Text(runtime.theme.fg("dim", "PgUp/PgDn or mouse scroll · End follows · Ctrl+O expands tools · / searches · q/Esc closes pane"), 1, 0));
	return root;
}

export async function runInspector(argv = process.argv.slice(2)): Promise<void> {
	const options = parseArgs(argv);
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const status = readStatus(options.asyncDir);
		if (!status || status.runId !== options.runId) throw new Error(`Lifecycle status for run '${options.runId}' is unavailable.`);
		process.stdout.write(`${formatInspectorDashboard({
			status,
			asyncDir: options.asyncDir,
			index: options.index,
			mission: readMission(options.missionPath),
			allowSteer: options.allowSteer,
			allowStop: options.allowStop,
			sessionRoots: options.sessionRoots,
		})}\n`);
		return;
	}
	const runtime = await loadPiUiRuntime(options.piPackageRoot);
	runtime.initTheme(undefined, false);
	const terminal = new runtime.ProcessTerminal();
	const tui = new runtime.TuiAltScreen(terminal, false, undefined, { mouse: true });
	terminal.setTitle?.(`Subagent ${options.agent ?? options.runId.slice(0, 8)}`);
	const reader = new IncrementalTranscriptReader();
	let expandedTools = false;
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastDisplayFingerprint: string | undefined;
	let resolveClosed: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

	const rebuild = () => {
		const sourcePath = resolveConversationSource(options);
		const changed = reader.refresh(sourcePath);
		const display = inspectorDisplayContext(options);
		if (!changed && display.fingerprint === lastDisplayFingerprint && tui.children.length > 0) return;
		lastDisplayFingerprint = display.fingerprint;
		tui.clear();
		tui.addChild(buildTranscriptDocument({ runtime, tui, options, display, snapshot: reader.projection.snapshot(), sourcePath: reader.path, expandedTools }));
		tui.requestRender();
	};
	const close = () => {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		timer = undefined;
		tui.stop();
		resolveClosed?.();
	};
	const removeInputListener = tui.addInputListener((data: string) => {
		if (runtime.matchesKey(data, "q") || runtime.matchesKey(data, "escape") || runtime.matchesKey(data, "ctrl+c")) {
			close();
			return { consume: true };
		}
		if (runtime.matchesKey(data, "ctrl+o") || runtime.matchesKey(data, "x")) {
			expandedTools = !expandedTools;
			const display = inspectorDisplayContext(options);
			lastDisplayFingerprint = display.fingerprint;
			tui.clear();
			tui.addChild(buildTranscriptDocument({ runtime, tui, options, display, snapshot: reader.projection.snapshot(), sourcePath: reader.path, expandedTools }));
			tui.requestRender();
			return { consume: true };
		}
		if (runtime.matchesKey(data, "r")) {
			rebuild();
			return { consume: true };
		}
		return undefined;
	});
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	rebuild();
	tui.start();
	timer = setInterval(rebuild, options.refreshMs);
	await closed;
	removeInputListener();
	process.off("SIGINT", close);
	process.off("SIGTERM", close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	runInspector().catch((cause) => {
		process.stderr.write(`Herdr inspector failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
		process.exitCode = 1;
	});
}
