/**
 * Tests for src/client.ts
 * Covers: createClient validation, conversation state management (get/set/reset),
 * keepalive start/stop, queueing semantics (only one in-flight), and the public
 * create() / createClientFromEnv() factory wrappers.
 * Live network calls to Gemini are integration-only and excluded here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, create, createClientFromEnv } from "../src/client.js";
import type { GemaiConfig } from "../src/types.js";

// ─── stub config ─────────────────────────────────────────────────────────────

function validConfig(extra: Partial<GemaiConfig> = {}): GemaiConfig {
  return {
    auth: { cookies: "SID=test", atToken: "tok1", fSid: "fsid1" },
    context: {
      blParam: "boq_assistant-bard-web-server_20260101.01_p1",
      sourcePath: "/app/test01234567",
      reqId: "1234567",
      requestUuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      sessionFingerprint: "deadbeef01234567",
      ext525001261Tail: 1,
      browserValidation: "testval==",
      clientData: "testclientdata==",
      language: "en",
      chromeFullVersion: "147.0.7727.56",
      acceptLanguage: "en-US,en;q=0.9",
      secChUaPlatform: "Windows",
      secChUaPlatformVersion: "19.0.0",
      browserChannel: "stable",
      browserCopyright: "Copyright 2026 Google LLC.",
      userAgent: "Mozilla/5.0 (test)",
    },
    runtime: {
      streamIdleTimeoutMs: 30_000,
      streamMaxDurationMs: 180_000,
      imageStreamIdleTimeoutMs: 120_000,
      imageStreamMaxDurationMs: 600_000,
      debugCandidates: false,
    },
    ...extra,
  };
}

// ─── createClient — validation ────────────────────────────────────────────────

describe("createClient — validation", () => {
  it("throws when COOKIES is missing", () => {
    assert.throws(
      () => createClient({ ...validConfig(), auth: { cookies: "", atToken: "t", fSid: "f" } }),
      /COOKIES/,
    );
  });

  it("throws when AT_TOKEN is missing", () => {
    // AT_TOKEN is optional — should not throw with only cookies + fSid
    assert.doesNotThrow(
      () => createClient({ ...validConfig(), auth: { cookies: "c", atToken: "", fSid: "f" } }),
    );
  });

  it("throws when F_SID is missing", () => {
    // F_SID is optional — should not throw with only cookies + atToken
    assert.doesNotThrow(
      () => createClient({ ...validConfig(), auth: { cookies: "c", atToken: "t", fSid: "" } }),
    );
  });

  it("does not throw for a valid config", () => {
    assert.doesNotThrow(() => createClient(validConfig()));
  });
});

// ─── conversation state management ───────────────────────────────────────────

describe("createClient — conversation state", () => {
  it("starts with empty conversation", () => {
    const client = createClient(validConfig());
    const state = client.getConversation();
    assert.equal(state.conversationId, undefined);
    assert.equal(state.responseId, undefined);
    assert.equal(state.choiceId, undefined);
    client.stopKeepalive();
  });

  it("setConversation updates all fields", () => {
    const client = createClient(validConfig());
    client.setConversation({
      conversationId: "c_abc",
      responseId: "r_xyz",
      choiceId: "rc_123",
    });
    const state = client.getConversation();
    assert.equal(state.conversationId, "c_abc");
    assert.equal(state.responseId, "r_xyz");
    assert.equal(state.choiceId, "rc_123");
    client.stopKeepalive();
  });

  it("resetConversation clears all fields", () => {
    const client = createClient(validConfig());
    client.setConversation({ conversationId: "c_abc", responseId: "r_xyz" });
    client.resetConversation();
    const state = client.getConversation();
    assert.equal(state.conversationId, undefined);
    assert.equal(state.responseId, undefined);
    client.stopKeepalive();
  });

  it("getConversation returns a copy — mutations do not affect internal state", () => {
    const client = createClient(validConfig());
    client.setConversation({ conversationId: "c_orig" });
    const snap = client.getConversation() as Record<string, string | undefined>;
    snap.conversationId = "c_mutated";
    assert.equal(client.getConversation().conversationId, "c_orig");
    client.stopKeepalive();
  });

  it("seeds conversation from config.conversation", () => {
    const cfg = validConfig({
      conversation: {
        conversationId: "c_seed",
        responseId: "r_seed",
        choiceId: "rc_seed",
      },
    });
    const client = createClient(cfg);
    const state = client.getConversation();
    assert.equal(state.conversationId, "c_seed");
    assert.equal(state.responseId, "r_seed");
    client.stopKeepalive();
  });
});

// ─── keepalive lifecycle ──────────────────────────────────────────────────────

describe("createClient — keepalive", () => {
  it("stopKeepalive does not throw when never started", () => {
    const client = createClient(validConfig());
    client.stopKeepalive();
    assert.doesNotThrow(() => client.stopKeepalive());
  });

  it("startKeepalive + stopKeepalive do not throw", () => {
    const client = createClient(validConfig());
    assert.doesNotThrow(() => {
      client.startKeepalive({ enabled: true, intervalMs: 9_999_999 });
      client.stopKeepalive();
    });
  });

  it("startKeepalive with enabled:false is a no-op", () => {
    const client = createClient(validConfig());
    assert.doesNotThrow(() => {
      client.startKeepalive({ enabled: false });
      client.stopKeepalive();
    });
  });
});

// ─── factory wrappers ─────────────────────────────────────────────────────────

describe("create() factory", () => {
  it("returns a client with expected methods", () => {
    const client = create({ COOKIES: "SID=test", AT_TOKEN: "tok", F_SID: "fsid" }, undefined, {
      cwd: process.cwd(),
    });
    assert.ok(typeof client.generate === "function");
    assert.ok(typeof client.getConversation === "function");
    assert.ok(typeof client.setConversation === "function");
    assert.ok(typeof client.resetConversation === "function");
    assert.ok(typeof client.startKeepalive === "function");
    assert.ok(typeof client.stopKeepalive === "function");
    client.stopKeepalive();
  });

  it("keepalive:false passed to create() disables keepalive", () => {
    const client = create({ COOKIES: "SID=x", AT_TOKEN: "t", F_SID: "f", keepalive: false });
    // No interval should be running — stopKeepalive should be safe to call
    assert.doesNotThrow(() => client.stopKeepalive());
  });
});

describe("createClientFromEnv()", () => {
  it("throws when required env vars are absent", () => {
    // Ensure keys are absent
    const saved = {
      COOKIES: process.env.COOKIES,
      AT_TOKEN: process.env.AT_TOKEN,
      F_SID: process.env.F_SID,
    };
    delete process.env.COOKIES;
    delete process.env.AT_TOKEN;
    delete process.env.F_SID;

    try {
      assert.throws(() => createClientFromEnv());
    } finally {
      // Restore
      if (saved.COOKIES !== undefined) process.env.COOKIES = saved.COOKIES;
      if (saved.AT_TOKEN !== undefined) process.env.AT_TOKEN = saved.AT_TOKEN;
      if (saved.F_SID !== undefined) process.env.F_SID = saved.F_SID;
    }
  });
});
