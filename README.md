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
