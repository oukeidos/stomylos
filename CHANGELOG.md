# Changelog

## Unreleased

- Freeze baseline memory before current-input extraction and use dispatched reply evidence for memory controls and unsent retries.
- Exclude identical text from associative recall even when records have different IDs.
- Group memory used by dispatched replies into recent memory, older recollections and associative recall in Conversation details.
- Keep memory indexing notifications on the conversation event sequence so completed replies remain visible after memory updates.
- Add local associative recall from current ADD notes to relevant earlier memory records, preserving the standard final-user request shape and schema-33 upgrades.
- Use the selected merge-only memory prompt and local date with weekday for new ADD requests while preserving full source timestamps and frozen historical requests.

## 0.5.0 — 2026-09-12

- Replace the separate All and Bookmarked filter row with a bookmark switch beside Chats and Reports, preserving the filter when returning from Reports.
- Show the last submitted user input instead of Ended in conversation history while preserving actionable status labels.
- Remember Web search and Lighter replies immediately when selected, including unsent drafts, and use them only as defaults for new chats with a preserving schema-32 upgrade.
- Add a start-only Lighter replies feather icon with a shorter-replies tooltip, a remembered starting choice, immutable per-chat behavior and a preserving schema-31 upgrade.
- Group closely related memory facts and their supporting references into a single note for new ADD requests.
- Show chat-local user input numbers in memory history, recovery and request details, and distinguish moves to Older from historical capacity deletions.
- Preserve FIFO memory evictions as original Older notes, group them with local embeddings and recall up to three notes per new eligible chat, with schema 30 migration, explicit deletion and resumable indexing.
- Fetch the memory model from a pinned upstream revision with verified checksums while keeping downloaded model files out of Git.
- Fix End and start new to open a new chat automatically after blocking end processing resolves.
- Consolidate conversation memory details into the fixed snapshot and per-input changes with exact-input recovery.
- Fix startup for existing schema-28 databases by removing the previous-memory archive through a backed-up schema-29 migration.
- Add Luna memory notes after each eligible message, retaining up to 4,000 characters by oldest-first removal; schema 29 uses the standard pre-upgrade backup and offers per-input recovery without automatic paid retries.
- Add in-app exit recovery with text copying and explicit unsaved-exit confirmation when saving or shutdown is blocked.
- Unify text routing with no provider pin, fallback enabled and data collection denied, preserving history and voice caches through schema 27 and documenting audio policy limitations.
- Fix Auto partner selection getting stuck with a save error when recording routing results or preparing its fallback attempt.

## 0.4.0 — 2026-09-11

- Add a global Memory On/Off switch in Settings with schema 26 upgrades.
- Add compact memory search, editing and confirmed deletion in Settings, with draft protection and schema 25 compatibility.
- Update the 5,000-question English catalog automatically while preserving usage counts, conversation history and unfinished drafts.
- Add Expand (DeepSeek V4.1 Flash), adopt Share/Prefer and a centered partner order, show model names, and introduce Luna→Terra Auto recovery with schema 23 compatibility.
- Store shared memory as one list with split update operations, matching cleanup and history views, and schema 22 upgrades that preserve saved requests and unfinished work.
- Compact memory updater requests with short IDs and streamlined metadata, preserving full conversations, stored data and legacy retries through schema 21.
- Keep icon tooltips visible outside scrolling panels and dialogs, and reposition them at window edges.
- Generate reports directly from learner messages with flexible date ranges, expanded capacity and simpler controls; make session grammar analysis manual while preserving history through schema 20.

## 0.3.0 — 2026-09-09

- Replace online starter generation with 5,000 reusable English questions, weighted by answer count, with a safe schema 19 migration that preserves history.
- Consolidate chat details in the header and replace its overflow menu with a delete button.
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
