# Changelog

## [Unreleased]

### Added
- Added role runtime ownership to `model-switch` with merged `agentRoles` loading, role restore/drift logic, per-turn role instruction injection, and `/role` command support.
- Added `switch_role` tool with `list`, `search`, `switch`, and `status` actions.
- Added `modelSwitchShortcuts.roleCycle` and `modelSwitchShortcuts.roleSelect` settings for role keyboard controls.

### Changed
- Kept `switch_model` focused on model operations while role operations moved to `switch_role`.
- Added eager role drift revalidation for role-facing UI/tool paths so stale active-role state is cleared before status/list/picker operations.
- Clear active role ownership directly in successful `switch_model` switches (while retaining drift/model hooks as backup).

### Fixed
- Fixed role picker overlay rendering by using the correct `SelectList` theme shape, preventing runtime crashes when opening `/role` picker or role select shortcut.

## [0.1.3] - 2026-04-11

### Changed
- Added AGENTS.md workflow example for intent → coding → review model switching
- Simplified update instructions to use `pi install npm:pi-model-switch` only
- Added `promptSnippet` guidance so the agent uses `switch_model` more reliably

### Fixed
- Constrained `action` parameter schema to explicit enum values (`list`, `search`, `switch`)

## [0.1.2] - 2026-02-01

### Changed
- Added package keywords for npm discoverability

## [0.1.1] - 2026-02-01

### Fixed
- Adapt execute signature to pi v0.51.0: insert signal as 3rd parameter

## 0.1.0 - 2026-01-24

- Initial release
