import { Client } from "undici";
import { randomUUID } from "node:crypto";
import {
  buildPayload,
  buildStreamGeneratePath,
  buildStreamHeaders,
  isSessionExpiredResponse,
  parseStreamChunks,
  readStreamWithTimeouts,
  rotateCookies,
  runBatchexecuteKeepalive,
} from "./transport.js";
import { discoverLh3ImageUrls, extractResponse, sortStableGoogleImageUrls } from "./parser.js";
import { downloadImages, upgradeGgDlUrlsFromRedirects, downloadSingleImage } from "./images.js";
import type {
  CandidateScore,
  ClientOptions,
  ConversationState,
  GemaiAuth,
  GemaiClient,
  GemaiConfig,
  GemaiHooks,
  GenerateOptions,
  GenerateResult,
  KeepaliveOptions,
  Result,
} from "./types.js";
import { ok, fail } from "./types.js";
import {
  loadConfigFromEnv,
  validateConfig,
  type CreateInput,
  type LoadConfigOptions,
} from "./config.js";

/**
 * Gemini web client with queued `generate`, rolling conversation state, and optional timer keepalive.
 * Validates required auth (`COOKIES`, `AT_TOKEN`, `F_SID`) and throws if anything is missing.
 */
export function createClient(
  config: GemaiConfig,
  hooksOrOptions?: GemaiHooks | ClientOptions,
): GemaiClient {
  const checked = validateConfig(config);
  if (!checked.ok) throw checked.error;
  const cfg = checked.value;

  let authOverride: Partial<GemaiAuth> = {};

  const effectiveAuth = (): GemaiAuth => ({
    ...cfg.auth,
    ...authOverride,
  });

  let conversation: ConversationState = { ...(cfg.conversation ?? {}) };
  const options = resolveOptions(hooksOrOptions);
  const hooks = options.hooks;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let rotateTimer: NodeJS.Timeout | null = null;
  let requestQueue = Promise.resolve();

  const queueGenerate = async (
    generateOptions: GenerateOptions,
  ): Promise<Result<GenerateResult>> => {
    const task = requestQueue.then(() => runGenerate(generateOptions));
    requestQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  async function runGenerate(options: GenerateOptions): Promise<Result<GenerateResult>> {
    const requestConfig: GemaiConfig = {
      ...cfg,
      auth: effectiveAuth(),
      context: {
        ...cfg.context,
        reqId: String(Math.floor(1_000_000 + Math.random() * 9_000_000)),
        requestUuid: randomUUID().toUpperCase(),
      },
    };

    const includeImages = options.includeImages ?? true;
    const saveImages = options.saveImages ?? false;
    const wantsUpload = options.uploadImages ?? Boolean(cfg.upload?.imgbbApiKey);
    const shouldUseImageTimeouts = includeImages || saveImages || wantsUpload;
    const idleTimeout = shouldUseImageTimeouts
      ? cfg.runtime.imageStreamIdleTimeoutMs
      : cfg.runtime.streamIdleTimeoutMs;
    const maxTimeout = shouldUseImageTimeouts
      ? cfg.runtime.imageStreamMaxDurationMs
      : cfg.runtime.streamMaxDurationMs;

    const requestPath = buildStreamGeneratePath(requestConfig);
    const requestBody = buildPayload(
      requestConfig,
      options.prompt,
      conversation,
      options.imageAttachment,
    );
    await hooks?.onRequest?.({ prompt: options.prompt, path: requestPath, body: requestBody });

    const client = new Client("https://gemini.google.com", {
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      pipelining: 1,
      connect: { rejectUnauthorized: true },
    });

    try {
      const { statusCode, headers, body } = await client.request({
        method: "POST",
        path: requestPath,
        headers: buildStreamHeaders(requestConfig),
        body: requestBody,
        headersTimeout: 30_000,
        bodyTimeout: 120_000,
      });

      // mid-stream: grab image urls as chunks arrive
      const earlyDownloadedPaths: string[] = [];
      const earlyDownloadedUrls = new Set<string>();
      const earlyDownloadJobs: Promise<void>[] = [];
      const seenStreamUrls = new Set<string>();
      const outputDir = options.imageOutputDir ?? "./output-images";
      const wantsSave = saveImages;

      const onStreamChunk = wantsSave
        ? (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            const found = new Set<string>();
            discoverLh3ImageUrls(text, found);
            for (const url of found) {
              if (seenStreamUrls.has(url)) continue;
              seenStreamUrls.add(url);
              const job = downloadSingleImage(requestConfig, url, outputDir, hooks).then((p) => {
                if (p) {
                  earlyDownloadedPaths.push(p);
                  earlyDownloadedUrls.add(url);
                }
              });
              earlyDownloadJobs.push(job);
            }
          }
        : undefined;

      const rawBuffer = await readStreamWithTimeouts(
        body,
        idleTimeout,
        maxTimeout,
        (idleMs) => console.log(`[*] Stream idle for ${idleMs}ms, finalizing partial response.`),
        (maxMs) => console.log(`[*] Stream max duration ${maxMs}ms reached, finalizing.`),
        onStreamChunk,
      );
      const raw = rawBuffer.toString("utf-8");

      if (isSessionExpiredResponse(raw)) {
        return fail(
          new Error(
            "Session expired — Gemini returned a login page. Re-login to gemini.google.com and re-export cookies.",
          ),
        );
      }

      if (earlyDownloadJobs.length > 0) {
        await Promise.allSettled(earlyDownloadJobs);
      }

      if (statusCode !== 200) {
        return fail(new Error(`Non-200 response (${statusCode}): ${raw.slice(0, 1500)}`));
      }

      const chunks = parseStreamChunks(raw);
      const extracted = extractResponse(chunks, raw);

      // Upgrade gg-dl redirect tokens → rd-gg stable paths before download attempts
      const upgradedUrls = await upgradeGgDlUrlsFromRedirects(requestConfig, extracted.imageUrls);
      const resolvedImageUrls = sortStableGoogleImageUrls(upgradedUrls);

      if (extracted.conversation.conversationId) {
        conversation = {
          conversationId: extracted.conversation.conversationId,
          responseId: extracted.conversation.responseId,
          choiceId: extracted.conversation.choiceId,
        };
      }
      await hooks?.onCandidates?.(extracted.candidates as CandidateScore[]);

      const remainingUrls = resolvedImageUrls.filter((u) => !earlyDownloadedUrls.has(u));
      const { savedPaths: lateSavedPaths, uploadedUrls } =
        (saveImages || wantsUpload) && remainingUrls.length > 0
          ? await downloadImages(
              requestConfig,
              remainingUrls,
              outputDir,
              { saveFiles: saveImages, uploadToImgBB: wantsUpload },
              hooks,
            )
          : { savedPaths: [], uploadedUrls: [] };
      const savedPaths = [...earlyDownloadedPaths, ...lateSavedPaths];

      return ok({
        text: extracted.text,
        imageUrls: includeImages ? [...resolvedImageUrls] : [],
        savedImagePaths: savedPaths,
        uploadedImageUrls: uploadedUrls,
        conversation: { ...conversation },
        meta: {
          statusCode,
          contentType: String(headers["content-type"] ?? "unknown"),
          rawSize: raw.length,
          chunkCount: chunks.length,
        },
      });
    } catch (err) {
      return fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      await client.close();
    }
  }

  const startKeepalive = (keepaliveOptions?: KeepaliveOptions): void => {
    const { enabled, intervalMs } = normalizeKeepaliveOptions(
      keepaliveOptions ?? options.keepalive,
    );
    if (!enabled) return;
    if (keepaliveTimer) return;

    keepaliveTimer = setInterval(() => {
      const kaConfig: GemaiConfig = {
        ...cfg,
        auth: effectiveAuth(),
        conversation: {},
        context: {
          ...cfg.context,
          reqId: String(Math.floor(1_000_000 + Math.random() * 9_000_000)),
        },
      };
      void runBatchexecuteKeepalive(kaConfig).catch((err) => {
        if (process.env.DEBUG) console.debug("[keepalive] batchexecute error:", err.message);
      });
    }, intervalMs);

    const rotateEnabled = (process.env.KEEPALIVE_ROTATE_ENABLED ?? "1") !== "0";
    if (rotateEnabled) {
      const rotateIntervalMinutes = (() => {
        const raw = process.env.KEEPALIVE_ROTATE_INTERVAL_MINUTES;
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 8;
      })();
      const rotateIntervalMs = rotateIntervalMinutes * 60_000;

      rotateTimer = setInterval(() => {
        const kaConfig: GemaiConfig = {
          ...cfg,
          auth: effectiveAuth(),
          conversation: {},
          context: {
            ...cfg.context,
            reqId: String(Math.floor(1_000_000 + Math.random() * 9_000_000)),
          },
        };
        void rotateCookies(kaConfig).then((result) => {
          if (result.ok) {
            authOverride = { ...authOverride, cookies: result.value.cookies };
          } else {
            const isSessionExpired = result.error.message.includes("Session expired");
            if (isSessionExpired) {
              console.error(
                `[keepalive] FATAL: Session expired, re-login needed — ${result.error.message}`,
              );
              stopKeepalive();
            }
            // Transient errors: log and continue — next batchexecute cycle
            // will still run.
          }
        });
      }, rotateIntervalMs);
    }
  };

  const stopKeepalive = (): void => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
  };

  startKeepalive();

  return {
    getConversation: () => ({ ...conversation }),
    setConversation: (state) => {
      conversation = { ...state };
    },
    resetConversation: () => {
      conversation = {};
    },
    generate: queueGenerate,
    startKeepalive,
    stopKeepalive,
  };
}

