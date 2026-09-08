# Stomylos

A Linux desktop app for practicing English with AI conversation partners.

## Features

- Chat with seven AI partners. Choose one yourself or use automatic selection.
- Start with a suggested question or your own topic. Use web search when needed.
- Get help writing a reply and understand words or phrases in simple English.
- Use voice input and listen to replies in five voices.
- Review grammar feedback and learning reports after a chat.
- Save chats, bookmarks and shared memory. Export and restore backups.
- Check monthly costs and set an optional budget in Settings.

## Conversation partners

Current settings for new chats; existing chats retain their saved model lineup.
Model IDs below are the exact OpenRouter request IDs.

| Partner | Conversation style | Model | Reasoning |
| --- | --- | --- | --- |
| Debate | Test views through reasons, objections and revision. | `anthropic/claude-fable-5.1` | Low |
| Explore | Work through ideas and follow their implications. | `xiaomi/mimo-v2.5-pro` | Off |
| Explain | Explain topics with clear examples and comparisons. | `anthropic/claude-sonnet-5` | Low |
| Chat | Follow your lead in everyday and playful conversation. | `openai/gpt-6-astra` | Low |
| Imagine | Use vivid images and playful comparisons. | `google/gemini-3.8-flash` | Low |
| Stories | Share everyday stories with concrete scenes and details. | `bytedance-seed/seed-2-1-turbo` | Off |
| Taste | Discuss specific likes, dislikes and personal preferences. | `deepseek/deepseek-v4-pro-0813` | Off |

These labels describe each model's intended fit. All partners share the same
conversation instructions and history; switching does not add a separate persona
prompt. Automatic selects once from your first message, or selects another model
on your next message when chosen during a chat. The selected partner then stays
until you change it again.

## Install and run

Tested on Linux Mint. You need Node.js 24, npm, a C compiler, and Node-API
headers (`node_api.h`, normally in `/usr/include/node`). If your headers are
elsewhere, set `STOMYLOS_NODE_HEADERS` to that directory before building.

Download or clone this repository, open a terminal in its folder, and run:

```sh
npm ci
npm run build
npm start
```

To add an application menu entry and desktop shortcut, keep the folder in a
permanent location and run:

```sh
./install-desktop.sh
```

In **Settings → Connection & data**, enter your OpenRouter API key and select
**Save securely**. Linux needs a supported system keyring, such as GNOME Keyring
or KWallet. If secure storage is unavailable, put `OPENROUTER_API_KEY=your-key`
in `~/.stomylos/.env`, run `chmod 600 ~/.stomylos/.env`, and select **Use .env file**
in Settings. AI features need internet access and use paid API credits.
Chat history is stored locally; AI requests are sent to external providers.

After source updates, close the app and run `npm run build && npm start`.

## Monthly costs and budget

Open **Settings → Usage & budget** to see this month's reported costs plus
estimated TTS costs, and set or turn off a monthly USD budget. The budget is a
reference: nearing it (80%) or reaching it (100%) is shown only in Settings and
never blocks requests. A saved budget applies immediately and repeats each month;
unused budget does not carry over. The reporting timezone is fixed when cost
recording first starts.

Only new requests made by this computer's app are recorded, beginning on the date
shown. This is not your OpenRouter account bill. Retried and failed requests can
cost money. Missing returned costs remain visible as unreported; they are not
assumed free. TTS estimates use the full submitted text (including speech tags)
at $15 per million characters, checked September 8, 2026. Interrupted requests,
provider counting rules and later rate changes can make actual charges differ.
Cached audio playback does not generate a new charge.

Cost records contain no conversation text and survive chat deletion. They and
the budget stay on this computer when exporting or restoring history backups;
those backups do not include them. Earlier usage is not reconstructed.

## License

Copyright (c) 2026 oukeidos. Stomylos is licensed under the MIT License; see
[LICENSE](LICENSE) in the source repository or `LICENSE.stomylos.txt` in a
portable bundle. Third-party components retain their own licenses; see
[Third-Party Notices](THIRD_PARTY_NOTICES.md).
