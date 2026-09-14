# Stomylos

A Linux desktop app for English practice through AI chat and grammar pattern reports.

## Installation

Tested on Linux Mint. Requires Node.js 24, npm, a C compiler and Node-API headers
(`node_api.h`, normally in `/usr/include/node`). For headers elsewhere, set
`STOMYLOS_NODE_HEADERS` to their directory.

Download or clone this repository, open a terminal in its folder, and run:

```sh
npm ci
npm run model:fetch
npm run build
```

The model setup command downloads the local memory embedding model from the
fixed upstream revision and verifies every file against the committed manifest.
Downloaded resources stay in the Git-ignored `assets/memory-model/` directory;
model weights are not part of this repository. Run `npm run model:verify` to
check them offline. The app does not download models during inference. Missing
files pause new local indexing while existing valid memories remain available.

## Running the app

```sh
npm start
```

In **Settings → Connection & data**, enter your OpenRouter API key and choose
**Save securely**; choose **Manage** to replace an existing key or change its source.
Linux requires a system keyring such as GNOME Keyring or KWallet.
Alternatively, save `OPENROUTER_API_KEY=your-key` in `~/.stomylos/.env`, run
`chmod 600 ~/.stomylos/.env`, and select **Use .env file** in Settings.

AI features require internet access and paid API credits. Chat history is stored
locally; AI requests are sent to external providers.

To add menu and desktop shortcuts, keep the repository in a permanent location
and run:

```sh
./install-desktop.sh
```

After updating the source, close the app and run:

```sh
npm ci
npm run model:fetch
npm run build
npm start
```

Button tips appear on hover or keyboard navigation. Activating a button or pressing
Escape dismisses its tip; returning from a dialog keeps focus without reopening it.

## Conversation guidance

After a complete exchange, click the flame button beside Hyphantes for **Dadouchos**.
A short English reflection appears above your draft while you keep writing.
The same button hides or reopens it; reopening unchanged context reuses the result.
Sending your message clears the guide. If a request fails or is interrupted, use
**Retry** to try again.

Dadouchos uses Gemma 4 31B and only the latest three complete exchanges (or the
available one or two). Your unfinished draft and long-term memory are not sent
for guidance. Guide text is temporary; request settings, status and usage remain
in Conversation details. It offers a direction for reflection and leaves the
content and wording of your reply to you.

## Provider data policy

Text requests ask OpenRouter to exclude providers that collect data by setting
`data_collection: "deny"`.

The same request-level policy cannot be guaranteed for voice: transcription does
not support these controls, and speech synthesis policy enforcement is unverified.
