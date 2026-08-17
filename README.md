<div align="center">

# nimji

**TypeScript client and CLI for Gemini web `StreamGenerate`**

[![npm version](https://img.shields.io/npm/v/nimji?style=flat-square&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/nimji)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-3C873A?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![ESM](https://img.shields.io/badge/module-ESM-f7df1e?style=flat-square&logo=javascript&logoColor=black)](https://nodejs.org/api/esm.html)

Multi-turn sessions · Image input & generation · Keepalive · Configurable retries · Polished terminal UI

</div>

---

## Contents

- [Install](#install)
- [Credentials](#credentials)
- [CLI](#cli)
  - [One-shot](#one-shot)
  - [Interactive chat](#interactive-chat)
  - [Image prompts](#image-prompts)
  - [Image generation](#image-generation)
  - [Flags reference](#flags-reference)
- [Library](#library)
  - [Quick start](#quick-start)
  - [Image attachment](#image-attachment)
  - [Full config](#full-config)
  - [API reference](#api-reference)
- [Configuration files](#configuration-files)
- [Environment variables](#environment-variables)
- [Image pipeline](#image-pipeline)
- [Session & keepalive](#session--keepalive)
- [Development](#development)

---

## Install

```bash
# Global CLI
npm install -g nimji

# Project library
npm install nimji
```

---

## Credentials

nimji talks directly to the Gemini web `StreamGenerate` endpoint using your browser session. You need three values from DevTools (Network tab, any `StreamGenerate` request):

| Variable   | Where to find it                                              |
| ---------- | ------------------------------------------------------------- |
| `COOKIES`  | `Cookie:` request header — the full `SID=…; HSID=…; …` string |
| `AT_TOKEN` | `at=` field in the POST body                                  |
| `F_SID`    | `f.sid=` query param in the URL                               |

Set them as environment variables, in a `.env` file, or in a `config.jsonc` (see [Configuration files](#configuration-files)).

```bash
export COOKIES="SID=g.a000…"
export AT_TOKEN="AOOh0PE…"
export F_SID="-7468331635213129869"
```

> **Note** — credentials are tied to your browser session and rotate when you sign out or Chrome rotates them. Re-capture from DevTools when requests start failing.

---

<details>
<summary><h2>CLI</h2></summary>

### One-shot

Sends a single prompt, prints the response, and exits.

```bash
nimji "explain async/await in JavaScript"
nimji --prompt "summarize this repo's README"
```

### Interactive chat

Starts a readline REPL with full multi-turn memory via `session.json`.

```bash
nimji --chat
nimji --chat --keep-alive      # ping Gemini in-process to stay warm
```

Type `/exit` or `/quit` to leave. Session state is saved automatically to `~/.nimji/session.json` between runs.

### Image prompts

Attach a local image to your prompt. nimji uploads it to Gemini's upload endpoint first, then sends the contribution token inside `StreamGenerate`.

```bash
# Explicit flag
nimji --input-image ./screenshot.png "what's wrong in this code?"

# Auto-detected — image extension at end of args
nimji "describe this photo" ./sunset.jpg

# Auto-detected — image extension at start of args
nimji ./diagram.png "explain this architecture"
```

Supported formats: `png` `jpg` / `jpeg` `webp` `gif` `svg` `bmp` `tiff`

### Image generation

Use `--image` to signal image-generation prompts. Enables extended stream timeouts, extra retries, and optional local saving.

```bash
# Generate and print CDN URL
nimji --image "a neon-lit cyberpunk alleyway at night"

# Generate and save to ./output-images/ (requires IMAGE_PIPELINE_ENABLED=1)
IMAGE_PIPELINE_ENABLED=1 nimji --image --save-images "a minimalist logo for a dev tool"

# Generate, save, and upload to ImgBB
IMAGE_PIPELINE_ENABLED=1 nimji --image --save-images --upload "a watercolor cat"
```

### Flags reference

| Flag                             | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `--prompt "text"`                | Explicit prompt (alternative to positional arg)              |
| `--chat`                         | Interactive multi-turn REPL                                  |
| `--image`                        | Image-generation mode — extended timeouts + extra retries    |
| `--input-image <path>`           | Attach local image file to the prompt                        |
| `--save-images`                  | Save generated images to `./output-images/`                  |
| `--no-save-images`               | Skip disk saving even in `--image` mode                      |
| `--upload` / `--upload-images`   | Upload saved images to ImgBB (requires `IMG_BB_API_KEY`)     |
| `--show-source-image-urls`       | Print raw CDN URLs even when files are saved                 |
| `--reset-session`                | Clear `session.json` before running                          |
| `--no-session`                   | Do not load or save session state                            |
| `--keepalive` / `--keep-alive`   | Enable keepalive (in-process for `--chat`, daemon otherwise) |
| `--keepalive-minutes N`          | Keepalive ping interval in minutes (default `10`)            |
| `--no-retry`                     | Disable automatic retries on partial/empty responses         |
| `--density compact\|comfortable` | Terminal output density (default `comfortable`)              |
| `--answer-style plain\|boxed`    | Answer rendering style (default `boxed`)                     |
| `--version` / `-v`               | Print version and exit                                       |
| `--help` / `-h`                  | Print help and exit                                          |

</details>

---

<details>
<summary><h2>Library</h2></summary>

### Quick start

```ts
import { create } from "nimji";

const client = create({
  COOKIES: process.env.COOKIES ?? "",
  AT_TOKEN: process.env.AT_TOKEN ?? "",
  F_SID: process.env.F_SID ?? "",
});

const res = await client.generate({ prompt: "hello" });
if (res.ok) console.log(res.value.text);
client.stopKeepalive();
```

### Image attachment

```ts
import { create, uploadImageToGemini, inferMimeTypeFromPath } from "nimji";

const client = create({ COOKIES: "…", AT_TOKEN: "…", F_SID: "…" });

// 1. Upload the image → get a contribution token
const attachment = await uploadImageToGemini(client.getConversation(), "./photo.png");
// attachment = { tokenPath: "/contrib_service/ttl_1d/…", mimeType: "image/png", fileName: "photo.png" }

// 2. Pass the attachment alongside the prompt
const res = await client.generate({
  prompt: "what is in this image?",
  imageAttachment: attachment,
});
if (res.ok) console.log(res.value.text);
```

### Full config

```ts
import { createClient, loadConfigFromEnv } from "nimji";

const client = createClient(
  loadConfigFromEnv({
    overrides: {
      COOKIES: process.env.COOKIES ?? "",
      AT_TOKEN: process.env.AT_TOKEN ?? "",
      F_SID: process.env.F_SID ?? "",
      MODEL: "auto", // or paste a boq_assistant-… bl string
      LANGUAGE: "en",
      DEBUG_CANDIDATES: "1", // log raw text candidate scores to stderr
      IMAGE_PIPELINE_ENABLED: "1", // enable image download/save/upload
    },
  }),
  {
    hooks: {
      onCandidates: async (candidates) => {
        console.error("top:", candidates[0]);
      },
    },
    keepalive: { enabled: true, intervalMs: 300_000 },
  },
);
```

### API reference

#### `create(input, hooksOrOptions?, options?)` → `GemaiClient`

Convenience factory. Accepts flat env-style keys (`COOKIES`, `AT_TOKEN`, …) directly. Also accepts `keepalive: true | { intervalMs, prompt }` inline.

#### `createClient(config, hooksOrOptions?)` → `GemaiClient`

Low-level factory taking a full `GemaiConfig` object.

#### `createClientFromEnv(hooksOrOptions?, options?)` → `GemaiClient`

Builds config entirely from `process.env` + config files, then calls `createClient`.

#### `client.generate(options)` → `Promise<Result<GenerateResult>>`

| Option            | Type               | Description                                         |
| ----------------- | ------------------ | --------------------------------------------------- |
| `prompt`          | `string`           | The user message                                    |
| `includeImages`   | `boolean?`         | Surface image URLs in the result (default `true`)   |
| `saveImages`      | `boolean?`         | Download and save images to `imageOutputDir`        |
| `uploadImages`    | `boolean?`         | Upload saved images to ImgBB                        |
| `imageOutputDir`  | `string?`          | Save directory (default `./output-images`)          |
| `imageAttachment` | `ImageAttachment?` | Pre-uploaded image token from `uploadImageToGemini` |

#### `GenerateResult`

```ts
type GenerateResult = {
  text: string | null; // assistant reply
  imageUrls: readonly string[]; // rd-gg / gg-dl CDN links
  savedImagePaths: readonly string[]; // local files (if saved)
  uploadedImageUrls: readonly string[]; // ImgBB URLs (if uploaded)
  conversation: ConversationState; // ids for next turn
  meta: StreamMeta; // statusCode, rawSize, chunkCount, latency
};
```

#### `ImageAttachment`

```ts
type ImageAttachment = {
  tokenPath: string; // "/contrib_service/ttl_1d/<token>"
  mimeType: string; // "image/png" | "image/jpeg" | …
  fileName: string; // original filename
};
```

#### `uploadImageToGemini(config, filePath)` → `Promise<ImageAttachment>`

Uploads a local file via Gemini's two-step resumable-upload endpoint and returns the contribution token to embed in `generate()`.

#### `inferMimeTypeFromPath(filePath)` → `string`

Maps a file extension to its MIME type. Returns `"application/octet-stream"` for unknown extensions.

</details>

---

## Configuration files

nimji merges config from the first file found (env always wins):

1. Path in `NIMJI_CONFIG` env var (absolute or relative to cwd)
2. `./config.jsonc` or `./config.json` in the current working directory
3. `~/.nimji/config.jsonc` or `~/.nimji/config.json`

Keys use the same names as environment variables. See [`config.jsonc`](config.jsonc) in this repo for the full annotated shape with all nested groups (`chat`, `runtime`, `keepalive`, `browser`, `upload`).

```jsonc
{
  "COOKIES": "SID=…",
  "AT_TOKEN": "AOOh0PE…",
  "F_SID": "-746833163…",
  "MODEL": "auto",

  "chat": {
    "UI_DENSITY": "comfortable",
    "UI_ANSWER_STYLE": "boxed",
  },

  "runtime": {
    "STREAM_IDLE_TIMEOUT_MS": "30000",
    "IMAGE_STREAM_IDLE_TIMEOUT_MS": "120000",
  },
}
```

---

## Environment variables

### Required

| Variable   | Description                           |
| ---------- | ------------------------------------- |
| `COOKIES`  | Full browser session cookie string    |
| `AT_TOKEN` | Anti-CSRF token from the POST body    |
| `F_SID`    | Session identifier from the URL query |

### Optional

| Variable                 | Default          | Description                                         |
| ------------------------ | ---------------- | --------------------------------------------------- |
| `MODEL`                  | `auto`           | `auto` or a full `boq_assistant-…` build string     |
| `BL_PARAM`               | —                | Overrides `MODEL` when set; direct `bl=` value      |
| `USER_AGENT`             | Chrome UA        | Custom `User-Agent` header                          |
| `LANGUAGE`               | `en`             | Gemini request language                             |
| `ACCEPT_LANGUAGE`        | `en-US,en;q=0.9` | `Accept-Language` header                            |
| `CHROME_FULL_VERSION`    | `151.0.7922.138` | Chrome version for client-hint headers              |
| `IMAGE_PIPELINE_ENABLED` | —                | Set to `1` to enable image download/save/upload     |
| `IMG_BB_API_KEY`         | —                | ImgBB API key for `--upload`                        |
| `IMG_BB_EXPIRATION_SEC`  | `0` (permanent)  | ImgBB link TTL                                      |
| `NIMJI_HOME`             | `~/.nimji`       | Override the persistent state directory             |
| `NIMJI_CONFIG`           | —                | Explicit config file path                           |
| `UI_DENSITY`             | `comfortable`    | `compact` or `comfortable`                          |
| `UI_ANSWER_STYLE`        | `boxed`          | `boxed` or `plain`                                  |
| `DEBUG_CANDIDATES`       | `0`              | Set to `1` to log raw text candidate scores         |
| `NO_COLOR`               | —                | Set to `1` to disable ANSI color output             |
| `FORCE_COLOR`            | —                | Set to `1` to force color in non-TTY environments   |
| `ENC_KEY`                | —                | Passphrase to encrypt rotated cookies (AES-256-GCM) |

### Stream timeouts

| Variable                       | Default  | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `STREAM_IDLE_TIMEOUT_MS`       | `30000`  | Idle gap before finalizing a text stream |
| `STREAM_MAX_DURATION_MS`       | `180000` | Hard wall-clock cap for text streams     |
| `IMAGE_STREAM_IDLE_TIMEOUT_MS` | `120000` | Idle gap for image-generation streams    |
| `IMAGE_STREAM_MAX_DURATION_MS` | `600000` | Hard cap for image-generation streams    |

---

## Image pipeline

By default the image **download** pipeline is disabled. URLs are still surfaced from the stream (`imageUrls` in `GenerateResult`) but bytes are not fetched.

Enable it with `IMAGE_PIPELINE_ENABLED=1`:

```bash
# Save generated images to ./output-images/
IMAGE_PIPELINE_ENABLED=1 nimji --image --save-images "a mountain at sunset"

# Or in config.jsonc
{ "IMAGE_PIPELINE_ENABLED": "1" }
```

**Why images expire** — Gemini CDN URLs (`lh3.googleusercontent.com`) are session-scoped signed tokens. `gg-dl/` links expire in minutes; `rd-gg/` links last hours. The pipeline chases `gg-dl` → `rd-gg` redirects first, then downloads while the token is fresh. The saved files on disk never expire.

For ImgBB hosting:

```bash
IMAGE_PIPELINE_ENABLED=1 IMG_BB_API_KEY=your_key nimji --image --upload "generate art"
```

---

## Session & keepalive

Conversation state (`conversationId`, `responseId`, `choiceId`) is persisted to `~/.nimji/session.json` after each run so multi-turn context survives across shell invocations.

```bash
nimji "what's 2+2"
nimji "why?"             # continues the same conversation
nimji --reset-session    # start fresh
nimji --no-session       # skip load/save entirely
```

**Keepalive** pings Gemini to prevent session expiry during long pauses:

```bash
# In-process (chat mode)
nimji --chat --keep-alive --keepalive-minutes 5

# Detached background daemon (one-shot mode)
nimji --keepalive --keepalive-minutes 10 "hi"
```

**Cookie rotation** — nimji automatically rotates Google's freshness cookies (`__Secure-1PSIDTS`) via the internal `/RotateCookies` endpoint, extending your session indefinitely. The CLI rotates on startup; the daemon rotates every 8 minutes.

**Encrypted cookie storage** — set `ENC_KEY` to any passphrase to encrypt rotated cookies at rest in `session.json` (AES-256-GCM):

```bash
ENC_KEY="my-secret-passphrase" nimji "hello"
```

---

## Development

```bash
# Install dependencies
npm install

# Build TypeScript → dist/
npm run build

# Run tests (node:test, no extra deps)
npm test

# Watch tests
npm run test:watch

# Run from source (tsx)
npm run dev -- "hello"

# Lint
npm run lint

# Format
npm run format
```

### Tests

Tests live in `tests/` and use Node's built-in `node:test` + `node:assert` — no external test framework needed.

| File                | Coverage                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.test.ts` | `buildPayload` (text + image attachment), `buildStreamGeneratePath`, `parseStreamChunks`, `readStreamWithTimeouts`, client-hint headers, keepalive body |
| `parser.test.ts`    | `extractResponse` (text, image URLs, conversation state, noise filtering, image-gen scenarios), `sortStableGoogleImageUrls`                             |
| `config.test.ts`    | `makePick`, `loadConfigFromEnv`, `validateConfig`, `mergeProjectConfigIntoEnv` (file loading, env precedence, idempotency)                              |
| `session.test.ts`   | `createSessionStore` — load, save, clear, field normalization, size caps, round-trip                                                                    |
| `images.test.ts`    | `inferMimeTypeFromPath`, `IMAGE_PIPELINE_DISABLED` env flag, disabled-path fast-returns                                                                 |
| `client.test.ts`    | `createClient` validation, conversation get/set/reset, keepalive lifecycle, `create()` / `createClientFromEnv()` factories                              |
| `result.test.ts`    | Result type — ok, err, tryCatch, tryAsync, unwrap, match                                                                                                |
| `paths.test.ts`     | `resolveAppHomeDir`                                                                                                                                     |

```bash
npm test
```

### Project structure

```
nimji/
├── src/
│   ├── cli.ts          # CLI entry point (one-shot + --chat)
│   ├── client.ts       # GemaiClient — generate(), keepalive, conversation state
│   ├── config.ts       # loadConfigFromEnv, mergeProjectConfigIntoEnv, validateConfig
│   ├── images.ts       # uploadImageToGemini, downloadImages, inferMimeTypeFromPath
│   ├── index.ts        # Public library surface
│   ├── parser.ts       # extractResponse — text candidates, image URLs, conversation IDs
│   ├── paths.ts        # resolveAppHomeDir
│   ├── result.ts       # Custom Result<T,E> type (Rust-style, zero deps)
│   ├── session.ts      # createSessionStore — session.json persistence
│   ├── transport.ts    # buildPayload, buildStreamGeneratePath, parseStreamChunks, …
│   ├── types.ts        # Type definitions
│   └── runtime/
│       └── keepalive.ts  # Detached keepalive daemon
├── tests/
│   ├── client.test.ts
│   ├── config.test.ts
│   ├── images.test.ts
│   ├── parser.test.ts
│   ├── paths.test.ts
│   └── transport.test.ts
├── dist/               # Compiled output (ESM)
├── config.jsonc        # Annotated config template
└── package.json
```

---

## Requirements

- **Node.js ≥ 22.19** (uses `node:test`, native fetch via `undici`, `--env-file`)
- Active Gemini web session (free or paid tier)

---

<div align="center">

MIT © [Mra1k3r0](https://github.com/Mra1k3r0) · Powered by [undici](https://undici.nodejs.org)

</div>
