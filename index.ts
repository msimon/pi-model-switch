import type { ExtensionContext, ExtensionFactory, Theme } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { type SelectItem, SelectList, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
	appendActiveRoleState,
	appendClearedActiveRoleState,
	compareLiveStateAgainstSnapshot,
	readLatestActiveRoleState,
	type ActiveRoleSnapshot,
} from "./active-role-state.js";
import { loadRoles, parseModelSpec, resolveRoleInstructions, type AgentRole, type LoadedRoles } from "./roles.js";

type AliasConfig = Record<string, string | string[]>;

interface ModelSwitchShortcuts {
	roleCycle: string;
	roleSelect: string;
}

interface OverlayTui {
	requestRender(): void;
}

const DEFAULT_SHORTCUTS: ModelSwitchShortcuts = {
	roleCycle: "alt+shift+tab",
	roleSelect: "ctrl+alt+m",
};

const ROLE_CLEAR_MESSAGE = "Role cleared: settings changed manually";

function loadShortcutConfig(): ModelSwitchShortcuts {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) {
		return DEFAULT_SHORTCUTS;
	}

	try {
		const raw = readFileSync(settingsPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return DEFAULT_SHORTCUTS;
		}

		const shortcuts = parsed.modelSwitchShortcuts;
		if (typeof shortcuts !== "object" || shortcuts === null || Array.isArray(shortcuts)) {
			return DEFAULT_SHORTCUTS;
		}

		const roleCycle = typeof shortcuts.roleCycle === "string" && shortcuts.roleCycle.trim()
			? shortcuts.roleCycle.trim()
			: DEFAULT_SHORTCUTS.roleCycle;
		const roleSelect = typeof shortcuts.roleSelect === "string" && shortcuts.roleSelect.trim()
			? shortcuts.roleSelect.trim()
			: DEFAULT_SHORTCUTS.roleSelect;

		return { roleCycle, roleSelect };
	} catch (error) {
		console.debug(
			`[model-switch] Failed to load modelSwitchShortcuts from ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return DEFAULT_SHORTCUTS;
	}
}

function loadAliases(extensionDir: string): { aliases: AliasConfig; error?: string } {
	const aliasPath = join(extensionDir, "aliases.json");
	if (!existsSync(aliasPath)) {
		return { aliases: {} };
	}
	try {
		const content = readFileSync(aliasPath, "utf-8");
		return { aliases: JSON.parse(content) };
	} catch (error) {
		return { aliases: {}, error: `Failed to load aliases.json: ${error instanceof Error ? error.message : error}` };
	}
}

function formatRoleLine(role: AgentRole, activeRoleId: string | null): string {
	const active = role.id === activeRoleId ? "*" : " ";
	return `${active} ${role.id} | ${role.label} | ${role.model} | ${role.thinking} | ${role.scope}`;
}

function findRoleMatches(search: string, roles: AgentRole[]): AgentRole[] {
	const query = search.trim().toLowerCase();
	if (!query) {
		return [];
	}

	const exactId = roles.find((role) => role.id.toLowerCase() === query);
	if (exactId) {
		return [exactId];
	}

	const exactLabel = roles.filter((role) => role.label.toLowerCase() === query);
	if (exactLabel.length > 0) {
		return exactLabel;
	}

	const exactModel = roles.filter((role) => role.model.toLowerCase() === query);
	if (exactModel.length > 0) {
		return exactModel;
	}

	return roles.filter((role) => {
		return (
			role.id.toLowerCase().includes(query)
			|| role.label.toLowerCase().includes(query)
			|| role.model.toLowerCase().includes(query)
		);
	});
}

function overlaySelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

const extension: ExtensionFactory = (pi) => {
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const { aliases, error: aliasLoadError } = loadAliases(__dirname);
	const shortcutConfig = loadShortcutConfig();

	let roleSwitchInProgress = false;
	let loadedRoles: LoadedRoles = { roles: [], roleById: new Map(), instructionMode: "append-message", warnings: [] };
	let activeRoleId: string | null = null;
	let activeRoleLabel: string | null = null;
	let activeRoleSnapshot: ActiveRoleSnapshot | null = null;
	let activeRoleResolvedInstructions: string | undefined;

	function refreshRoles(ctx: ExtensionContext): void {
		loadedRoles = loadRoles(ctx.cwd);
		for (const warning of loadedRoles.warnings) {
			console.debug(warning);
		}
	}

	function formatCurrentModelSpec(ctx: ExtensionContext): string | null {
		if (!ctx.model?.provider || !ctx.model?.id) {
			return null;
		}

		return `${ctx.model.provider}/${ctx.model.id}`;
	}

	function buildLiveSnapshot(ctx: ExtensionContext): ActiveRoleSnapshot | null {
		const model = formatCurrentModelSpec(ctx);
		if (!model) {
			return null;
		}

		return {
			model,
			thinking: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		};
	}

	function setActiveRoleState(role: AgentRole, snapshot: ActiveRoleSnapshot, resolvedInstructions?: string): void {
		activeRoleId = role.id;
		activeRoleLabel = role.label;
		activeRoleSnapshot = snapshot;
		activeRoleResolvedInstructions = resolvedInstructions;
	}

	function clearActiveRole(
		ctx: ExtensionContext,
		options: {
			persist?: boolean;
			notify?: boolean;
			notificationMessage?: string;
		} = {},
	): void {
		const hadActiveRole = Boolean(activeRoleId || activeRoleSnapshot);

		activeRoleId = null;
		activeRoleLabel = null;
		activeRoleSnapshot = null;
		activeRoleResolvedInstructions = undefined;

		if (options.persist && hadActiveRole) {
			appendClearedActiveRoleState(pi);
		}

		if (options.notify && ctx.hasUI) {
			ctx.ui.notify(options.notificationMessage ?? ROLE_CLEAR_MESSAGE, "warning");
		}
	}

	function validateRoleTools(role: AgentRole): { ok: true } | { ok: false; message: string } {
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		const unknownTools = role.tools.filter((tool) => !availableTools.has(tool));
		if (unknownTools.length > 0) {
			return {
				ok: false,
				message: `Role "${role.id}" has unknown tools: ${unknownTools.join(", ")}`,
			};
		}

		return { ok: true };
	}

	function detectRoleDrift(ctx: ExtensionContext): boolean {
		if (roleSwitchInProgress || !activeRoleSnapshot) {
			return false;
		}

		const liveSnapshot = buildLiveSnapshot(ctx);
		if (!liveSnapshot) {
			return false;
		}

		const drift = compareLiveStateAgainstSnapshot(activeRoleSnapshot, liveSnapshot);
		if (drift.matches) {
			return false;
		}

		clearActiveRole(ctx, { persist: true, notify: true, notificationMessage: ROLE_CLEAR_MESSAGE });
		return true;
	}

	function buildRoleInstructionText(role: AgentRole, instructions: string): string {
		const compactInstructions = instructions.replace(/\s+/g, " ").trim();
		const shortInstructions = compactInstructions.length > 320
			? `${compactInstructions.slice(0, 317)}…`
			: compactInstructions;
		return `[role:${role.id}] ${role.label}: ${shortInstructions}`;
	}

	async function applyRole(ctx: ExtensionContext, role: AgentRole): Promise<{ ok: true } | { ok: false; error: string }> {
		const instructionResolution = resolveRoleInstructions(role, ctx.cwd);
		if (instructionResolution.ok === false) {
			return { ok: false, error: instructionResolution.error };
		}

		const toolsValidation = validateRoleTools(role);
		if (toolsValidation.ok === false) {
			return { ok: false, error: toolsValidation.message };
		}

		const modelSpec = parseModelSpec(role.model);
		if (!modelSpec) {
			return { ok: false, error: `Role "${role.id}" has invalid model format: ${role.model}` };
		}

		const model = ctx.modelRegistry.find(modelSpec.provider, modelSpec.modelId);
		if (!model) {
			return { ok: false, error: `Role "${role.id}" model not found: ${role.model}` };
		}

		const switched = await pi.setModel(model);
		if (!switched) {
			return { ok: false, error: `Role "${role.id}" model is not authenticated: ${role.model}` };
		}

		pi.setThinkingLevel(role.thinking);
		pi.setActiveTools(role.tools);

		const snapshotModelSpec = formatCurrentModelSpec(ctx) ?? `${model.provider}/${model.id}`;
		if (!snapshotModelSpec) {
			return { ok: false, error: "Failed to capture live role snapshot after switch" };
		}

		const snapshot: ActiveRoleSnapshot = {
			model: snapshotModelSpec,
			thinking: pi.getThinkingLevel(),
			tools: [...new Set(role.tools.map((tool) => tool.trim()).filter(Boolean))],
		};

		appendActiveRoleState(pi, role.id, snapshot);
		setActiveRoleState(role, snapshot, instructionResolution.instructions);
		return { ok: true };
	}

	async function applyRoleWithLock(ctx: ExtensionContext, role: AgentRole): Promise<{ ok: true } | { ok: false; error: string }> {
		if (roleSwitchInProgress) {
			return { ok: false, error: "Role switch already in progress" };
		}

		roleSwitchInProgress = true;
		try {
			return await applyRole(ctx, role);
		} finally {
			roleSwitchInProgress = false;
		}
	}

	async function restoreRoleStateFromBranch(ctx: ExtensionContext, options: { persistClearedOnMismatch?: boolean } = {}): Promise<void> {
		const stateEntry = readLatestActiveRoleState(ctx.sessionManager.getBranch());
		if (!stateEntry || !stateEntry.roleId || !stateEntry.snapshot) {
			clearActiveRole(ctx);
			return;
		}

		const role = loadedRoles.roleById.get(stateEntry.roleId);
		if (!role) {
			appendClearedActiveRoleState(pi);
			clearActiveRole(ctx);
			return;
		}

		const instructionResolution = resolveRoleInstructions(role, ctx.cwd);
		if (instructionResolution.ok === false) {
			appendClearedActiveRoleState(pi);
			clearActiveRole(ctx);
			return;
		}

		const liveSnapshot = buildLiveSnapshot(ctx);
		if (!liveSnapshot) {
			clearActiveRole(ctx);
			return;
		}

		const restoreDrift = compareLiveStateAgainstSnapshot(stateEntry.snapshot, liveSnapshot);
		if (!restoreDrift.modelMatches || !restoreDrift.thinkingMatches) {
			if (options.persistClearedOnMismatch === true) {
				appendClearedActiveRoleState(pi);
			}
			clearActiveRole(ctx);
			return;
		}

		const roleModelSpec = parseModelSpec(role.model);
		const roleModel = roleModelSpec ? ctx.modelRegistry.find(roleModelSpec.provider, roleModelSpec.modelId) : null;
		if (!roleModel) {
			appendClearedActiveRoleState(pi);
			clearActiveRole(ctx);
			return;
		}

		const expectedRoleModel = `${roleModel.provider}/${roleModel.id}`;
		const expectedRoleThinking = roleModel.reasoning ? role.thinking : "off";
		if (liveSnapshot.model !== expectedRoleModel || liveSnapshot.thinking !== expectedRoleThinking) {
			appendClearedActiveRoleState(pi);
			clearActiveRole(ctx);
			return;
		}

		const toolsValidation = validateRoleTools(role);
		if (toolsValidation.ok === false) {
			appendClearedActiveRoleState(pi);
			clearActiveRole(ctx);
			return;
		}

		pi.setActiveTools(role.tools);
		const refreshedModel = formatCurrentModelSpec(ctx);
		if (!refreshedModel) {
			clearActiveRole(ctx);
			return;
		}

		const refreshedSnapshot: ActiveRoleSnapshot = {
			model: refreshedModel,
			thinking: pi.getThinkingLevel(),
			tools: [...new Set(role.tools.map((tool) => tool.trim()).filter(Boolean))],
		};

		setActiveRoleState(role, refreshedSnapshot, instructionResolution.instructions);
	}

	async function showSelectOverlay(
		ctx: ExtensionContext,
		title: string,
		hint: string,
		items: SelectItem[],
		maxVisible: number,
	): Promise<SelectItem | null> {
		return ctx.ui.custom<SelectItem | null>(
			(tui: OverlayTui, theme: Theme, _keybindings: unknown, done: (result: SelectItem | null) => void) => {
				const selectList = new SelectList(items, maxVisible, overlaySelectListTheme(theme));
				const border = (text: string) => theme.fg("dim", text);
				const wrapRow = (text: string, innerWidth: number): string => {
					return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
				};

				return {
					render: (width: number) => {
						const innerWidth = Math.max(1, width - 2);
						const lines: string[] = [];

						lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
						lines.push(wrapRow(theme.fg("accent", theme.bold(title)), innerWidth));
						lines.push(border(`├${"─".repeat(innerWidth)}┤`));

						for (const line of selectList.render(innerWidth)) {
							lines.push(wrapRow(line, innerWidth));
						}

						lines.push(border(`├${"─".repeat(innerWidth)}┤`));
						lines.push(wrapRow(theme.fg("dim", hint), innerWidth));
						lines.push(border(`╰${"─".repeat(innerWidth)}╯`));

						return lines;
					},
					invalidate: () => selectList.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{
				overlay: true,
				overlayOptions: () => ({
					verticalAlign: "center",
					horizontalAlign: "center",
				}),
			},
		);
	}

	async function selectRoleFromList(ctx: ExtensionContext, roles: AgentRole[]): Promise<string | null> {
		const items: SelectItem[] = roles.map((role) => {
			const activeMarker = role.id === activeRoleId ? " ✓" : "";
			return {
				value: role.id,
				label: `${role.id}  ${role.label}${activeMarker}`,
				description: `${role.model}  [${role.thinking}]  (${role.scope})`,
			};
		});

		const selected = await showSelectOverlay(
			ctx,
			"Agent roles",
			"↑↓ navigate • enter switch • esc close",
			items,
			Math.min(items.length, 12),
		);
		return selected?.value ?? null;
	}

	async function showRoleListOverlay(ctx: ExtensionContext, roles: AgentRole[]): Promise<void> {
		await ctx.ui.custom(
			(_tui: OverlayTui, theme: Theme, _keybindings: unknown, done: () => void) => {
				const border = (text: string) => theme.fg("dim", text);
				const wrapRow = (text: string, innerWidth: number): string => {
					return `${border("│")}${truncateToWidth(text, innerWidth, "…", true)}${border("│")}`;
				};

				const rows = roles.map((role) => formatRoleLine(role, activeRoleId));

				return {
					render: (width: number) => {
						const innerWidth = Math.max(1, width - 2);
						const lines: string[] = [];

						lines.push(border(`╭${"─".repeat(innerWidth)}╮`));
						lines.push(wrapRow(theme.fg("accent", theme.bold("Configured roles")), innerWidth));
						lines.push(wrapRow(theme.fg("muted", "* active | id | label | model | thinking | scope"), innerWidth));
						lines.push(border(`├${"─".repeat(innerWidth)}┤`));

						for (const row of rows) {
							lines.push(wrapRow(row, innerWidth));
						}

						lines.push(border(`├${"─".repeat(innerWidth)}┤`));
						lines.push(wrapRow(theme.fg("dim", "press esc or enter to close"), innerWidth));
						lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
						return lines;
					},
					invalidate() {},
					handleInput: (data: string) => {
						if (data === "\u001b" || data === "\r" || data === "\n") {
							done();
						}
					},
				};
			},
			{
				overlay: true,
				overlayOptions: () => ({
					verticalAlign: "center",
					horizontalAlign: "center",
				}),
			},
		);
	}

	function notifyRoleSwitchResult(ctx: ExtensionContext, role: AgentRole, result: { ok: true } | { ok: false; error: string }): void {
		if (result.ok === false) {
			ctx.ui.notify(result.error, "error");
			return;
		}

		ctx.ui.notify(`Switched to role: ${role.label}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshRoles(ctx);
		await restoreRoleStateFromBranch(ctx, { persistClearedOnMismatch: true });
		detectRoleDrift(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshRoles(ctx);
		await restoreRoleStateFromBranch(ctx, { persistClearedOnMismatch: false });
		detectRoleDrift(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (roleSwitchInProgress || !activeRoleSnapshot) {
			return;
		}

		const nextModel = `${event.model.provider}/${event.model.id}`;
		if (nextModel !== activeRoleSnapshot.model) {
			clearActiveRole(ctx, { persist: true, notify: true, notificationMessage: ROLE_CLEAR_MESSAGE });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (detectRoleDrift(ctx)) {
			return;
		}

		if (!activeRoleId || loadedRoles.instructionMode !== "system-prompt" || !activeRoleResolvedInstructions) {
			return;
		}

		const role = loadedRoles.roleById.get(activeRoleId);
		if (!role) {
			clearActiveRole(ctx, { persist: true, notify: true, notificationMessage: ROLE_CLEAR_MESSAGE });
			return;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${activeRoleResolvedInstructions}`,
		};
	});

	pi.on("context", async (event, ctx) => {
		if (detectRoleDrift(ctx)) {
			return;
		}

		if (!activeRoleId || loadedRoles.instructionMode !== "append-message" || !activeRoleResolvedInstructions) {
			return;
		}

		const role = loadedRoles.roleById.get(activeRoleId);
		if (!role) {
			clearActiveRole(ctx, { persist: true, notify: true, notificationMessage: ROLE_CLEAR_MESSAGE });
			return;
		}

		event.messages.push({
			role: "user",
			content: buildRoleInstructionText(role, activeRoleResolvedInstructions),
			timestamp: Date.now(),
		});

		return { messages: event.messages };
	});

	pi.registerShortcut(shortcutConfig.roleCycle, {
		description: "Cycle to next role",
		handler: async (ctx) => {
			detectRoleDrift(ctx);

			if (!ctx.hasUI) {
				return;
			}

			refreshRoles(ctx);
			const roles = loadedRoles.roles;
			if (roles.length === 0) {
				ctx.ui.notify("No roles configured. Define `agentRoles` in settings and check README examples.", "info");
				return;
			}

			const currentIndex = activeRoleId ? roles.findIndex((role) => role.id === activeRoleId) : -1;
			const startIndex = currentIndex >= 0 ? (currentIndex + 1) % roles.length : 0;

			let lastError: string | null = null;
			for (let attempt = 0; attempt < roles.length; attempt += 1) {
				const candidateIndex = (startIndex + attempt) % roles.length;
				const candidate = roles[candidateIndex];
				const result = await applyRoleWithLock(ctx, candidate);
				if (result.ok === false) {
					lastError = result.error;
					continue;
				}

				ctx.ui.notify(`Switched to role: ${candidate.label}`, "info");
				return;
			}

			ctx.ui.notify(lastError ?? "No available roles", "warning");
		},
	});

	pi.registerShortcut(shortcutConfig.roleSelect, {
		description: "Select and switch role",
		handler: async (ctx) => {
			detectRoleDrift(ctx);

			if (!ctx.hasUI) {
				return;
			}

			refreshRoles(ctx);
			const roles = loadedRoles.roles;
			if (roles.length === 0) {
				ctx.ui.notify("No roles configured. Define `agentRoles` in settings and check README examples.", "info");
				return;
			}

			const selectedRoleId = await selectRoleFromList(ctx, roles);
			if (!selectedRoleId) {
				return;
			}

			const role = loadedRoles.roleById.get(selectedRoleId);
			if (!role) {
				ctx.ui.notify(`Unknown role id: ${selectedRoleId}`, "error");
				return;
			}

			notifyRoleSwitchResult(ctx, role, await applyRoleWithLock(ctx, role));
		},
	});

	pi.registerCommand("role", {
		description: "Switch roles. Usage: /role [list|<id>]",
		handler: async (args, ctx) => {
			detectRoleDrift(ctx);

			const trimmed = args?.trim() ?? "";

			refreshRoles(ctx);
			const roles = loadedRoles.roles;
			if (roles.length === 0) {
				ctx.ui.notify("No roles configured. Define `agentRoles` in settings and check README examples.", "info");
				return;
			}

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/role picker requires interactive UI", "error");
					return;
				}

				const selectedRoleId = await selectRoleFromList(ctx, roles);
				if (!selectedRoleId) {
					return;
				}

				const role = loadedRoles.roleById.get(selectedRoleId);
				if (!role) {
					ctx.ui.notify(`Unknown role id: ${selectedRoleId}`, "error");
					return;
				}

				notifyRoleSwitchResult(ctx, role, await applyRoleWithLock(ctx, role));
				return;
			}

			if (trimmed.toLowerCase() === "list") {
				if (!ctx.hasUI) {
					ctx.ui.notify("/role list requires interactive UI", "error");
					return;
				}

				await showRoleListOverlay(ctx, roles);
				return;
			}

			const role = loadedRoles.roleById.get(trimmed);
			if (!role) {
				const ids = roles.map((candidate) => candidate.id).join(", ");
				ctx.ui.notify(`Unknown role id: ${trimmed}. Available ids: ${ids}`, "error");
				return;
			}

			notifyRoleSwitchResult(ctx, role, await applyRoleWithLock(ctx, role));
		},
	});

	pi.registerTool({
		name: "switch_model",
		label: "Switch Model",
		description:
			"List, search, or switch models. Supports aliases defined in aliases.json (e.g. 'cheap', 'coding'). Use when the user mentions a model by name, asks to change/switch/try/test with a specific model, or when you need a model with different capabilities (reasoning, vision, cost, context window).",
		promptSnippet:
			"Use this tool when the user asks to list/search/switch models, requests a specific model/provider, or asks for cheaper/faster/vision/reasoning-capable models. Prefer action='search' before action='switch' when intent is ambiguous.",
		parameters: Type.Object({
			action: StringEnum(["list", "search", "switch"] as const, {
				description: "Action to perform: 'list' (show all models), 'search' (filter by query), or 'switch' (change model)",
			}),
			search: Type.Optional(
				Type.String({
					description:
						"For search/switch actions: search term to match model by provider, id, or name (e.g. 'sonnet', 'opus', 'gpt-5.2', 'anthropic/claude')",
				}),
			),
			provider: Type.Optional(
				Type.String({
					description: "Filter to a specific provider (e.g. 'anthropic', 'openai', 'google', 'openrouter')",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			detectRoleDrift(ctx);

			let models = ctx.modelRegistry.getAvailable();
			const currentModel = ctx.model;

			if (params.provider) {
				const providerFilter = params.provider.toLowerCase();
				models = models.filter((model) => model.provider.toLowerCase() === providerFilter);
				if (models.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No models available for provider "${params.provider}". Available providers: ${[...new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider))].join(", ")}`,
							},
						],
						isError: true,
					};
				}
			}

			if (params.action === "list") {
				if (models.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No models available. Configure API keys for providers you want to use (see `pi --help` or check ~/.pi/agent/auth.json).",
							},
						],
					};
				}

				const aliasInfo = aliasLoadError
					? `\n\nWarning: ${aliasLoadError}`
					: Object.keys(aliases).length > 0
						? `\n\nAliases: ${Object.keys(aliases).join(", ")}`
						: "";

				const lines = models.map((model) => {
					const current = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
					const marker = current ? " (current)" : "";
					const capabilities = [model.reasoning ? "reasoning" : null, model.input.includes("image") ? "vision" : null]
						.filter(Boolean)
						.join(", ");
					const capStr = capabilities ? ` [${capabilities}]` : "";
					const costStr = `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)} per 1M tokens (in/out)`;
					return `${model.provider}/${model.id}${marker}${capStr}\n  ${model.name} | ctx: ${model.contextWindow.toLocaleString()} | max: ${model.maxTokens.toLocaleString()}\n  ${costStr}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Available models (${models.length}):${aliasInfo}\n\n${lines.join("\n\n")}`,
						},
					],
				};
			}

			if (params.action === "search") {
				if (!params.search) {
					return {
						content: [{ type: "text", text: "search parameter required for search action" }],
						isError: true,
					};
				}

				const search = params.search.toLowerCase();
				const matches = models.filter(
					(model) =>
						model.id.toLowerCase().includes(search)
						|| model.name.toLowerCase().includes(search)
						|| model.provider.toLowerCase().includes(search),
				);

				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No models found matching "${params.search}"` }],
					};
				}

				const lines = matches.map((model) => {
					const current = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
					const marker = current ? " (current)" : "";
					const capabilities = [model.reasoning ? "reasoning" : null, model.input.includes("image") ? "vision" : null]
						.filter(Boolean)
						.join(", ");
					const capStr = capabilities ? ` [${capabilities}]` : "";
					const costStr = `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)} per 1M tokens (in/out)`;
					return `${model.provider}/${model.id}${marker}${capStr}\n  ${model.name} | ctx: ${model.contextWindow.toLocaleString()} | max: ${model.maxTokens.toLocaleString()}\n  ${costStr}`;
				});

				return {
					content: [
						{
							type: "text",
							text: `Models matching "${params.search}" (${matches.length}):\n\n${lines.join("\n\n")}`,
						},
					],
				};
			}

			if (params.action === "switch") {
				if (!params.search) {
					return {
						content: [{ type: "text", text: "search parameter required for switch action" }],
						isError: true,
					};
				}

				const search = params.search.toLowerCase();
				const aliasKey = Object.keys(aliases).find((key) => key.toLowerCase() === search);
				if (aliasKey) {
					const aliasValue = aliases[aliasKey];
					const candidates = Array.isArray(aliasValue) ? aliasValue : [aliasValue];

					for (const candidate of candidates) {
						const [provider, ...idParts] = candidate.split("/");
						const id = idParts.join("/");
						const aliasMatch = models.find(
							(model) => model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase() === id.toLowerCase(),
						);
						if (aliasMatch) {
							if (currentModel && aliasMatch.provider === currentModel.provider && aliasMatch.id === currentModel.id) {
								return {
									content: [{ type: "text", text: `Already using ${aliasMatch.provider}/${aliasMatch.id}` }],
								};
							}
							const success = await pi.setModel(aliasMatch);
							if (success) {
								if (!roleSwitchInProgress && activeRoleSnapshot) {
									clearActiveRole(ctx, { persist: true });
								}

								return {
									content: [
										{
											type: "text",
											text: `Switched to ${aliasMatch.provider}/${aliasMatch.id} (${aliasMatch.name}) via alias "${aliasKey}"`,
										},
									],
								};
							}
						}
					}

					return {
						content: [
							{
								type: "text",
								text: `No models available for alias "${aliasKey}". Tried: ${candidates.join(", ")}`,
							},
						],
						isError: true,
					};
				}

				let match = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === search);
				if (!match) {
					match = models.find((model) => model.id.toLowerCase() === search);
				}

				if (!match) {
					const candidateModels = models.filter(
						(model) =>
							model.id.toLowerCase().includes(search)
							|| model.name.toLowerCase().includes(search)
							|| model.provider.toLowerCase().includes(search),
					);

					if (candidateModels.length === 1) {
						match = candidateModels[0];
					} else if (candidateModels.length > 1) {
						const list = candidateModels.map((model) => `  ${model.provider}/${model.id}`).join("\n");
						return {
							content: [
								{
									type: "text",
									text: `Multiple models match "${params.search}":\n${list}\n\nBe more specific.`,
								},
							],
							isError: true,
						};
					}
				}

				if (!match) {
					return {
						content: [{ type: "text", text: `No model found matching "${params.search}"` }],
						isError: true,
					};
				}

				if (currentModel && match.provider === currentModel.provider && match.id === currentModel.id) {
					return {
						content: [{ type: "text", text: `Already using ${match.provider}/${match.id}` }],
					};
				}

				const success = await pi.setModel(match);
				if (success) {
					if (!roleSwitchInProgress && activeRoleSnapshot) {
						clearActiveRole(ctx, { persist: true });
					}

					return {
						content: [
							{
								type: "text",
								text: `Switched to ${match.provider}/${match.id} (${match.name})`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Failed to switch to ${match.provider}/${match.id} - no API key configured`,
						},
					],
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: 'Invalid action. Use "list", "search", or "switch".' }],
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "switch_role",
		label: "Switch Role",
		description:
			"List, search, switch, or inspect agent roles from `agentRoles` settings. Roles apply model, thinking, exact tools, and optional instructions with persisted session role state.",
		promptSnippet:
			"Use this tool when the user asks to list/search/switch roles or asks for a specific agent mode/persona. Prefer action='search' before action='switch' when role intent is ambiguous.",
		parameters: Type.Object({
			action: StringEnum(["list", "search", "switch", "status"] as const, {
				description: "Action to perform: 'list' (show roles), 'search' (filter roles), 'switch' (activate role), or 'status' (show active role)",
			}),
			search: Type.Optional(
				Type.String({
					description: "For search/switch actions: term to match role by id, label, or model",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			detectRoleDrift(ctx);

			refreshRoles(ctx);
			const roles = loadedRoles.roles;

			if (params.action === "status") {
				if (!activeRoleId || !activeRoleSnapshot) {
					return {
						content: [{ type: "text", text: `No active role. roleInstructionMode=${loadedRoles.instructionMode}` }],
					};
				}

				const label = activeRoleLabel ? ` (${activeRoleLabel})` : "";
				return {
					content: [
						{
							type: "text",
							text: `Active role: ${activeRoleId}${label}\nmodel=${activeRoleSnapshot.model}\nthinking=${activeRoleSnapshot.thinking}\ntools=${activeRoleSnapshot.tools.join(", ")}\nroleInstructionMode=${loadedRoles.instructionMode}`,
						},
					],
				};
			}

			if (roles.length === 0) {
				return {
					content: [{ type: "text", text: "No roles configured. Define `agentRoles` in settings and check README examples." }],
				};
			}

			if (params.action === "list") {
				const lines = roles.map((role) => formatRoleLine(role, activeRoleId));
				return {
					content: [{ type: "text", text: `Configured roles (${roles.length}):\n\n${lines.join("\n")}` }],
				};
			}

			if (params.action === "search") {
				if (!params.search) {
					return {
						content: [{ type: "text", text: "search parameter required for search action" }],
						isError: true,
					};
				}

				const matches = findRoleMatches(params.search, roles);
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No roles found matching "${params.search}"` }],
					};
				}

				const lines = matches.map((role) => formatRoleLine(role, activeRoleId));
				return {
					content: [{ type: "text", text: `Roles matching "${params.search}" (${matches.length}):\n\n${lines.join("\n")}` }],
				};
			}

			if (params.action === "switch") {
				if (!params.search) {
					return {
						content: [{ type: "text", text: "search parameter required for switch action" }],
						isError: true,
					};
				}

				const matches = findRoleMatches(params.search, roles);
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No roles found matching "${params.search}"` }],
						isError: true,
					};
				}

				if (matches.length > 1) {
					const roleList = matches.map((role) => `${role.id} (${role.label})`).join(", ");
					return {
						content: [{ type: "text", text: `Multiple roles match "${params.search}": ${roleList}` }],
						isError: true,
					};
				}

				const role = matches[0];
				const result = await applyRoleWithLock(ctx, role);
				if (result.ok === false) {
					return {
						content: [{ type: "text", text: result.error }],
						isError: true,
					};
				}

				return {
					content: [{ type: "text", text: `Switched to role: ${role.label} (${role.id})` }],
				};
			}

			return {
				content: [{ type: "text", text: 'Invalid action. Use "list", "search", "switch", or "status".' }],
				isError: true,
			};
		},
	});
};

export default extension;
