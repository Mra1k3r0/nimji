# Nimji Cookie Exporter (Browser Extension)

Small Chrome/Chromium extension that extracts the values this project requires:

- `COOKIES`

It listens to Gemini web requests and builds a ready-to-paste env block.

> **Note** — `AT_TOKEN` and `F_SID` are no longer needed. They are extracted automatically via the bard-utils REST API.

## Load Extension (Developer Mode)

1. Open `chrome://extensions` (or Edge equivalent).
2. Enable Developer Mode.
3. Click **Load unpacked**.
4. Select the `nimji-cookie-exporter` folder from this repository.

## Capture Values

1. Open `https://gemini.google.com` while signed in.
2. Open the extension popup.
3. Click **Refresh**.
4. Click **Copy Export** and paste into `.env` or `config.jsonc`.

## Notes

- `COOKIES` is generated from current cookies available to `https://gemini.google.com/`.
- `LH3_COOKIES` is captured from image download requests (optional).
- If popup shows missing cookies, send a prompt in Gemini and refresh.
