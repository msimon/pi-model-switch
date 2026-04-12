import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface ActiveRoleSnapshot {
	model: string;
	thinking: string;
	tools: string[];
}

export interface ActiveRoleStateEntry {
	roleId: string | null;
	snapshot: ActiveRoleSnapshot | null;
}

export const ACTIVE_ROLE_ENTRY_TYPE = "model-switch-role-state";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTools(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const tools: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") {
			return null;
		}

		const trimmed = entry.trim();
		if (!trimmed) {
			return null;
		}

		if (!tools.includes(trimmed)) {
			tools.push(trimmed);
		}
	}

	return tools;
}

function normalizeSnapshot(value: unknown): ActiveRoleSnapshot | null {
	if (!isRecord(value)) {
		return null;
	}

	if (typeof value.model !== "string" || !value.model.trim()) {
		return null;
	}

	if (typeof value.thinking !== "string" || !value.thinking.trim()) {
		return null;
	}

	const tools = normalizeTools(value.tools);
	if (!tools) {
		return null;
	}

	return {
		model: value.model.trim(),
		thinking: value.thinking.trim(),
		tools,
	};
}

function normalizeRoleStateEntry(value: unknown): ActiveRoleStateEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	if (value.roleId === null && value.snapshot === null) {
		return { roleId: null, snapshot: null };
	}

	if (typeof value.roleId !== "string" || !value.roleId.trim()) {
		return null;
	}

	const snapshot = normalizeSnapshot(value.snapshot);
	if (!snapshot) {
		return null;
	}

	return {
		roleId: value.roleId,
		snapshot,
	};
}

export function appendActiveRoleState(pi: Pick<ExtensionAPI, "appendEntry">, roleId: string, snapshot: ActiveRoleSnapshot): void {
	pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, { roleId, snapshot } satisfies ActiveRoleStateEntry);
}

export function appendClearedActiveRoleState(pi: Pick<ExtensionAPI, "appendEntry">): void {
	pi.appendEntry(ACTIVE_ROLE_ENTRY_TYPE, { roleId: null, snapshot: null } satisfies ActiveRoleStateEntry);
}

export function readLatestActiveRoleState(
	branchEntries: Array<{ type?: unknown; customType?: unknown; data?: unknown }>,
): ActiveRoleStateEntry | null {
	for (let i = branchEntries.length - 1; i >= 0; i -= 1) {
		const entry = branchEntries[i];
		if (entry?.type !== "custom" || entry?.customType !== ACTIVE_ROLE_ENTRY_TYPE) {
			continue;
		}

		return normalizeRoleStateEntry(entry.data);
	}

	return null;
}

function normalizeForComparison(tools: string[]): string[] {
	return [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function compareLiveStateAgainstSnapshot(snapshot: ActiveRoleSnapshot, live: ActiveRoleSnapshot): {
	matches: boolean;
	modelMatches: boolean;
	thinkingMatches: boolean;
	toolsMatches: boolean;
} {
	const modelMatches = snapshot.model === live.model;
	const thinkingMatches = snapshot.thinking === live.thinking;

	const snapshotTools = normalizeForComparison(snapshot.tools);
	const liveTools = normalizeForComparison(live.tools);
	const toolsMatches =
		snapshotTools.length === liveTools.length && snapshotTools.every((tool, index) => tool === liveTools[index]);

	return {
		matches: modelMatches && thinkingMatches && toolsMatches,
		modelMatches,
		thinkingMatches,
		toolsMatches,
	};
}
