# Stomylos

A Linux desktop app for English practice through AI chat and grammar pattern reports.

## Installation

Tested on Linux Mint. Requires Node.js 24, npm, a C compiler and Node-API headers
(`node_api.h`, normally in `/usr/include/node`). For headers elsewhere, set
`STOMYLOS_NODE_HEADERS` to their directory.

Download or clone this repository, open a terminal in its folder, and run:

```sh
npm ci
npm run build
```

## Running the app

```sh
npm start
```

In **Settings → Connection & data**, enter your OpenRouter API key and choose
**Save securely**. Linux requires a system keyring such as GNOME Keyring or KWallet.
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
npm run build
npm start
```
