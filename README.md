# pi-model-switch

A [Pi coding agent](https://github.com/badlogic/pi-mono) extension for model and role switching.

It provides:

- `switch_model` tool for model listing/search/switching
- `switch_role` tool for role listing/search/status/switching
- `/role` command for interactive role switching
- Role drift detection and session-branch persistence

## Installation

```bash
pi install npm:pi-model-switch
```

Restart Pi to load the extension.

## Tools

### `switch_model`

`switch_model` remains model-focused.

Parameters:

- `action`: `list | search | switch`
- `search?`: query for `search` and `switch`
- `provider?`: provider filter

Behavior:

- `list`: shows available authenticated models
- `search`: filters by provider/id/name
- `switch`: alias lookup, then exact/partial model matching

### `switch_role`

`switch_role` manages full role activation.

Parameters:

- `action`: `list | search | switch | status`
- `search?`: query for `search` and `switch`

Behavior:

- `list`: shows configured roles with active marker
- `search`: filters roles by id/label/model
- `switch`: applies model + thinking + exact tools + optional instructions, then persists role state
- `status`: shows active role and snapshot details

## Role configuration

Define roles in settings as a keyed object (`agentRoles`).

- Global settings: `~/.pi/agent/settings.json`
- Project settings: `.pi/settings.json`

```json
{
  "roleInstructionMode": "append-message",
  "agentRoles": {
    "reviewer": {
      "label": "Reviewer",
      "model": "anthropic/claude-sonnet-4",
      "thinking": "medium",
      "tools": ["read", "bash", "grep"],
      "instructions": "Prioritize correctness, risk, and maintainability findings."
    },
    "planner": {
      "label": "Planner",
      "model": "openai/gpt-5.2",
      "thinking": "high",
      "tools": ["read", "bash", "grep", "find", "ls"],
      "instructionsFile": "roles/planner.md"
    }
  }
}
```

Schema rules:

- Role id is the object key
- Required: `label`, `model`, `thinking`, `tools`
- `model` must be `provider/modelId`
- `thinking` must be one of `off|minimal|low|medium|high|xhigh`
- `tools` is exact, not additive
- Use only one of `instructions` or `instructionsFile`
- Role is still valid if neither instruction field is provided

Merge behavior:

- Global and project roles are loaded together
- Project roles override global roles by id
- Project role override is full replacement for that id

`instructionsFile` path behavior:

- Global role paths resolve relative to `~/.pi/agent`
- Project role paths resolve relative to `.pi`
- Absolute paths are supported
- `~` expansion is supported

## Instruction modes

`roleInstructionMode` supports:

- `append-message` (default): inject compact role guidance in `context` per turn (non-persistent)
- `system-prompt`: append role instructions per prompt in `before_agent_start`

## Role commands and shortcuts

Slash command:

```text
/role             — open role picker
/role list        — multiline role list overlay
/role <id>        — switch directly to role id
```

Shortcut settings use a dedicated namespace:

```json
{
  "modelSwitchShortcuts": {
    "roleCycle": "alt+shift+tab",
    "roleSelect": "ctrl+alt+m"
  }
}
```

Defaults:

- `alt+shift+tab` cycles roles
- `ctrl+alt+m` opens role picker

## Role state and drift

Active role state is persisted as branch-local custom entries of type:

- `model-switch-role-state`

Manual changes to model (including `switch_model`), thinking, or tools clear active role state with:

- `Role cleared: settings changed manually`

On restore, role tools are re-applied only when role state is still valid.

## Aliases for `switch_model`

Define aliases in:

```text
~/.pi/agent/extensions/model-switch/aliases.json
```

```json
{
  "cheap": "google/gemini-2.5-flash",
  "coding": "anthropic/claude-opus-4-5",
  "budget": ["openai/gpt-5-mini", "google/gemini-2.5-flash"]
}
```

- String alias: one exact model target
- Array alias: fallback chain; first available wins

## License

MIT
