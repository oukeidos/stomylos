# Stomylos

A Linux desktop app for English practice through AI chat and grammar pattern reports.

## Installation

Tested on Linux Mint. Requires Node.js 24 and npm. The normal source build does
not require Python, a C compiler or Node-API development headers; native npm
dependencies use their supplied binaries on supported platforms.

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

### Updating from the older file-lock version

Close all older Stomylos instances and maintenance tools before the first launch
of this version. If startup reports an old lock file, rename only the
`stomylos.lock` file at the exact path shown in the message, then reopen the app.
Do not rename or remove the database or its backup files. The app intentionally
cannot remove an old lock file while an older process might still own it.
After this one-time transition, opening Stomylos again focuses the existing window.
Older versions and legacy maintenance tools cannot access the transitioned data
using their previous lock protocol.

## Provider data policy

Text requests ask OpenRouter to exclude providers that collect data by setting
`data_collection: "deny"`.

The same request-level policy cannot be guaranteed for voice: transcription does
not support these controls, and speech synthesis policy enforcement is unverified.
