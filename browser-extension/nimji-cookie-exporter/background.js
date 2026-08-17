/* global chrome, URL */

const STORAGE_KEY = "nimjiAuthCapture";

const defaultState = () => ({
  atToken: "",
  fSid: "",
  lastCapturedAt: 0,
  lastUrl: "",
  rotatedAt: 0,
  lastRotationMs: 600_000,
});

async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaultState(), ...(stored[STORAGE_KEY] || {}) };
}

async function writeState(next) {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

function normalizeForEnv(value) {
  return String(value || "")
    .replace(/\r?\n/g, "")
    .trim();
}

function shellQuote(value) {
  return `'${normalizeForEnv(value).replace(/'/g, "'\\''")}'`;
}

function buildEnvBlock(cookies, atToken, fSid, lh3Cookies) {
  const lines = [
    `COOKIES=${shellQuote(cookies)}`,
    // AT_TOKEN and F_SID are now extracted automatically via bard-utils API — no longer needed
    // `AT_TOKEN=${shellQuote(atToken)}`,
    // `F_SID=${shellQuote(fSid)}`,
  ];
  if (lh3Cookies) {
    lines.push(`LH3_COOKIES=${shellQuote(lh3Cookies)}`);
  }
  return lines.join("\n");
}

async function getCookiesHeader() {
  const cookies = await chrome.cookies.getAll({ url: "https://gemini.google.com/" });
  const sorted = [...cookies].sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

// Capture the actual cookie header Chrome sends to lh3.googleusercontent.com
// (chrome.cookies.getAll returns nothing for that domain since cookies are stored
// under .google.com but sent cross-origin by the browser automatically)
let capturedLh3Cookies = "";

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const cookieHeader = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === "cookie",
    );
    if (cookieHeader && cookieHeader.value) {
      capturedLh3Cookies = cookieHeader.value;
    }
  },
  {
    urls: [
      "https://lh3.googleusercontent.com/gg-dl/*",
      "https://lh3.googleusercontent.com/rd-gg/*",
    ],
  },
  ["requestHeaders", "extraHeaders"],
);

// ── Auto-rotate cookies to keep Gemini session alive ──────────────────────
const ROTATION_ALARM_NAME = "nimji-rotate-cookies";

// Set up periodic rotation using chrome.alarms (service workers can't use setInterval)
chrome.alarms.create(ROTATION_ALARM_NAME, { periodInMinutes: 8 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ROTATION_ALARM_NAME) {
    rotateCookies().then((result) => {
      if (!result.ok && result.error.includes("Session expired")) {
        console.error(`[nimji] Session expired: ${result.error}`);
      }
    });
  }
});

// Rotate once on extension load (service worker start)
rotateCookies().catch((err) => console.warn("[nimji] auto-rotate failed:", err?.message || err));

async function getLh3CookiesHeader() {
  return capturedLh3Cookies;
}

/**
 * Calls Google's POST /RotateCookies to rotate __Secure-1PSIDTS freshness cookie.
 * This is the same endpoint Chrome calls internally to keep sessions alive.
 * Returns { ok, rotatedAt, nextRotationMs } or { ok: false, error }.
 */
async function rotateCookies() {
  try {
    // Get all cookies for accounts.google.com
    const cookies = await chrome.cookies.getAll({ url: "https://accounts.google.com/" });
    const cookieHeader = cookies
      .filter((c) => c.name && typeof c.value === "string")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const response = await fetch("https://accounts.google.com/RotateCookies", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://accounts.google.com",
        Referer: "https://accounts.google.com/",
        Cookie: cookieHeader,
      },
      body: JSON.stringify([0, "-0000000000000000000"]),
    });

    if (response.status === 401) {
      return { ok: false, error: "Session expired — __Secure-1PSID is invalid, re-login needed" };
    }

    if (!response.ok) {
      return { ok: false, error: `RotateCookies failed with status ${response.status}` };
    }

    // Parse response to get next rotation interval
    const text = await response.text();
    let nextRotationMs = 600_000; // default 10 minutes
    try {
      const parsed = JSON.parse(text.replace(/^\)\]\}'/, ""));
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const item of parsed) {
          if (Array.isArray(item) && item[0] === "identity.hfcr" && typeof item[1] === "number") {
            nextRotationMs = item[1] * 1000;
            break;
          }
        }
      }
    } catch {
      // ignore parse errors, use default
    }

    // Chrome automatically handles Set-Cookie headers from the response,
    // updating __Secure-1PSIDTS and __Secure-3PSIDTS in the cookie jar.
    // We just need to persist the state.
    const state = await readState();
    const rotatedAt = Date.now();
    await writeState({ ...state, rotatedAt, lastRotationMs: nextRotationMs });

    return { ok: true, rotatedAt, nextRotationMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseStreamRequest(details) {
  try {
    const url = new URL(details.url);
    const path = url.pathname || "";
    const isGeminiRpc = path.includes("/BardFrontendService/StreamGenerate");
    const isBatch = path.includes("/data/batchexecute");

    if (!isGeminiRpc && !isBatch) return null;

    const fSid = normalizeForEnv(url.searchParams.get("f.sid") || "");

    let atToken = "";
    const formData = details.requestBody && details.requestBody.formData;
    if (formData && Array.isArray(formData.at) && formData.at.length > 0) {
      atToken = normalizeForEnv(formData.at[0]);
    }

    return {
      atToken,
      fSid,
      lastUrl: details.url,
      lastCapturedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function updateFromRequest(details) {
  const parsed = parseStreamRequest(details);
  if (!parsed) return;

  const current = await readState();
  const next = {
    atToken: parsed.atToken || current.atToken,
    fSid: parsed.fSid || current.fSid,
    lastCapturedAt: parsed.lastCapturedAt,
    lastUrl: parsed.lastUrl,
  };

  await writeState(next);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    void updateFromRequest(details);
  },
  {
    urls: [
      "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate*",
      "https://gemini.google.com/_/BardChatUi/data/batchexecute*",
    ],
  },
  ["requestBody"],
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "clear-capture") {
    void (async () => {
      await writeState(defaultState());
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "get-export") {
    void (async () => {
      const [cookies, lh3Cookies, state] = await Promise.all([
        getCookiesHeader(),
        getLh3CookiesHeader(),
        readState(),
      ]);
      const atToken = normalizeForEnv(state.atToken);
      const fSid = normalizeForEnv(state.fSid);
      const envBlock = buildEnvBlock(cookies, atToken, fSid, lh3Cookies);
      sendResponse({
        ok: true,
        cookies,
        lh3Cookies,
        atToken,
        fSid,
        envBlock,
        hasAll: Boolean(cookies),
        lastCapturedAt: state.lastCapturedAt,
        lastUrl: state.lastUrl,
      });
    })();
    return true;
  }

  if (message.type === "rotate-now") {
    void (async () => {
      const result = await rotateCookies();
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === "get-rotation-status") {
    void (async () => {
      const state = await readState();
      sendResponse({
        ok: true,
        rotatedAt: state.rotatedAt || 0,
        lastRotationMs: state.lastRotationMs || 600_000,
      });
    })();
    return true;
  }

  return false;
});
