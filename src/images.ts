import { fetch } from "undici";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSecChUaHeaders } from "./transport.js";
import type { GemaiConfig, GemaiHooks } from "./types.js";

/**
 * When `true`, skips lh3 redirect chasing / downloads / ImgBB while still surfacing URLs from streams.
 * Flip to `false` after confirming cookie + header profiles work for your session.
 */
export const IMAGE_PIPELINE_DISABLED = true;

const GOOGLEBOT_IMAGE_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

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

function buildCandidates(originalUrl: string): string[] {
  const out: string[] = [];
  const addUnique = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  const addAlr = (value: string): string => {
    try {
      const parsed = new URL(value);
      if (!parsed.searchParams.has("alr")) parsed.searchParams.set("alr", "yes");
      return parsed.toString();
    } catch {
      return value;
    }
  };
  const addSizeVariant = (value: string, suffix: string): string => {
    try {
      const parsed = new URL(value);
      const basePath = parsed.pathname;
      if (basePath.includes("=")) return value;
      parsed.pathname = `${basePath}${suffix}`;
      return parsed.toString();
    } catch {
      return value;
    }
  };

  const seeds = [originalUrl];
  for (const seed of seeds) {
    const withAlr = addAlr(seed);
    addUnique(seed);
    addUnique(withAlr);
    addUnique(addSizeVariant(seed, "=s1024-rj"));
    addUnique(addSizeVariant(withAlr, "=s1024-rj"));
    addUnique(addSizeVariant(seed, "=s2048-rj"));
    addUnique(addSizeVariant(withAlr, "=s2048-rj"));
  }
  return out;
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
  return [
    {
      name: "googlebot-with-cookie",
      headers: {
        accept: "*/*",
        "accept-language": config.context.acceptLanguage,
        cookie: config.auth.cookies,
        referer: "https://www.google.com/",
        "user-agent": GOOGLEBOT_IMAGE_UA,
      },
    },
    {
      name: "browser-with-cookie",
      headers: {
        accept: "*/*",
        "accept-language": config.context.acceptLanguage,
        cookie: config.auth.cookies,
        origin: "https://gemini.google.com",
        priority: "u=1, i",
        referer: "https://gemini.google.com/",
        ...buildSecChUaHeaders(config),
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "sec-fetch-storage-access": "active",
        "user-agent": config.context.userAgent,
        "x-browser-channel": config.context.browserChannel,
        "x-browser-copyright": config.context.browserCopyright,
        "x-browser-validation": config.context.browserValidation,
        "x-browser-year": "2026",
        "x-client-data": config.context.clientData,
      },
    },
  ];
}

async function drainResponseBody(res: Awaited<ReturnType<typeof fetch>>): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* noop */
  }
}

async function followGgDlRedirectChain(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 15; hop++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers,
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await drainResponseBody(res);
      if (!loc) return url;
      current = new URL(loc, current).href;
      if (current.includes("/rd-gg/")) return current;
      continue;
    }
    await drainResponseBody(res);
    return url;
  }
  return url;
}

/** Walks `gg-dl` redirects until a stable `rd-gg` URL appears (session-dependent). */
export async function upgradeGgDlUrlsFromRedirects(
  config: GemaiConfig,
  urls: readonly string[],
): Promise<string[]> {
  if (IMAGE_PIPELINE_DISABLED) return [...urls];

  const profiles = buildHeaderProfiles(config);
  return Promise.all(
    urls.map(async (url) => {
      if (!url.includes("/gg-dl/")) return url;
      try {
        for (const profile of profiles) {
          const upgraded = await followGgDlRedirectChain(url, profile.headers);
          if (upgraded.includes("/rd-gg/")) return upgraded;
        }
        return url;
      } catch {
        return url;
      }
    }),
  );
}

/** Attempts concurrent lh3 downloads + optional disk persistence / ImgBB mirror. */
export async function downloadImages(
  config: GemaiConfig,
  urls: readonly string[],
  outputDir: string,
  options?: { saveFiles?: boolean; uploadToImgBB?: boolean },
  hooks?: GemaiHooks,
): Promise<{ savedPaths: string[]; uploadedUrls: string[] }> {
  if (IMAGE_PIPELINE_DISABLED) return { savedPaths: [], uploadedUrls: [] };

  const saveFiles = options?.saveFiles ?? true;
  const uploadToImgBBEnabled = options?.uploadToImgBB ?? false;
  const imgbbApiKey = config.upload?.imgbbApiKey;
  const imgbbExpiration = config.upload?.imgbbExpirationSec;
  if (urls.length === 0) return { savedPaths: [], uploadedUrls: [] };

  if (saveFiles) {
    await mkdir(outputDir, { recursive: true });
  }
  const headerProfiles = buildHeaderProfiles(config);

  const perUrl = await mapLimit([...urls], 4, async (url) => {
    const candidates = buildCandidates(url);

    for (const candidateUrl of candidates) {
      for (const profile of headerProfiles) {
        hooks?.onImageDownloadAttempt?.(candidateUrl);
        try {
          const res = await fetch(candidateUrl, {
            method: "GET",
            redirect: "follow",
            headers: profile.headers,
          });

          if (!res.ok) {
            hooks?.onImageDownloadSkip?.(`${profile.name}: status ${res.status}`, candidateUrl);
            continue;
          }

          const contentType = String(res.headers.get("content-type") ?? "").toLowerCase();
          if (!contentType.startsWith("image/")) {
            hooks?.onImageDownloadSkip?.(
              `${profile.name}: content-type ${contentType || "unknown"}`,
              candidateUrl,
            );
            continue;
          }

          const contentLen = res.headers.get("content-length");
          if (contentLen) {
            const n = Number(contentLen);
            if (Number.isFinite(n) && n > MAX_IMAGE_DOWNLOAD_BYTES) {
              hooks?.onImageDownloadSkip?.(
                `${profile.name}: content-length ${n} exceeds cap`,
                candidateUrl,
              );
              continue;
            }
          }

          const bytes = await res.arrayBuffer();
          if (bytes.byteLength > MAX_IMAGE_DOWNLOAD_BYTES) {
            hooks?.onImageDownloadSkip?.(
              `${profile.name}: body ${bytes.byteLength} exceeds cap`,
              candidateUrl,
            );
            continue;
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
              hooks?.onImageDownloadSkip?.("imgbb upload failed", candidateUrl);
            }
          }

          return { savedPath: saveFiles ? filePath : null, uploadedUrl };
        } catch {
          hooks?.onImageDownloadSkip?.(`${profile.name}: network error`, candidateUrl);
        }
      }
    }

    return null;
  });

  return {
    savedPaths: perUrl.flatMap((item) => (item?.savedPath ? [item.savedPath] : [])),
    uploadedUrls: perUrl.flatMap((item) => (item?.uploadedUrl ? [item.uploadedUrl] : [])),
  };
}