/**
 * Primary wrapper: same env-style keys as `process.env` / `config.jsonc` (`COOKIES`, `AT_TOKEN`, …).
 * Values can be literals or `process.env.FOO`. Project JSON + env are merged first; `input` overrides per field without mutating global env.
 * Optional `keepalive: true` (defaults on) or `keepalive: {}` / partial options — same as second-arg `{ keepalive }`; second arg wins when both set.
 */
export function create(
  input: CreateInput,
  hooksOrOptions?: GemaiHooks | ClientOptions,
  options?: Omit<LoadConfigOptions, "overrides">,
): GemaiClient {
  const { keepalive: keepaliveFromInput, ...overrides } = input;
  return createClient(
    loadConfigFromEnv({ cwd: options?.cwd, overrides }),
    mergeKeepaliveIntoSecondArg(hooksOrOptions, keepaliveFromInput),
  );
}

/** Loads merged env / `config.jsonc` via {@link loadConfigFromEnv}, then {@link createClient}. */
export function createClientFromEnv(
  hooksOrOptions?: GemaiHooks | ClientOptions,
  options?: LoadConfigOptions,
): GemaiClient {
  return createClient(loadConfigFromEnv(options), hooksOrOptions);
}

function mergeKeepaliveIntoSecondArg(
  second: GemaiHooks | ClientOptions | undefined,
  keepaliveFromInput: boolean | KeepaliveOptions | undefined,
): GemaiHooks | ClientOptions | undefined {
  if (keepaliveFromInput === undefined) return second;
  if (!second) return { keepalive: keepaliveFromInput };
  if (isHooks(second)) return { hooks: second, keepalive: keepaliveFromInput };
  return { ...second, keepalive: second.keepalive ?? keepaliveFromInput };
}

function resolveOptions(input?: GemaiHooks | ClientOptions): ClientOptions {
  if (!input) return {};
  if (isHooks(input)) return { hooks: input };
  return input;
}

function isHooks(input: GemaiHooks | ClientOptions): input is GemaiHooks {
  return (
    "onRequest" in input ||
    "onCandidates" in input ||
    "onImageDownloadAttempt" in input ||
    "onImageDownloadSkip" in input
  );
}

function normalizeKeepaliveOptions(input?: KeepaliveOptions | boolean): Required<KeepaliveOptions> {
  if (input === false || input === undefined) {
    return { enabled: false, intervalMs: 600_000, prompt: "hi" };
  }
  if (input === true) {
    return { enabled: true, intervalMs: 600_000, prompt: "hi" };
  }
  return {
    enabled: input.enabled ?? true,
    intervalMs: input.intervalMs ?? 600_000,
    prompt: input.prompt ?? "hi",
  };
}
