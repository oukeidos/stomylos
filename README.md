# Stomylos

A Linux desktop app for practicing English with AI conversation partners, voice
input, writing assistance and post-chat grammar feedback.

## Conversation partners

Choose a partner or use **Automatic** to select one for your conversation.

| Partner | Model | Focus |
| --- | --- | --- |
| Debate | `anthropic/claude-fable-5.1` | Discuss arguments and opposing views. |
| Explore | `xiaomi/mimo-v2.5-pro` | Explore ideas and their implications. |
| Explain | `anthropic/claude-sonnet-5` | Understand topics through clear examples. |
| Chat | `openai/gpt-6-astra` | Have casual, everyday conversations. |
| Imagine | `google/gemini-3.8-flash` | Play with creative ideas and imagery. |
| Stories | `bytedance-seed/seed-2-1-turbo` | Share stories and experiences. |
| Taste | `deepseek/deepseek-v4-pro-0813` | Discuss interests and preferences. |

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

## After a chat

Ending a chat saves it and runs grammar analysis, question generation and memory
updates. A compact status below the conversation shows progress. Choose
**Processing details**, or the **Conversation details** information button in the
upper right, to see individual stages and recover unfinished work. You can browse
saved chats while processing; starting another chat waits until it finishes or you
choose **Force cancel**. Cancellation keeps completed results.
