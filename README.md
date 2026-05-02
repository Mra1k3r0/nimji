# nimji

[![npm version](https://img.shields.io/npm/v/nimji.svg)](https://www.npmjs.com/package/nimji)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-3C873A)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript client and `nimji` CLI for Gemini web `StreamGenerate`. Different npm package from [`gemai`](https://www.npmjs.com/package/gemai).

## Install

```bash
npm i -g nimji
# or
npm i nimji
```

## Env

`COOKIES`, `AT_TOKEN`, and `F_SID` are normal process environment variables — set them in your shell profile, OS user env, or a tool like **direnv**. That applies to **`npm i -g nimji`** the same as a local install.

```env
COOKIES=...
AT_TOKEN=...
F_SID=...
```

Optional config files (same keys as env; **env always wins**):

1. `./config.jsonc` or `./config.json` in the current working directory
2. If missing: `~/.nimji/config.jsonc` or `~/.nimji/config.json` (useful when installed globally)
3. Or set **`NIMJI_CONFIG`** / **`GEMAI_CONFIG`** to an explicit path (resolved relative to cwd if not absolute).

See `config.jsonc` in the repo for shape.

## CLI

### One-shot (single prompt, then exit)

```bash
nimji "explain this error"
nimji --prompt "summarize README.md"
nimji --help
```

### Interactive chat (`--chat`)

```bash
nimji --chat
nimji --chat --keep-alive
```

Session/conversation state defaults to **`~/.nimji/session.json`** (`NIMJI_HOME` overrides the base dir).

## Library

```ts
import * as nimji from "nimji";

const client = nimji.create({
  COOKIES: process.env.COOKIES ?? "",
  AT_TOKEN: process.env.AT_TOKEN ?? "",
  F_SID: process.env.F_SID ?? "",
  keepalive: true, // or keepalive: {} / { intervalMs: 120_000 }
});

const res = await client.generate({ prompt: "hello", includeImages: false });
if (res.ok) console.log(res.value.text);
```

Also: `createClientFromEnv()`, `createClient(config)` for a full `GemaiConfig`. Image save/upload is off in this release (`IMAGE_PIPELINE_DISABLED` in `src/images.ts`).

## Build

```bash
npm run build
```

## Requirements

Node **≥ 22.19**. Sessions default under `~/.nimji` (`NIMJI_HOME` / `GEMAI_HOME` optional).
