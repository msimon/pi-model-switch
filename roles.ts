import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SettingsManager } from "@mariozechner/pi-coding-agent";

export type RoleInstructionMode = "append-message" | "system-prompt";
export type RoleScope = "global" | "project";
export type RoleThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentRole {
	id: string;
	label: string;
	model: string;
	thinking: RoleThinkingLevel;
	tools: string[];
	instructions?: string;
	instructionsFile?: string;
	scope: RoleScope;
}

interface RolesById {
	[roleId: string]: unknown;
}

export interface LoadedRoles {
	roles: AgentRole[];
	roleById: Map<string, AgentRole>;
	instructionMode: RoleInstructionMode;
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is RoleThinkingLevel {
	return value === "off"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh";
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
	const normalized = spec.trim();
	const slashIndex = normalized.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
		return null;
	}

	const provider = normalized.slice(0, slashIndex).trim();
	const modelId = normalized.slice(slashIndex + 1).trim();
	if (!provider || !modelId) {
		return null;
	}

	return { provider, modelId };
}

function parseInstructionMode(value: unknown, warnings: string[], scope: RoleScope): RoleInstructionMode | null {
	if (value === undefined) {
		return null;
	}

	if (value === "append-message" || value === "system-prompt") {
		return value;
	}

	warnings.push(`[model-switch] Ignoring invalid roleInstructionMode in ${scope} settings: ${String(value)}`);
	return null;
}

function getRolesById(settings: Record<string, unknown>, warnings: string[], scope: RoleScope): RolesById {
	const rawRoles = settings.agentRoles;
	if (rawRoles === undefined) {
		return {};
	}

	if (!isRecord(rawRoles)) {
		warnings.push(`[model-switch] Ignoring ${scope} agentRoles: expected an object keyed by role id`);
		return {};
	}

	return rawRoles;
}

function normalizeRoleTools(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	const tools: string[] = [];
	for (const tool of value) {
		if (typeof tool !== "string") {
			return null;
		}

		const normalized = tool.trim();
		if (!normalized) {
			return null;
		}

		if (!tools.includes(normalized)) {
			tools.push(normalized);
		}
	}

	return tools;
}

