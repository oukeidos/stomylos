# Changelog

## Unreleased — 2026-09-09

- Show live post-chat progress in a blocking dialog with retry and cancel controls.

## 0.2.0 — 2026-09-09

- Analyze learner messages with Terra low and compact indexed output, preserving evidence and legacy retries in schema 18.
- Simplify Auto partner-selection prompts while preserving scoring and legacy retries in schema 17.
- Use Gemini low reasoning for faster, cheaper memory updates, preserving existing data and retries in schema 16.
- Generate concise starters from learner messages using Gemini (20%), GLM (40%) and Sonnet (40%), preserving pool handling and legacy retries.
- Upgrade schema 14 to 15 for the new starter format and selection policy without rewriting existing data.
- Remove time context from new chat prompts and enable five-minute caching for Fable and Sonnet, preserving stored timestamps and legacy retries.
- Automatically migrate schema 13 to 14 at startup with a recovery backup and rollback on failure.
- Clean up memory exceeding 30,000 characters with Qwen, preserving committed memory until cleanup succeeds.
- Process post-chat jobs independently with restart-safe retries, blocking new chats until completion or force cancellation.
- Remove dedicated Intention-question generation and add separate cleanup history.
- Increase search-decision timeouts to 10 seconds per model and 20 seconds total, preserving saved retry settings.
- Fix reply status after Auto selection by separating partner selection from reply preparation and search routing.

## 0.1.0 — 2026-09-08

- Initial release.
