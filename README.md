# pi-model-switch

A [Pi coding agent](https://github.com/badlogic/pi-mono) extension for direct model switching.

It provides one tool, `switch_model`, for model listing, search, and direct switching.

Foreground orchestration now lives in `pi-orchestrate`.

## Installation

```bash
pi install npm:pi-model-switch
```

Restart Pi to load the extension.

## Tool

### `switch_model`

Parameters:

- `action`: `list | search | switch`
- `search?`: query for `search` and `switch`
- `provider?`: provider filter

Behavior:

- `list`: shows available authenticated models
- `search`: filters by provider, id, or name
- `switch`: resolves aliases first, then does exact or partial model matching

## Aliases

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

Rules:

- top-level value must be an object
- alias names must be non-empty strings
- each target must be `provider/modelId`
- string alias: one exact model target
- array alias: fallback chain; first available authenticated target wins

## License

MIT