function normalizeRole(id: string, value: unknown, scope: RoleScope, warnings: string[]): AgentRole | null {
	if (!isRecord(value)) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): expected object value`);
		return null;
	}

	const label = value.label;
	if (typeof label !== "string" || !label.trim()) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): missing required string field "label"`);
		return null;
	}

	const model = value.model;
	if (typeof model !== "string" || !model.trim() || !parseModelSpec(model)) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): invalid required field "model" (expected provider/modelId)`);
		return null;
	}

	const thinking = value.thinking;
	if (!isThinkingLevel(thinking)) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): invalid required field "thinking"`);
		return null;
	}

	const tools = normalizeRoleTools(value.tools);
	if (!tools) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): invalid required field "tools" (expected string[])`);
		return null;
	}

	const rawInstructions = value.instructions;
	const rawInstructionsFile = value.instructionsFile;

	const hasInstructions = rawInstructions !== undefined;
	const hasInstructionsFile = rawInstructionsFile !== undefined;

	if (hasInstructions && hasInstructionsFile) {
		warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): only one of "instructions" or "instructionsFile" may be set`);
		return null;
	}

	const role: AgentRole = {
		id,
		label: label.trim(),
		model: model.trim(),
		thinking,
		tools,
		scope,
	};

	if (hasInstructions) {
		if (typeof rawInstructions !== "string" || !rawInstructions.trim()) {
			warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): "instructions" must be a non-empty string`);
			return null;
		}
		role.instructions = rawInstructions.trim();
	}

	if (hasInstructionsFile) {
		if (typeof rawInstructionsFile !== "string" || !rawInstructionsFile.trim()) {
			warnings.push(`[model-switch] Ignoring role "${id}" (${scope}): "instructionsFile" must be a non-empty string`);
			return null;
		}
		role.instructionsFile = rawInstructionsFile.trim();
	}

	return role;
}

function resolveHomePath(pathSpec: string): string {
	if (pathSpec === "~") {
		return homedir();
	}

	if (pathSpec.startsWith("~/")) {
		return join(homedir(), pathSpec.slice(2));
	}

	return pathSpec;
}

export function resolveRoleInstructionsPath(role: AgentRole, cwd: string): string | null {
	if (!role.instructionsFile) {
		return null;
	}

	const withHomeExpanded = resolveHomePath(role.instructionsFile.trim());
	if (!withHomeExpanded) {
		return null;
	}

	if (isAbsolute(withHomeExpanded)) {
		return resolve(withHomeExpanded);
	}

	const baseDir = role.scope === "global" ? join(homedir(), ".pi", "agent") : join(cwd, ".pi");

	return resolve(baseDir, withHomeExpanded);
}

export function resolveRoleInstructions(
	role: AgentRole,
	cwd: string,
): { ok: true; instructions?: string; resolvedPath?: string } | { ok: false; error: string; resolvedPath?: string } {
	if (role.instructions) {
		return { ok: true, instructions: role.instructions };
	}

	if (!role.instructionsFile) {
		return { ok: true };
	}

	const resolvedPath = resolveRoleInstructionsPath(role, cwd);
	if (!resolvedPath) {
		return {
			ok: false,
			error: `Role "${role.id}" has an invalid instructionsFile path: ${role.instructionsFile}`,
		};
	}

	try {
		const contents = readFileSync(resolvedPath, "utf-8").trim();
		if (!contents) {
			return {
				ok: false,
				error: `Role "${role.id}" instructions file is empty: ${resolvedPath}`,
				resolvedPath,
			};
		}

		return {
			ok: true,
			instructions: contents,
			resolvedPath,
		};
	} catch (error: unknown) {
		if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
			return {
				ok: false,
				error: `Role "${role.id}" instructions file not found: ${resolvedPath}`,
				resolvedPath,
			};
		}

		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `Role "${role.id}" failed to read instructions file ${resolvedPath}: ${message}`,
			resolvedPath,
		};
	}
}

export function loadRoles(cwd: string): LoadedRoles {
	const warnings: string[] = [];
	const settingsManager = SettingsManager.create(cwd);

	const settingsErrors = settingsManager.drainErrors();
	for (const settingsError of settingsErrors) {
		warnings.push(`[model-switch] Failed to load ${settingsError.scope} settings: ${settingsError.error.message}`);
	}

	const globalSettingsRaw = settingsManager.getGlobalSettings();
	const projectSettingsRaw = settingsManager.getProjectSettings();

	const globalSettings = isRecord(globalSettingsRaw) ? globalSettingsRaw : {};
	const projectSettings = isRecord(projectSettingsRaw) ? projectSettingsRaw : {};

	const globalRolesById = getRolesById(globalSettings, warnings, "global");
	const projectRolesById = getRolesById(projectSettings, warnings, "project");

	const roleIds: string[] = [
		...Object.keys(globalRolesById),
		...Object.keys(projectRolesById).filter((roleId) => !Object.prototype.hasOwnProperty.call(globalRolesById, roleId)),
	];

	const roles: AgentRole[] = [];
	for (const roleId of roleIds) {
		const projectOverrideExists = Object.prototype.hasOwnProperty.call(projectRolesById, roleId);
		const scope: RoleScope = projectOverrideExists ? "project" : "global";
		const sourceValue = projectOverrideExists ? projectRolesById[roleId] : globalRolesById[roleId];

		const normalizedRole = normalizeRole(roleId, sourceValue, scope, warnings);
		if (normalizedRole) {
			roles.push(normalizedRole);
		}
	}

	const globalMode = parseInstructionMode(globalSettings.roleInstructionMode, warnings, "global");
	const projectMode = parseInstructionMode(projectSettings.roleInstructionMode, warnings, "project");

	const instructionMode: RoleInstructionMode = projectMode ?? globalMode ?? "append-message";
	const roleById = new Map(roles.map((role) => [role.id, role]));

	return {
		roles,
		roleById,
		instructionMode,
		warnings,
	};
}
