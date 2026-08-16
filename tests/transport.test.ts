/**
 * Tests for src/transport.ts
 * Covers: buildStreamGeneratePath, buildSecChUaHeaders, buildPayload (text + image attachment),
 * buildBatchexecutePath, buildBatchexecuteKeepaliveBody, parseStreamChunks, readStreamWithTimeouts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStreamGeneratePath,
  buildSecChUaHeaders,
  buildPayload,
  buildBatchexecutePath,
  buildBatchexecuteKeepaliveBody,
  parseStreamChunks,
  readStreamWithTimeouts,
  chromeMajorFromFullVersion,
  parseCookies,
  serializeCookies,
  updateCookieString,
  isSessionExpiredResponse,
} from "../src/transport.js";
import type { GemaiConfig } from "../src/types.js";

// ─── minimal stub config ────────────────────────────────────────────────────

function makeConfig(overrides: Partial<GemaiConfig["context"]> = {}): GemaiConfig {
  return {
    auth: { cookies: "SID=abc", atToken: "tok123", fSid: "fsid_x" },
    context: {
      blParam: "boq_assistant-bard-web-server_20260101.01_p1",
      sourcePath: "/app/testhash0001",
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
      ...overrides,
    },
    runtime: {
      streamIdleTimeoutMs: 30_000,
      streamMaxDurationMs: 180_000,
      imageStreamIdleTimeoutMs: 120_000,
      imageStreamMaxDurationMs: 600_000,
      debugCandidates: false,
    },
  };
}

// ─── chromeMajorFromFullVersion ───────────────────────────────────────────────

describe("chromeMajorFromFullVersion", () => {
  it("extracts leading digits", () => {
    assert.equal(chromeMajorFromFullVersion("147.0.7727.56"), "147");
  });

  it("trims whitespace before parsing", () => {
    assert.equal(chromeMajorFromFullVersion("  148.0.1.2 "), "148");
  });

  it("falls back to 147 on non-numeric input", () => {
    assert.equal(chromeMajorFromFullVersion("nope"), "147");
  });
});

// ─── buildStreamGeneratePath ─────────────────────────────────────────────────

describe("buildStreamGeneratePath", () => {
  it("contains the RPC path prefix", () => {
    const cfg = makeConfig();
    const path = buildStreamGeneratePath(cfg);
    assert.ok(
      path.startsWith("/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"),
    );
  });

  it("encodes bl param", () => {
    const cfg = makeConfig();
    const p = buildStreamGeneratePath(cfg);
    assert.ok(p.includes("bl=boq_assistant-bard-web-server_20260101.01_p1"));
  });

  it("encodes f.sid", () => {
    const p = buildStreamGeneratePath(makeConfig());
    assert.ok(p.includes("f.sid=fsid_x"));
  });

  it("ends with &rt=c", () => {
    assert.ok(buildStreamGeneratePath(makeConfig()).endsWith("&rt=c"));
  });
});

// ─── buildSecChUaHeaders ─────────────────────────────────────────────────────

describe("buildSecChUaHeaders", () => {
  it("contains expected keys", () => {
    const h = buildSecChUaHeaders(makeConfig());
    const keys = Object.keys(h);
    assert.ok(keys.includes("sec-ch-ua"));
    assert.ok(keys.includes("sec-ch-ua-platform"));
    assert.ok(keys.includes("sec-ch-ua-full-version"));
    assert.ok(keys.includes("sec-ch-ua-mobile"));
  });

  it("embeds major version in sec-ch-ua", () => {
    const h = buildSecChUaHeaders(makeConfig());
    assert.ok(h["sec-ch-ua"].includes("147"));
  });

  it("quotes platform correctly", () => {
    const h = buildSecChUaHeaders(makeConfig());
    assert.equal(h["sec-ch-ua-platform"], '"Windows"');
  });

  it("sets mobile to ?0", () => {
    assert.equal(buildSecChUaHeaders(makeConfig())["sec-ch-ua-mobile"], "?0");
  });
});

// ─── buildPayload ─────────────────────────────────────────────────────────────

describe("buildPayload — text-only", () => {
  it("produces a URL-encoded string", () => {
    const body = buildPayload(makeConfig(), "hello world");
    assert.ok(body.includes("f.req="));
    assert.ok(body.includes("at=tok123"));
  });

  it("ends with &", () => {
    assert.ok(buildPayload(makeConfig(), "test").endsWith("&"));
  });

  it("encodes the prompt inside f.req", () => {
    const body = buildPayload(makeConfig(), "hello world");
    // f.req is [null, innerJsonString] — URLSearchParams encodes spaces as +
    const raw = body.split("f.req=")[1]!.split("&")[0]!.replace(/\+/g, "%20");
    const outerDecoded = decodeURIComponent(raw);
    const outer = JSON.parse(outerDecoded) as [null, string];
    const inner = JSON.parse(outer[1]) as unknown[];
    // inner[0] is the prompt slot: [prompt, 0, null, ...]
    const promptSlot = inner[0] as unknown[];
    assert.equal(promptSlot[0], "hello world");
  });

  it("embeds conversationId when provided", () => {
    const cfg = makeConfig();
    const conv = { conversationId: "c_abc", responseId: "r_xyz", choiceId: "rc_123" };
    const body = buildPayload(cfg, "follow-up", conv);
    const outerDecoded = decodeURIComponent(body.split("f.req=")[1]!.split("&")[0]!);
    const outer = JSON.parse(outerDecoded) as [null, string];
    const inner = JSON.parse(outer[1]) as unknown[];
    // inner[2] is the conversation slot
    const convSlot = inner[2] as string[];
    assert.ok(convSlot[0] === "c_abc");
    assert.ok(convSlot[1] === "r_xyz");
  });

  it("uses empty strings for missing conversation fields", () => {
    const body = buildPayload(makeConfig(), "fresh", {});
    const outerDecoded = decodeURIComponent(body.split("f.req=")[1]!.split("&")[0]!);
    const outer = JSON.parse(outerDecoded) as [null, string];
    const inner = JSON.parse(outer[1]) as unknown[];
    const convSlot = inner[2] as string[];
    assert.equal(convSlot[0], "");
    assert.equal(convSlot[1], "");
  });

  it("embeds requestUuid in payload", () => {
    const body = buildPayload(makeConfig(), "test");
    const outerDecoded = decodeURIComponent(body.split("f.req=")[1]!.split("&")[0]!);
    // The UUID lives inside the inner JSON string
    assert.ok(outerDecoded.includes("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"));
  });
});

describe("buildPayload — image attachment", () => {
  it("embeds tokenPath and mimeType when imageAttachment provided", () => {
    const att = {
      tokenPath: "/contrib_service/ttl_1d/abc123xyz",
      mimeType: "image/png",
      fileName: "photo.png",
    };
    const body = buildPayload(makeConfig(), "describe this", undefined, att);
    const outerDecoded = decodeURIComponent(body.split("f.req=")[1]!.split("&")[0]!);
    const outer = JSON.parse(outerDecoded) as [null, string];
    const inner = JSON.parse(outer[1]) as unknown[];
    const promptSlot = inner[0] as unknown[];
    // promptSlot[3] = [[[tokenPath, 1, null, mimeType], fileName]]
    const attachContainer = promptSlot[3] as unknown[][][];
    const attachInner = attachContainer[0]![0]! as unknown[];
    assert.equal(attachInner[0], "/contrib_service/ttl_1d/abc123xyz");
    assert.equal(attachInner[3], "image/png");
    const attachFileName = attachContainer[0]![1];
    assert.equal(attachFileName, "photo.png");
  });

  it("differs structurally from a text-only payload", () => {
    const att = {
      tokenPath: "/contrib_service/ttl_1d/token",
      mimeType: "image/jpeg",
      fileName: "snap.jpg",
    };
    const withImg = buildPayload(makeConfig(), "describe", undefined, att);
    const noImg = buildPayload(makeConfig(), "describe");
    assert.notEqual(withImg, noImg);
  });

  it("still includes at token with image attachment", () => {
    const att = {
      tokenPath: "/contrib_service/ttl_1d/t",
      mimeType: "image/webp",
      fileName: "img.webp",
    };
    const body = buildPayload(makeConfig(), "what is this", undefined, att);
    assert.ok(body.includes("at=tok123"));
  });
});

// ─── buildBatchexecutePath ───────────────────────────────────────────────────

describe("buildBatchexecutePath", () => {
  it("contains rpcids param", () => {
    const cfg = makeConfig();
    const p = buildBatchexecutePath(cfg);
    assert.ok(p.includes("rpcids="));
  });

  it("contains batchexecute in path", () => {
    assert.ok(buildBatchexecutePath(makeConfig()).includes("batchexecute"));
  });
});

// ─── buildBatchexecuteKeepaliveBody ──────────────────────────────────────────

describe("buildBatchexecuteKeepaliveBody", () => {
  it("produces a string containing f.req and at", () => {
    const cfg: GemaiConfig = {
      ...makeConfig(),
      keepalive: { rpcId: "aPya6c" },
    };
    const body = buildBatchexecuteKeepaliveBody(cfg);
    assert.ok(body.includes("f.req="));
    assert.ok(body.includes("at=tok123"));
  });

  it("uses fReqOuterJson when provided", () => {
    const outerJson = JSON.stringify([[["myRpc", "[]", null, "generic"]]]);
    const cfg: GemaiConfig = {
      ...makeConfig(),
      keepalive: { rpcId: "myRpc", fReqOuterJson: outerJson },
    };
    const body = buildBatchexecuteKeepaliveBody(cfg);
    const decoded = decodeURIComponent(body.split("f.req=")[1]!.split("&")[0]!);
    assert.ok(decoded.includes("myRpc"));
  });

  it("throws on invalid innerPayloadJson", () => {
    const cfg: GemaiConfig = {
      ...makeConfig(),
      keepalive: { rpcId: "aPya6c", innerPayloadJson: "not-json{{{" },
    };
    assert.throws(() => buildBatchexecuteKeepaliveBody(cfg), /KEEPALIVE_INNER_PAYLOAD/);
  });
});

// ─── parseStreamChunks ───────────────────────────────────────────────────────

describe("parseStreamChunks", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(parseStreamChunks(""), []);
  });

  it("returns empty array for whitespace-only input", () => {
    assert.deepEqual(parseStreamChunks("   \n  "), []);
  });

  it("parses a single length-prefixed JSON chunk", () => {
    const json = JSON.stringify([["hello"]]);
    const raw = `\n${json.length}\n${json}`;
    const result = parseStreamChunks(raw);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], [["hello"]]);
  });

  it("parses multiple consecutive chunks", () => {
    const j1 = JSON.stringify(["chunk1"]);
    const j2 = JSON.stringify(["chunk2"]);
    const raw = `\n${j1.length}\n${j1}\n${j2.length}\n${j2}`;
    const result = parseStreamChunks(raw);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], ["chunk1"]);
    assert.deepEqual(result[1], ["chunk2"]);
  });

  it("strips leading )]}' prefix", () => {
    const json = JSON.stringify(["ok"]);
    const raw = `)]}'  \n${json.length}\n${json}`;
    const result = parseStreamChunks(raw);
    assert.ok(result.length >= 1);
  });

  it("keeps non-JSON chunks as raw strings", () => {
    const raw = `\n5\nhello`;
    const result = parseStreamChunks(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0], "hello");
  });
});

// ─── readStreamWithTimeouts ──────────────────────────────────────────────────

describe("readStreamWithTimeouts", () => {
  async function* makeStream(chunks: string[]): AsyncIterable<Uint8Array> {
    for (const c of chunks) yield Buffer.from(c, "utf8");
  }

  it("collects all chunks from a fast stream", async () => {
    const stream = makeStream(["foo", "bar", "baz"]);
    const buf = await readStreamWithTimeouts(stream, 5_000, 30_000);
    assert.equal(buf.toString("utf8"), "foobarbaz");
  });

  it("returns empty buffer for empty stream", async () => {
    const buf = await readStreamWithTimeouts(makeStream([]), 1_000, 5_000);
    assert.equal(buf.length, 0);
  });

  it("fires onMax and stops when wall-clock exceeded", async () => {
    // Create a stream that yields one chunk then hangs forever
    async function* slowStream(): AsyncIterable<Uint8Array> {
      yield Buffer.from("first");
      await new Promise<void>(() => {}); // never resolves
    }
    let maxFired = false;
    const buf = await readStreamWithTimeouts(
      slowStream(),
      9_999_999, // idle: very long — should never trigger
      500, // max: 500 ms wall-clock cap — should trigger first
      undefined,
      () => {
        maxFired = true;
      },
    );
    assert.ok(maxFired, "onMax should have fired");
    assert.equal(buf.toString("utf8"), "first");
  });

  it("fires onIdle when stream goes quiet", async () => {
    async function* idleStream(): AsyncIterable<Uint8Array> {
      yield Buffer.from("data");
      await new Promise<void>(() => {}); // hangs after first chunk
    }
    let idleFired = false;
    await readStreamWithTimeouts(
      idleStream(),
      80, // idle timeout: 80 ms
      2_000,
      () => {
        idleFired = true;
      },
    );
    assert.ok(idleFired, "onIdle should have fired");
  });
});

// ─── parseCookies ───────────────────────────────────────────────────────────

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    const map = parseCookies("SID=abc123");
    assert.equal(map.get("SID"), "abc123");
    assert.equal(map.size, 1);
  });

  it("parses multiple cookies separated by semicolons", () => {
    const map = parseCookies("SID=abc; HSID=def; NID=ghi");
    assert.equal(map.size, 3);
    assert.equal(map.get("SID"), "abc");
    assert.equal(map.get("HSID"), "def");
    assert.equal(map.get("NID"), "ghi");
  });

  it("trims whitespace around names and values", () => {
    const map = parseCookies(" SID = abc ; HSID = def ");
    assert.equal(map.get("SID"), "abc");
    assert.equal(map.get("HSID"), "def");
  });

  it("handles empty string", () => {
    const map = parseCookies("");
    assert.equal(map.size, 0);
  });

  it("handles cookies with = in value", () => {
    const map = parseCookies("token=abc=def=ghi");
    assert.equal(map.get("token"), "abc=def=ghi");
  });

  it("handles trailing semicolon", () => {
    const map = parseCookies("SID=abc;");
    assert.equal(map.get("SID"), "abc");
    assert.equal(map.size, 1);
  });

  it("skips empty entries from double semicolons", () => {
    const map = parseCookies("SID=abc;; HSID=def");
    assert.equal(map.size, 2);
    assert.equal(map.get("SID"), "abc");
    assert.equal(map.get("HSID"), "def");
  });
});

describe("serializeCookies", () => {
  it("serializes a single entry", () => {
    const map = new Map([["SID", "abc"]]);
    assert.equal(serializeCookies(map), "SID=abc");
  });

  it("serializes multiple entries with semicolon+space", () => {
    const map = new Map([
      ["SID", "abc"],
      ["HSID", "def"],
    ]);
    assert.equal(serializeCookies(map), "SID=abc; HSID=def");
  });

  it("returns empty string for empty map", () => {
    assert.equal(serializeCookies(new Map()), "");
  });

  it("preserves insertion order", () => {
    const map = new Map([
      ["Z", "1"],
      ["A", "2"],
      ["M", "3"],
    ]);
    assert.equal(serializeCookies(map), "Z=1; A=2; M=3");
  });
});

describe("updateCookieString", () => {
  it("adds a new cookie to an existing string", () => {
    const result = updateCookieString("SID=abc", new Map([["HSID", "def"]]));
    assert.ok(result.includes("SID=abc"));
    assert.ok(result.includes("HSID=def"));
  });

  it("replaces an existing cookie value", () => {
    const result = updateCookieString("SID=old; HSID=def", new Map([["SID", "new"]]));
    assert.ok(result.includes("SID=new"));
    assert.ok(!result.includes("SID=old"));
    assert.ok(result.includes("HSID=def"));
  });

  it("handles empty original string", () => {
    const result = updateCookieString("", new Map([["SID", "abc"]]));
    assert.equal(result, "SID=abc");
  });

  it("handles empty updates map", () => {
    const result = updateCookieString("SID=abc", new Map());
    assert.equal(result, "SID=abc");
  });

  it("updates multiple cookies at once", () => {
    const result = updateCookieString(
      "SID=old1; HSID=old2",
      new Map([
        ["SID", "new1"],
        ["HSID", "new2"],
      ]),
    );
    assert.ok(result.includes("SID=new1"));
    assert.ok(result.includes("HSID=new2"));
    assert.ok(!result.includes("old1"));
    assert.ok(!result.includes("old2"));
  });
});

describe("isSessionExpiredResponse", () => {
  it("returns false for valid batchexecute response with )]}' prefix", () => {
    assert.equal(isSessionExpiredResponse(")]}'[[1,2,3]"), false);
  });

  it("returns false for valid response starting with digit", () => {
    assert.equal(isSessionExpiredResponse("42\nsome data"), false);
  });

  it("returns true for HTML DOCTYPE response", () => {
    assert.equal(
      isSessionExpiredResponse("<!DOCTYPE html><html><body>Sign in</body></html>"),
      true,
    );
  });

  it("returns true for html tag response", () => {
    assert.equal(isSessionExpiredResponse("<html>login page</html>"), true);
  });

  it("returns true for accounts.google.com redirect", () => {
    assert.equal(
      isSessionExpiredResponse('window.location="https://accounts.google.com/ServiceLogin"'),
      true,
    );
  });

  it("returns false for empty string", () => {
    assert.equal(isSessionExpiredResponse(""), false);
  });

  it("returns false for plain text", () => {
    assert.equal(isSessionExpiredResponse("just some text"), false);
  });
});
