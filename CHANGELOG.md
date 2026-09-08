# Changelog

## Unreleased

- Increased search-decision timeouts to 10 seconds per model and 20 seconds total
  for new messages, including existing chats. Previously submitted requests keep
  their saved retry settings.
- Fixed the partner-selection message appearing on ordinary replies after Auto
  selection. Reply preparation now has its own status, including search routing.

## 0.1.0 — 2026-09-08

Initial release.

- Added Settings → Usage & budget with device-local monthly costs, TTS estimates
  and an optional informational budget.
