/**
 * Tests for src/session.ts
 * Covers: createSessionStore — load, save, clear, field normalization, size cap.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionStore, parseEncKey, encryptCookies, decryptCookies } from "../src/session.js";

let tmpDir: string;
let sessionFile: string;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `nimji-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });
  sessionFile = path.join(tmpDir, "session.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createSessionStore — load", () => {
  it("returns empty state when file does not exist", async () => {
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.deepEqual(state, {});
  });

  it("loads conversationId, responseId, choiceId", async () => {
    const data = {
      conversationId: "c_abc123",
      responseId: "r_xyz789",
      choiceId: "rc_def456",
    };
    await writeFile(sessionFile, JSON.stringify(data), "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.equal(state.conversationId, "c_abc123");
    assert.equal(state.responseId, "r_xyz789");
    assert.equal(state.choiceId, "rc_def456");
  });

  it("ignores unknown fields in the file", async () => {
    const data = { conversationId: "c_x", extraField: "ignored", count: 99 };
    await writeFile(sessionFile, JSON.stringify(data), "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.equal(state.conversationId, "c_x");
    assert.equal((state as Record<string, unknown>).extraField, undefined);
  });

  it("returns empty state for invalid JSON", async () => {
    await writeFile(sessionFile, "not json {{{", "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.deepEqual(state, {});
  });

  it("returns empty state when file exceeds size cap", async () => {
    // Write > 128 KiB (must exceed MAX_SESSION_FILE_BYTES = 128 * 1024)
    const bigJson = JSON.stringify({ conversationId: "c_" + "x".repeat(140_000) });
    await writeFile(sessionFile, bigJson, "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.deepEqual(state, {});
  });

  it("trims whitespace from field values", async () => {
    await writeFile(
      sessionFile,
      JSON.stringify({ conversationId: "  c_trimmed  ", responseId: " r_trim " }),
      "utf8",
    );
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.equal(state.conversationId, "c_trimmed");
    assert.equal(state.responseId, "r_trim");
  });

  it("ignores fields exceeding max field length", async () => {
    const long = "c_" + "a".repeat(5000);
    await writeFile(sessionFile, JSON.stringify({ conversationId: long }), "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.equal(state.conversationId, undefined);
  });

  it("returns empty state for non-object JSON (array)", async () => {
    await writeFile(sessionFile, JSON.stringify([1, 2, 3]), "utf8");
    const store = createSessionStore(sessionFile);
    const state = await store.load();
    assert.deepEqual(state, {});
  });
});

describe("createSessionStore — save", () => {
  it("creates the file with correct JSON", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_save1", responseId: "r_save1" });
    const raw = await readFile(sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.conversationId, "c_save1");
    assert.equal(parsed.responseId, "r_save1");
  });

  it("creates parent directories if needed", async () => {
    const deepFile = path.join(tmpDir, "deep", "nested", "session.json");
    const store = createSessionStore(deepFile);
    await store.save({ conversationId: "c_deep" });
    assert.ok(existsSync(deepFile));
  });

  it("overwrites existing session on save", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_old" });
    await store.save({ conversationId: "c_new" });
    const raw = await readFile(sessionFile, "utf8");
    assert.ok(raw.includes("c_new"));
    assert.ok(!raw.includes("c_old"));
  });

  it("round-trips through save → load", async () => {
    const store = createSessionStore(sessionFile);
    const original = {
      conversationId: "c_roundtrip",
      responseId: "r_roundtrip",
      choiceId: "rc_roundtrip",
    };
    await store.save(original);
    const loaded = await store.load();
    assert.equal(loaded.conversationId, original.conversationId);
    assert.equal(loaded.responseId, original.responseId);
    assert.equal(loaded.choiceId, original.choiceId);
  });
});

describe("createSessionStore — clear", () => {
  it("removes the session file", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_to_delete" });
    assert.ok(existsSync(sessionFile));
    await store.clear();
    assert.ok(!existsSync(sessionFile));
  });

  it("does not throw when file does not exist", async () => {
    const store = createSessionStore(sessionFile);
    await assert.doesNotReject(() => store.clear());
  });

  it("after clear, load returns empty state", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_pre_clear" });
    await store.clear();
    const state = await store.load();
    assert.deepEqual(state, {});
  });
});

describe("createSessionStore — path property", () => {
  it("exposes the resolved file path", () => {
    const store = createSessionStore(sessionFile);
    assert.equal(store.path, sessionFile);
  });
});

describe("createSessionStore — loadRotatedCookies", () => {
  it("returns null when no rotated cookies exist", async () => {
    const store = createSessionStore(sessionFile);
    const result = await store.loadRotatedCookies();
    assert.equal(result, null);
  });

  it("returns null for non-existent file", async () => {
    const nonExistent = path.join(tmpDir, "nope.json");
    const store = createSessionStore(nonExistent);
    const result = await store.loadRotatedCookies();
    assert.equal(result, null);
  });

  it("loads rotated cookies and rotatedAt from file", async () => {
    const data = {
      conversationId: "c_test",
      rotatedCookies: "SID=new; HSID=new2",
      rotatedAt: 1700000000000,
    };
    await writeFile(sessionFile, JSON.stringify(data), "utf8");
    const store = createSessionStore(sessionFile);
    const result = await store.loadRotatedCookies();
    assert.deepEqual(result, {
      cookies: "SID=new; HSID=new2",
      rotatedAt: 1700000000000,
    });
  });

  it("returns null when rotatedCookies field is missing", async () => {
    const data = { conversationId: "c_no_cookies" };
    await writeFile(sessionFile, JSON.stringify(data), "utf8");
    const store = createSessionStore(sessionFile);
    const result = await store.loadRotatedCookies();
    assert.equal(result, null);
  });
});

describe("createSessionStore — saveRotatedCookies", () => {
  it("saves rotated cookies to a new file", async () => {
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=fresh; HSID=fresh2", 1700000000000);
    const raw = await readFile(sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.rotatedCookies, "SID=fresh; HSID=fresh2");
    assert.equal(parsed.rotatedAt, 1700000000000);
  });

  it("merges with existing conversation state", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_existing", responseId: "r_1" });
    await store.saveRotatedCookies("SID=fresh", 1700000000000);
    const raw = await readFile(sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.conversationId, "c_existing");
    assert.equal(parsed.responseId, "r_1");
    assert.equal(parsed.rotatedCookies, "SID=fresh");
    assert.equal(parsed.rotatedAt, 1700000000000);
  });

  it("round-trips through saveRotatedCookies → loadRotatedCookies", async () => {
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=rt; HSID=rt2", 1700000000000);
    const loaded = await store.loadRotatedCookies();
    assert.deepEqual(loaded, {
      cookies: "SID=rt; HSID=rt2",
      rotatedAt: 1700000000000,
    });
  });

  it("overwrites previous rotated cookies", async () => {
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=old", 1700000000000);
    await store.saveRotatedCookies("SID=new", 1700000001000);
    const loaded = await store.loadRotatedCookies();
    assert.equal(loaded?.cookies, "SID=new");
    assert.equal(loaded?.rotatedAt, 1700000001000);
  });
});

// ---------------------------------------------------------------------------
// parseEncKey
// ---------------------------------------------------------------------------

describe("parseEncKey", () => {
  it("returns null for undefined", () => {
    assert.equal(parseEncKey(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseEncKey(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(parseEncKey("   "), null);
  });

  it("returns a 32-byte buffer for any non-empty string", () => {
    const buf = parseEncKey("my-secret-passphrase");
    assert.ok(buf);
    assert.equal(buf.length, 32);
  });

  it("derives deterministic key from same input", () => {
    const a = parseEncKey("same-input");
    const b = parseEncKey("same-input");
    assert.ok(a && b);
    assert.deepEqual(a, b);
  });

  it("derives different keys from different inputs", () => {
    const a = parseEncKey("key-one");
    const b = parseEncKey("key-two");
    assert.ok(a && b);
    assert.notDeepEqual(a, b);
  });

  it("handles special characters and unicode", () => {
    const buf = parseEncKey("p@$$w0rd! 日本語 🔑");
    assert.ok(buf);
    assert.equal(buf.length, 32);
  });
});

// ---------------------------------------------------------------------------
// encryptCookies / decryptCookies round-trip
// ---------------------------------------------------------------------------

describe("encryptCookies / decryptCookies", () => {
  const key = Buffer.alloc(32, 0x42); // deterministic test key

  it("round-trips plaintext through encrypt → decrypt", () => {
    const plaintext = "SID=abc; HSID=def123";
    const encrypted = encryptCookies(plaintext, key);
    assert.notEqual(encrypted, plaintext);
    const decrypted = decryptCookies(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("returns different ciphertext each time (random IV)", () => {
    const plaintext = "SID=same";
    const a = encryptCookies(plaintext, key);
    const b = encryptCookies(plaintext, key);
    assert.notEqual(a, b);
    assert.equal(decryptCookies(a, key), plaintext);
    assert.equal(decryptCookies(b, key), plaintext);
  });

  it("returns null when decrypting with wrong key", () => {
    const wrongKey = Buffer.alloc(32, 0x99);
    const encrypted = encryptCookies("secret", key);
    assert.equal(decryptCookies(encrypted, wrongKey), null);
  });

  it("returns null for tampered ciphertext", () => {
    const encrypted = encryptCookies("data", key);
    const buf = Buffer.from(encrypted, "base64");
    buf[buf.length - 1] ^= 0xff; // flip last byte
    assert.equal(decryptCookies(buf.toString("base64"), key), null);
  });

  it("returns null for garbage base64", () => {
    assert.equal(decryptCookies("not-valid-base64!!!", key), null);
  });

  it("returns null for too-short base64", () => {
    assert.equal(decryptCookies(Buffer.alloc(10).toString("base64"), key), null);
  });
});

// ---------------------------------------------------------------------------
// Session store integration with encryption
// ---------------------------------------------------------------------------

describe("createSessionStore — encrypted rotated cookies", () => {
  beforeEach(async () => {
    process.env.ENC_KEY = "test-secret-key-123";
  });

  afterEach(() => {
    delete process.env.ENC_KEY;
  });

  it("stores encrypted data in file, decrypts on load", async () => {
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=enc_test", 1700000000000);

    // Raw file should NOT contain plaintext
    const raw = await readFile(sessionFile, "utf8");
    assert.ok(!raw.includes("SID=enc_test"));

    // loadRotatedCookies should decrypt
    const loaded = await store.loadRotatedCookies();
    assert.equal(loaded?.cookies, "SID=enc_test");
    assert.equal(loaded?.rotatedAt, 1700000000000);
  });

  it("falls back to plaintext when ENC_KEY is not set", async () => {
    delete process.env.ENC_KEY;
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=plain", 1700000000000);

    const raw = await readFile(sessionFile, "utf8");
    assert.ok(raw.includes("SID=plain"));
  });

  it("falls back to plaintext when ENC_KEY is empty", async () => {
    process.env.ENC_KEY = "   ";
    const store = createSessionStore(sessionFile);
    await store.saveRotatedCookies("SID=empty_key", 1700000000000);

    const raw = await readFile(sessionFile, "utf8");
    assert.ok(raw.includes("SID=empty_key"));
  });

  it("merges encrypted cookies with existing conversation state", async () => {
    const store = createSessionStore(sessionFile);
    await store.save({ conversationId: "c_keep" });
    await store.saveRotatedCookies("SID=merged", 1700000000000);

    const raw = await readFile(sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.conversationId, "c_keep");

    const loaded = await store.loadRotatedCookies();
    assert.equal(loaded?.cookies, "SID=merged");
  });
});
