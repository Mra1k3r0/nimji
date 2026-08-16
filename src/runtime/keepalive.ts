import path from "node:path";
import { resolveAppHomeDir } from "../paths.js";
import { createSessionStore, loadConfigFromEnv, validateConfig } from "../index.js";
import { runBatchexecuteKeepalive, rotateCookies } from "../transport.js";

const toPositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** cli/daemon loop: rotateCookies every X min + batchexecute every Y min */
export async function runKeepalive(options?: { once?: boolean; quiet?: boolean }): Promise<void> {
  let config = loadConfigFromEnv();
  const checked = validateConfig(config);
  if (!checked.ok) throw checked.error;
  config = checked.value;

  const intervalMinutes = toPositiveInt(process.env.KEEPALIVE_INTERVAL_MINUTES, 10);
  const intervalMs = intervalMinutes * 60_000;

  const rotateIntervalMinutes = toPositiveInt(process.env.KEEPALIVE_ROTATE_INTERVAL_MINUTES, 8);
  const rotateIntervalMs = rotateIntervalMinutes * 60_000;
  const rotateEnabled = (process.env.KEEPALIVE_ROTATE_ENABLED ?? "1") !== "0";

  const baseDir = process.env.KEEPALIVE_BASE_DIR
    ? path.resolve(process.env.KEEPALIVE_BASE_DIR)
    : resolveAppHomeDir();
  const sessionFile = process.env.KEEPALIVE_SESSION_FILE ?? "keepalive-session.json";
  const sessionPath = path.resolve(baseDir, sessionFile);
  const once = options?.once ?? process.argv.includes("--once");
  const quiet = options?.quiet ?? process.argv.includes("--daemon");

  const store = createSessionStore(sessionPath);
  const conversation = await store.load();

  const persistedCookies = await store.loadRotatedCookies();
  if (persistedCookies && rotatedCookiesAreNewer(persistedCookies.rotatedAt)) {
    config = {
      ...config,
      auth: { ...config.auth, cookies: persistedCookies.cookies },
    };
    if (!quiet) {
      console.log(
        `[keepalive] loaded rotated cookies from store (rotated at ${new Date(persistedCookies.rotatedAt).toISOString()})`,
      );
    }
  }

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  if (!quiet) {
    console.log(
      `[keepalive] dual-mode: rotate every ${rotateIntervalMinutes}m (enabled=${rotateEnabled}), batchexecute every ${intervalMinutes}m`,
    );
    console.log(`[keepalive] session file: ${sessionFile}`);
    if (once) console.log("[keepalive] mode: once");
  }

  let lastRotateAt = persistedCookies?.rotatedAt ?? 0;
  let cycle = 0;

  while (!stopping) {
    cycle += 1;
    const startedAt = new Date().toISOString();
    const now = Date.now();

    const shouldRotate = rotateEnabled && now - lastRotateAt >= rotateIntervalMs;
    if (shouldRotate) {
      const rotateResult = await rotateCookies(config);
      if (rotateResult.ok) {
        lastRotateAt = rotateResult.value.rotatedAt;
        config = {
          ...config,
          auth: { ...config.auth, cookies: rotateResult.value.cookies },
        };
        await store.saveRotatedCookies(rotateResult.value.cookies, rotateResult.value.rotatedAt);
        if (!quiet) {
          console.log(`[keepalive] #${cycle} cookies rotated @ ${startedAt}`);
        }
      } else {
        const isSessionExpired = rotateResult.error.message.includes("Session expired");
        if (isSessionExpired) {
          console.error(
            `[keepalive] FATAL: Session expired, re-login needed — ${rotateResult.error.message}`,
          );
          break;
        }
        if (!quiet) {
          console.warn(
            `[keepalive] #${cycle} rotate warning @ ${startedAt} | ${rotateResult.error.message}`,
          );
        }
      }
    }

    const kaConfig = {
      ...config,
      conversation: {},
      context: {
        ...config.context,
        reqId: String(Math.floor(1_000_000 + Math.random() * 9_000_000)),
      },
    };
    const result = await runBatchexecuteKeepalive(kaConfig);

    if (result.ok) {
      await store.save(conversation);
      if (!quiet) {
        console.log(
          `[keepalive] #${cycle} ok @ ${startedAt} | status=${result.value.statusCode} | bytes=${result.value.rawSize}`,
        );
      }
    } else if (!quiet) {
      console.log(`[keepalive] #${cycle} fail @ ${startedAt} | ${result.error.message}`);
    }

    if (once || stopping) break;
    await sleep(intervalMs);
  }

  await store.save(conversation);
  if (!quiet) console.log("[keepalive] exited.");
}

/** Returns true if `rotatedAt` is recent enough to be usable (within the last hour). */
function rotatedCookiesAreNewer(rotatedAt: number): boolean {
  // Persisted cookies older than 1 hour are considered stale — prefer the
  // fresh env/config cookies in that case (e.g. after a long daemon restart).
  const STALENESS_MS = 3_600_000; // 1 hour
  return rotatedAt > 0 && Date.now() - rotatedAt < STALENESS_MS;
}

runKeepalive().catch((error) => {
  console.error("[keepalive] fatal:", error);
  process.exit(1);
});
