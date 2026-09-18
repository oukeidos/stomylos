# Stomylos

A Linux desktop app for English practice through AI chat, grammar pattern reports and expression suggestions.

## Installation

Requires Node.js 24 and npm.

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

## Reports

Open the library and select **Reports → New report**, choose **Grammar patterns**
or **Expression suggestions**, then choose a period. Grammar reports review
recurring errors; expression suggestions offer useful grammatical ways to convey
what you already mean. Expression reports need at least one ended conversation;
grammar reports need five. The preview shows the selected conversations and an
input-cost estimate; output costs are additional.

Expression suggestions appear in the main pane, ordered by the number of matching
user messages. Expand an expression for its explanation and example, then choose
**View your messages** for the original evidence and preceding assistant context.
**Open conversation** jumps to the cited message; **Back to report** restores the
report. Counts are applicable messages, not errors or independent occasions.

The type filter separates saved reports. **Exclude conversations used in this
report type** only considers successful reports of that kind. Saved reports work
offline, including reports with no suggestions. Generation can be cancelled and
failed attempts retried; already successful results are reused. Expression reports
send the selected original conversations, including assistant context, to the model.
Selections above 2,000,000 characters are blocked; shorten the period to continue.

## Provider data policy

Text requests ask OpenRouter to exclude providers that collect data by setting
`data_collection: "deny"`.

The same request-level policy cannot be guaranteed for voice: transcription does
not support these controls, and speech synthesis policy enforcement is unverified.
