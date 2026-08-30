/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This module is the schema boundary for private persisted Prompt Audit JSON and validates every field before use. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";

export const PERSISTED_PROMPT_AUDIT_VERSION = 1 as const;
const PROMPT_AUDIT_DIR = "prompt-audit";
const MAX_PROMPT_AUDIT_RECORDS = 256;
const MAX_PROMPT_AUDIT_RECORD_BYTES = 16 * 1024 * 1024;

export interface PersistedPromptAudit {
	version: typeof PERSISTED_PROMPT_AUDIT_VERSION;
	id: string;
	runId: string;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	index: number;
	agent: string;
	authoredTask: string;
	runtimeAdditions: string;
	finalEffectivePrompt: string;
	cwd?: string;
	outputPath?: string;
	model?: string;
	thinking?: string;
	startedAt: number;
	updatedAt: number;
}

export type PersistedPromptAuditInput = Omit<PersistedPromptAudit, "version" | "runtimeAdditions" | "updatedAt"> & {
	runtimeAdditions?: string;
	updatedAt?: number;
};

export function promptAuditRuntimeAdditions(authoredTask: string, effectivePrompt: string): string {
	if (!authoredTask) return effectivePrompt;
	const authoredIndex = effectivePrompt.indexOf(authoredTask);
	if (authoredIndex < 0) return "(runtime additions unavailable)";
	const before = effectivePrompt.slice(0, authoredIndex).trim();
	const after = effectivePrompt.slice(authoredIndex + authoredTask.length).trim();
	return [before, after].filter(Boolean).join("\n\n") || "(none)";
}

function promptAuditFilePath(asyncDir: string, id: string): string {
	const digest = createHash("sha256").update(id).digest("hex");
	return path.join(asyncDir, PROMPT_AUDIT_DIR, `${digest}.json`);
}

export function writePersistedPromptAudit(asyncDir: string, input: PersistedPromptAuditInput): PersistedPromptAudit {
	const record: PersistedPromptAudit = {
		version: PERSISTED_PROMPT_AUDIT_VERSION,
		id: input.id,
		runId: input.runId,
		index: input.index,
		agent: input.agent,
		authoredTask: input.authoredTask,
		runtimeAdditions: input.runtimeAdditions ?? promptAuditRuntimeAdditions(input.authoredTask, input.finalEffectivePrompt),
		finalEffectivePrompt: input.finalEffectivePrompt,
		startedAt: input.startedAt,
		updatedAt: input.updatedAt ?? Date.now(),
	};
	if (input.parentWorkflowRunId) record.parentWorkflowRunId = input.parentWorkflowRunId;
	if (input.workflowKey) record.workflowKey = input.workflowKey;
	if (input.cwd) record.cwd = input.cwd;
	if (input.outputPath) record.outputPath = input.outputPath;
	if (input.model) record.model = input.model;
	if (input.thinking) record.thinking = input.thinking;
	writePrivateAtomicJson(promptAuditFilePath(asyncDir, input.id), record);
	return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validOptionalString(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

function parsePersistedPromptAudit(value: unknown): PersistedPromptAudit | undefined {
	if (!isRecord(value)
		|| value.version !== PERSISTED_PROMPT_AUDIT_VERSION
		|| typeof value.id !== "string" || value.id.length === 0
		|| typeof value.runId !== "string" || value.runId.length === 0
		|| !validOptionalString(value.parentWorkflowRunId)
		|| !validOptionalString(value.workflowKey)
		|| typeof value.index !== "number" || !Number.isInteger(value.index)
		|| typeof value.agent !== "string" || value.agent.length === 0
		|| typeof value.authoredTask !== "string"
		|| typeof value.runtimeAdditions !== "string"
		|| typeof value.finalEffectivePrompt !== "string"
		|| !validOptionalString(value.cwd)
		|| !validOptionalString(value.outputPath)
		|| !validOptionalString(value.model)
		|| !validOptionalString(value.thinking)
		|| typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)
		|| typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	const record: PersistedPromptAudit = {
		version: PERSISTED_PROMPT_AUDIT_VERSION,
		id: value.id,
		runId: value.runId,
		index: value.index,
		agent: value.agent,
		authoredTask: value.authoredTask,
		runtimeAdditions: value.runtimeAdditions,
		finalEffectivePrompt: value.finalEffectivePrompt,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
	};
	if (typeof value.parentWorkflowRunId === "string") record.parentWorkflowRunId = value.parentWorkflowRunId;
	if (typeof value.workflowKey === "string") record.workflowKey = value.workflowKey;
	if (typeof value.cwd === "string") record.cwd = value.cwd;
	if (typeof value.outputPath === "string") record.outputPath = value.outputPath;
	if (typeof value.model === "string") record.model = value.model;
	if (typeof value.thinking === "string") record.thinking = value.thinking;
	return record;
}

export function readPersistedPromptAudits(asyncDir: string): PersistedPromptAudit[] {
	const directory = path.join(asyncDir, PROMPT_AUDIT_DIR);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const records: PersistedPromptAudit[] = [];
	for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).slice(0, MAX_PROMPT_AUDIT_RECORDS)) {
		const filePath = path.join(directory, entry.name);
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > MAX_PROMPT_AUDIT_RECORD_BYTES) continue;
			// SAFETY: JSON.parse output remains unknown and parsePersistedPromptAudit validates every consumed field.
			const parsed = parsePersistedPromptAudit(JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown);
			if (parsed) records.push(parsed);
		} catch {
			// Prompt Audit is best-effort observability; ignore partial or malformed records.
		}
	}
	return records.sort((left, right) => left.index - right.index || left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}
