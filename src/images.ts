import { Impit, type HttpMethod } from "impit";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSecChUaHeaders } from "./transport.js";
import type { GemaiConfig, GemaiHooks, ImageAttachment } from "./types.js";

/** minimal response shape we actually use from both impit + undici */
interface LiteResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Singleton impit instance that impersonates Chrome's TLS fingerprint (JA3/JA4). */
let _impit: Impit | null = null;
function getImpit(): Impit {
  if (!_impit) _impit = new Impit({ browser: "chrome" });
  return _impit;
}

/** Returns true when the URL targets Google's protected CDN that checks TLS fingerprints. */
function isProtectedCdn(url: string): boolean {
  return url.includes("googleusercontent.com") || url.includes("gg-dl/");
}

/** chases the 3-hop gg-dl → fife → lh3 text/plain chain to get the image url */
async function followRedirectChain(config: GemaiConfig, url: string): Promise<string> {
  if (!url.includes("googleusercontent.com") && !url.includes("fife.usercontent.google.com"))
    return url;
  if (!url.includes("/gg-dl/") && !url.includes("/rd-gg-dl/")) return url;

  // suffix goes on initial gg-dl url, not the resolved one
  let current = url;
  if (current.includes("/gg-dl/") && !current.includes("=s")) {
    current += "=s0?alr=yes"; // =s0 is full res, ?alr=yes is mandatory
  }

  const profile = buildHeaderProfiles(config)[0];

  for (let hop = 0; hop < 5; hop++) {
    try {
      const res = await smartFetch(current, {
        method: "GET",
        redirect: "manual",
        headers: profile?.headers ?? {},
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).href;
        continue;
      }

      const ct = String(res.headers.get("content-type") ?? "").toLowerCase();

      if (ct.startsWith("image/")) {
        return current;
      }

      if (ct.includes("text/")) {
        const body = (await res.text?.()) ?? (await res.arrayBuffer?.())?.toString?.() ?? "";
        const nextUrl = body.trim();
        if (!nextUrl.startsWith("http")) break;
        current = nextUrl;
        continue;
      }

      break;
    } catch {
      break;
    }
  }

  return current;
}

/** fetch with auto impit for google cdn urls */
async function smartFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal },
): Promise<LiteResponse> {
  if (isProtectedCdn(url)) {
    const impit = getImpit();
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit).entries());
    const res = await impit.fetch(url, {
      method: (init.method ?? "GET") as HttpMethod,
      headers,
      signal: init.signal,
      redirect: (init.redirect as "follow" | "manual" | "error") ?? "follow",
    });
    return res;
  }
  return fetch(url, {
    ...init,
    redirect: init.redirect as RequestRedirect | undefined,
  }) as Promise<LiteResponse>;
}

/** scrubs tokens/cookies from error bodies */
export function redactErrorBody(raw: string, maxLen = 300): string {
  return raw
    .slice(0, maxLen * 4) // work on a reasonable prefix before regex
    .replace(
      /\b(SID|PSID|SSID|APISID|SAPISID|HSID|NID|AEC|SIDCC|ENID|BUCKET)[^;,\s"]{8,}/gi,
      "$1=[redacted]",
    )
    .replace(/\b[\w-]{32,}={0,2}\b/g, "[redacted]")
    .slice(0, maxLen);
}

/** when true, skips image downloads while still surfacing urls from streams */
export const IMAGE_PIPELINE_DISABLED = process.env.IMAGE_PIPELINE_ENABLED !== "1";

const MAX_IMAGE_DOWNLOAD_BYTES = 40 * 1024 * 1024;

const EXT_MAP: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

function inferExt(contentType: string): string {
  for (const [key, value] of Object.entries(EXT_MAP)) {
    if (contentType.includes(key)) return value;
  }
  return "bin";
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]!);
    }
  });

  await Promise.all(runners);
  return results;
}

async function uploadToImgBB(
  apiKey: string,
  bytes: Buffer,
  fileName: string,
  expirationSec?: number,
): Promise<string> {
  const params = new URLSearchParams();
  params.set("image", bytes.toString("base64"));
  params.set("name", fileName);
  if (expirationSec && expirationSec > 0) {
    params.set("expiration", String(expirationSec));
  }

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    body: params,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    throw new Error(`ImgBB upload failed with status ${res.status}`);
  }

  const json = (await res.json()) as { success?: boolean; data?: { url?: string } };
  const uploaded = json?.data?.url;
  if (!json.success || !uploaded) {
    throw new Error("ImgBB upload did not return a URL");
  }
  return uploaded;
}

