# Changelog

## Unreleased

- Generate starter questions with the tested concise prompt and only the ended
  chat’s user messages; select Gemini 20%, GLM 40%, and Claude Sonnet 40%.
  Preserve existing duplicate/pool handling and exact retries of older jobs.
- Upgrade schema 14 to 15 without rewriting existing rows, preserving compatibility
  with the new starter request format and selection policy.

- Omit application time instructions and timestamps from newly prepared chat
  prompts, and enable automatic five-minute prompt caching for Fable and Sonnet.
  Keep message-time storage, memory updates and exact retries of older requests.
- Added automatic startup database migration from public schema 13 to 14, with a
  consistent recovery backup and transactional rollback on failure.
- Added selective Qwen memory cleanup after updates exceed 30,000 characters.
  Committed memory remains unchanged until cleanup succeeds.
- Run grammar, ordinary question generation and memory processing independently;
  block new chats until completion or force cancellation. Preserve received output
  and retry state across restart without automatic inference replay.
- Removed dedicated Intention-question generation and added separate cleanup history.

- Increased search-decision timeouts to 10 seconds per model and 20 seconds total
  for new messages, including existing chats. Previously submitted requests keep
  their saved retry settings.
- Fixed the partner-selection message appearing on ordinary replies after Auto
  selection. Reply preparation now has its own status, including search routing.

## 0.1.0 — 2026-09-08

Initial release.

- Added Settings → Usage & budget with device-local monthly costs, TTS estimates
  and an optional informational budget.
