import { readFile, unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { resolveAppHomeDir } from "./paths.js";
import type { ConversationState, SessionStore } from "./types.js";

/** derives 32-byte AES key from ENC_KEY env var via SHA-256, or null if empty */
export function parseEncKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim().length === 0) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

/** AES-256-GCM encrypt → base64 */
export function encryptCookies(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** AES-256-GCM decrypt → plaintext or null */
export function decryptCookies(encrypted: string, key: Buffer): string | null {
  try {
    const buf = Buffer.from(encrypted, "base64");
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    return plaintext;
  } catch {
    return null;
  }
}

const MAX_SESSION_FILE_BYTES = 128 * 1024;
const MAX_CONVERSATION_FIELD_LEN = 4096;
const MAX_ROTATED_COOKIES_LEN = 32 * 1024;

function normalizeConversationState(parsed: unknown): ConversationState {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const o = parsed as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const v = o[key];
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    if (!t || t.length > MAX_CONVERSATION_FIELD_LEN) return undefined;
    return t;
  };
  // rotated cookies can be huge, separate 32KB cap
  const rawCookies =
    typeof o["rotatedCookies"] === "string" ? o["rotatedCookies"].trim() : undefined;
  const rotatedCookies =
    rawCookies && rawCookies.length > 0 && rawCookies.length <= MAX_ROTATED_COOKIES_LEN
      ? rawCookies
      : undefined;

  return {
    conversationId: pick("conversationId"),
    responseId: pick("responseId"),
    choiceId: pick("choiceId"),
    rotatedCookies,
    rotatedAt: typeof o["rotatedAt"] === "number" ? o["rotatedAt"] : undefined,
  };
}

/** File-backed conversation cursor (default path: `<nimji-home>/session.json`). */
export function createSessionStore(filePath?: string): SessionStore {
  const baseDir = resolveAppHomeDir();
  const resolved = filePath ?? path.resolve(baseDir, "session.json");
  const encKey = parseEncKey(process.env.ENC_KEY);

  return {
    path: resolved,

    async load(): Promise<ConversationState> {
      try {
        const buf = await readFile(resolved);
        if (buf.length > MAX_SESSION_FILE_BYTES) return {};
        const raw = buf.toString("utf8");
        const parsed: unknown = JSON.parse(raw);
        return normalizeConversationState(parsed);
      } catch {
        return {};
      }
    },

    async save(state: ConversationState): Promise<void> {
      // don't overwrite encrypted cookies with plaintext from getConversation()
      let rotatedCookies: string | undefined;
      let rotatedAt: number | undefined;
      try {
        const buf = await readFile(resolved);
        if (buf.length <= MAX_SESSION_FILE_BYTES) {
          const parsed: unknown = JSON.parse(buf.toString("utf8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const o = parsed as Record<string, unknown>;
            if (typeof o["rotatedCookies"] === "string") rotatedCookies = o["rotatedCookies"];
            if (typeof o["rotatedAt"] === "number") rotatedAt = o["rotatedAt"];
          }
        }
      } catch {
        /* noop */
      }
      const merged: ConversationState = {
        ...state,
        ...(rotatedCookies !== undefined ? { rotatedCookies, rotatedAt } : {}),
      };
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, JSON.stringify(merged, null, 2), "utf8");
    },

    async clear(): Promise<void> {
      try {
        await unlink(resolved);
      } catch {
        /* noop */
      }
    },

    async loadRotatedCookies(): Promise<{ cookies: string; rotatedAt: number } | null> {
      try {
        const buf = await readFile(resolved);
        if (buf.length > MAX_SESSION_FILE_BYTES) return null;
        const raw = buf.toString("utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const o = parsed as Record<string, unknown>;
        const cookiesRaw = typeof o["rotatedCookies"] === "string" ? o["rotatedCookies"] : null;
        const rotatedAt = typeof o["rotatedAt"] === "number" ? o["rotatedAt"] : null;
        if (!cookiesRaw || rotatedAt === null) return null;
        const cookies = encKey ? (decryptCookies(cookiesRaw, encKey) ?? cookiesRaw) : cookiesRaw;
        return { cookies, rotatedAt };
      } catch {
        return null;
      }
    },

    async saveRotatedCookies(cookies: string, rotatedAt: number): Promise<void> {
      let existing: ConversationState = {};
      try {
        existing = await this.load();
      } catch {
        /* noop */
      }
      const stored = encKey ? encryptCookies(cookies, encKey) : cookies;
      const merged: ConversationState = { ...existing, rotatedCookies: stored, rotatedAt };
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, JSON.stringify(merged, null, 2), "utf8");
    },
  };
}