function buildHeaderProfiles(
  config: GemaiConfig,
): Array<{ name: string; headers: Record<string, string> }> {
  // cdn needs cookies + tls fingerprint
  return [
    {
      name: "browser-with-cookies",
      headers: {
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": config.context.acceptLanguage,
        cookie: config.auth.cookies,
        referer: "https://gemini.google.com/",
        ...buildSecChUaHeaders(config),
        "sec-fetch-dest": "image",
        "sec-fetch-mode": "no-cors",
        "sec-fetch-site": "cross-site",
        "user-agent": config.context.userAgent,
      },
    },
  ];
}

async function drainResponseBody(res: LiteResponse): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* noop */
  }
}

/** resolves gg-dl urls through the redirect chain */
export async function upgradeGgDlUrlsFromRedirects(
  config: GemaiConfig,
  urls: readonly string[],
): Promise<string[]> {
  if (process.env.IMAGE_PIPELINE_ENABLED !== "1") return [...urls];

  return Promise.all(urls.map((url) => followRedirectChain(config, url)));
}

/** downloads images concurrently with optional disk save + imgbb upload */
export async function downloadImages(
  config: GemaiConfig,
  urls: readonly string[],
  outputDir: string,
  options?: { saveFiles?: boolean; uploadToImgBB?: boolean },
  hooks?: GemaiHooks,
): Promise<{ savedPaths: string[]; uploadedUrls: string[] }> {
  if (process.env.IMAGE_PIPELINE_ENABLED !== "1") return { savedPaths: [], uploadedUrls: [] };

  const saveFiles = options?.saveFiles ?? true;
  const uploadToImgBBEnabled = options?.uploadToImgBB ?? false;
  const imgbbApiKey = config.upload?.imgbbApiKey;
  const imgbbExpiration = config.upload?.imgbbExpirationSec;
  if (urls.length === 0) return { savedPaths: [], uploadedUrls: [] };

  if (saveFiles) {
    await mkdir(outputDir, { recursive: true });
  }
  const profile = buildHeaderProfiles(config)[0];
  if (!profile) return { savedPaths: [], uploadedUrls: [] };

  const perUrl = await mapLimit([...urls], 4, async (url) => {
    hooks?.onImageDownloadAttempt?.(url);
    try {
      // resolve through redirect chain (=s0 suffix applied inside)
      const fullResUrl = await followRedirectChain(config, url);
      let res = await smartFetch(fullResUrl, {
        method: "GET",
        redirect: "follow",
        headers: profile.headers,
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429 || res.status === 503) {
        await drainResponseBody(res);
        await new Promise((r) => setTimeout(r, 2_000));
        res = await smartFetch(fullResUrl, {
          method: "GET",
          redirect: "follow",
          headers: profile.headers,
          signal: AbortSignal.timeout(20_000),
        });
      }

      if (!res.ok) {
        hooks?.onImageDownloadSkip?.(`status ${res.status}`, url);
        return null;
      }

      const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("image/")) {
        hooks?.onImageDownloadSkip?.(`content-type ${contentType || "unknown"}`, url);
        return null;
      }

      const contentLen = res.headers.get("content-length");
      if (contentLen) {
        const n = Number(contentLen);
        if (Number.isFinite(n) && n > MAX_IMAGE_DOWNLOAD_BYTES) {
          hooks?.onImageDownloadSkip?.(`content-length ${n} exceeds cap`, url);
          return null;
        }
      }

      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
        hooks?.onImageDownloadSkip?.(`body ${bytes.byteLength} exceeds cap`, url);
        return null;
      }
      const ext = inferExt(contentType);
      const fileName = `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const filePath = path.join(outputDir, fileName);
      const buffer = Buffer.from(bytes);
      if (saveFiles) {
        await writeFile(filePath, buffer);
      }

      let uploadedUrl: string | null = null;
      if (uploadToImgBBEnabled && imgbbApiKey) {
        try {
          uploadedUrl = await uploadToImgBB(imgbbApiKey, buffer, fileName, imgbbExpiration);
        } catch {
          hooks?.onImageDownloadSkip?.("imgbb upload failed", url);
        }
      }

      return { savedPath: saveFiles ? filePath : null, uploadedUrl };
    } catch {
      hooks?.onImageDownloadSkip?.("network error", url);
      return null;
    }
  });

  return {
    savedPaths: perUrl.flatMap((item) => (item?.savedPath ? [item.savedPath] : [])),
    uploadedUrls: perUrl.flatMap((item) => (item?.uploadedUrl ? [item.uploadedUrl] : [])),
  };
}

/** downloads a single image — used for mid-stream where tokens expire fast */
export async function downloadSingleImage(
  config: GemaiConfig,
  url: string,
  outputDir: string,
  hooks?: GemaiHooks,
): Promise<string | null> {
  if (process.env.IMAGE_PIPELINE_ENABLED !== "1") return null;

  await mkdir(outputDir, { recursive: true });
  const profile = buildHeaderProfiles(config)[0];
  if (!profile) return null;

  hooks?.onImageDownloadAttempt?.(url);
  try {
    // resolve through redirect chain
    const fullResUrl = await followRedirectChain(config, url);
    let res = await smartFetch(fullResUrl, {
      method: "GET",
      redirect: "follow",
      headers: profile.headers,
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 429 || res.status === 503) {
      await drainResponseBody(res);
      await new Promise((r) => setTimeout(r, 2_000));
      res = await smartFetch(fullResUrl, {
        method: "GET",
        redirect: "follow",
        headers: profile.headers,
        signal: AbortSignal.timeout(20_000),
      });
    }

    if (!res.ok) return null;

    const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) return null;

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) return null;

    const ext = inferExt(contentType);
    const fileName = `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = path.join(outputDir, fileName);
    await writeFile(filePath, Buffer.from(bytes));
    return filePath;
  } catch {
    return null;
  }
}

const KNOWN_MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

export function inferMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return KNOWN_MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Uploads a local image file to the Gemini `/upload/` endpoint and returns an
 * `ImageAttachment` with the contribution token path, MIME type, and filename.
 *
 * The upload follows the two-step resumable-upload protocol captured in
 * Gemini DevTools traffic:
 *   1. POST `/_/upload/BardChatUi/data?upload_id=…&upload_protocol=resumable`
 *      with `X-Goog-Upload-Protocol: resumable` + `X-Goog-Upload-Command: start`
 *   2. POST same URL with `X-Goog-Upload-Command: upload, finalize` + raw bytes
 *
 * On success the finalize response body contains a JSON fragment with the
 * `/contrib_service/ttl_1d/<token>` path we embed in the StreamGenerate payload.
 */
export async function uploadImageToGemini(
  config: GemaiConfig,
  filePath: string,
): Promise<ImageAttachment> {
  const fileName = path.basename(filePath);
  const mimeType = inferMimeTypeFromPath(filePath);
  const fileBytes = await readFile(filePath);
  const fileSize = fileBytes.length;

  const baseHeaders: Record<string, string> = {
    accept: "*/*",
    "accept-language": config.context.acceptLanguage,
    cookie: config.auth.cookies,
    origin: "https://gemini.google.com",
    priority: "u=1, i",
    "push-id": "feeds/mcudyrk2a4khkz",
    referer: "https://gemini.google.com/",
    ...buildSecChUaHeaders(config),
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": config.context.userAgent,
    "x-browser-channel": config.context.browserChannel,
    "x-browser-copyright": config.context.browserCopyright,
    "x-browser-validation": config.context.browserValidation,
    "x-browser-year": "2026",
    "x-client-data": config.context.clientData,
    "x-tenant-id": "bard-storage",
  };

  // step 1: start resumable upload
  const startUrl = "https://push.clients6.google.com/upload/?upload_protocol=resumable";
  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(fileSize),
      "x-goog-upload-protocol": "resumable",
    },
    body: `File name: ${fileName}`,
  });

  if (!startRes.ok) {
    const body = await startRes.text();
    throw new Error(`Gemini upload start failed (${startRes.status}): ${redactErrorBody(body)}`);
  }

  // server returns upload url for step 2
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  await startRes.arrayBuffer(); // drain body

  if (!uploadUrl) {
    throw new Error("Gemini upload start did not return x-goog-upload-url");
  }

  // step 2: upload the actual bytes
  const finalRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      "x-goog-upload-command": "upload, finalize",
      "x-goog-upload-offset": "0",
    },
    body: fileBytes,
  });

  const finalBody = await finalRes.text();

  if (!finalRes.ok) {
    throw new Error(
      `Gemini upload finalize failed (${finalRes.status}): ${redactErrorBody(finalBody)}`,
    );
  }

  // extract contrib token from response
  const tokenMatch = /\/contrib_service\/ttl_\d+[dhms]?\/([A-Za-z0-9_-]+)/.exec(finalBody);
  if (!tokenMatch) {
    throw new Error(
      `Could not extract contrib token from upload response: ${redactErrorBody(finalBody)}`,
    );
  }

  const tokenPath = tokenMatch[0];
  return { tokenPath, mimeType, fileName };
}
