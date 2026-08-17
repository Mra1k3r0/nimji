/**
 * Tests for src/config.ts
 * Covers: makePick, mergeProjectConfigIntoEnv, loadConfigFromEnv, validateConfig,
 * resolveBlParam, keepalive config loading.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  makePick,
  loadConfigFromEnv,
  validateConfig,
  resetProjectConfigMergeCache,
  mergeProjectConfigIntoEnv,
} from "../src/config.js";

// ─── makePick ────────────────────────────────────────────────────────────────

describe("makePick", () => {
  it("returns env value by default", () => {
    process.env.__TEST_PICK_KEY__ = "from-env";
    const pick = makePick();
    assert.equal(pick("__TEST_PICK_KEY__"), "from-env");
    delete process.env.__TEST_PICK_KEY__;
  });

  it("override wins over env", () => {
    process.env.__TEST_PICK_KEY2__ = "from-env";
    const pick = makePick({ __TEST_PICK_KEY2__: "from-override" });
    assert.equal(pick("__TEST_PICK_KEY2__"), "from-override");
    delete process.env.__TEST_PICK_KEY2__;
  });

  it("uses fallback when key absent from env and overrides", () => {
    const pick = makePick();
    assert.equal(pick("__MISSING_KEY_XYZZY__", "fallback"), "fallback");
  });

  it("converts boolean override to '1'/'0'", () => {
    const pick = makePick({ FLAG_TRUE: true, FLAG_FALSE: false });
    assert.equal(pick("FLAG_TRUE"), "1");
    assert.equal(pick("FLAG_FALSE"), "0");
  });

  it("converts number override to string", () => {
    const pick = makePick({ TIMEOUT: 5000 });
    assert.equal(pick("TIMEOUT"), "5000");
  });

  it("treats undefined override as env passthrough", () => {
    process.env.__UNDEF_TEST__ = "env-val";
    const pick = makePick({ __UNDEF_TEST__: undefined });
    assert.equal(pick("__UNDEF_TEST__"), "env-val");
    delete process.env.__UNDEF_TEST__;
  });
});

// ─── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  function minimalConfig() {
    return loadConfigFromEnv({
      overrides: {
        COOKIES: "SID=test",
        AT_TOKEN: "at_tok",
        F_SID: "f_sid_val",
      },
    });
  }

  it("returns ok for a complete config", () => {
    const cfg = minimalConfig();
    const result = validateConfig(cfg);
    assert.ok(result.ok);
  });

  it("fails when COOKIES is missing", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "", AT_TOKEN: "tok", F_SID: "fid" },
    });
    const result = validateConfig(cfg);
    assert.ok(!result.ok);
    assert.ok(result.error.message.includes("COOKIES"));
  });

  it("fails when AT_TOKEN is missing", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "SID=x", AT_TOKEN: "", F_SID: "fid" },
    });
    const result = validateConfig(cfg);
    // AT_TOKEN is optional — validation should succeed with only COOKIES
    assert.ok(result.ok);
  });

  it("fails when F_SID is missing", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "SID=x", AT_TOKEN: "tok", F_SID: "" },
    });
    const result = validateConfig(cfg);
    // F_SID is optional — validation should succeed with only COOKIES
    assert.ok(result.ok);
  });

  it("lists only COOKIES as required in error", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "", AT_TOKEN: "", F_SID: "" },
    });
    const result = validateConfig(cfg);
    assert.ok(!result.ok);
    assert.ok(result.error.message.includes("COOKIES"));
    assert.ok(!result.error.message.includes("AT_TOKEN"));
    assert.ok(!result.error.message.includes("F_SID"));
  });
});

// ─── loadConfigFromEnv ────────────────────────────────────────────────────────

describe("loadConfigFromEnv — auth fields", () => {
  it("picks up COOKIES, AT_TOKEN, F_SID from overrides", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: '"SID=abc; NID=xyz"', AT_TOKEN: "tok1", F_SID: "fsid1" },
    });
    // Cookies are normalized (outer quotes stripped)
    assert.ok(cfg.auth.cookies.includes("SID=abc"));
    assert.equal(cfg.auth.atToken, "tok1");
    assert.equal(cfg.auth.fSid, "fsid1");
  });

  it("strips outer double-quotes from COOKIES", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: '"SID=quoted; NID=also"', AT_TOKEN: "t", F_SID: "f" },
    });
    assert.ok(!cfg.auth.cookies.startsWith('"'));
    assert.ok(!cfg.auth.cookies.endsWith('"'));
  });
});

describe("loadConfigFromEnv — context defaults", () => {
  it("resolves BL_PARAM from MODEL=auto to default build string", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "auto" },
    });
    assert.ok(cfg.context.blParam.startsWith("boq_assistant"));
  });

  it("uses BL_PARAM override when set", () => {
    const cfg = loadConfigFromEnv({
      overrides: {
        COOKIES: "c",
        AT_TOKEN: "t",
        F_SID: "f",
        BL_PARAM: "boq_assistant-bard-web-server_20991231.99_p9",
      },
    });
    assert.equal(cfg.context.blParam, "boq_assistant-bard-web-server_20991231.99_p9");
  });

  it("uses full boq_ string from MODEL when set", () => {
    const boq = "boq_assistant-bard-web-server_20260101.01_p1";
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: boq },
    });
    assert.equal(cfg.context.blParam, boq);
  });

  it("defaults language to en", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f" },
    });
    assert.equal(cfg.context.language, "en");
  });

  it("uses LANGUAGE override", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", LANGUAGE: "fr" },
    });
    assert.equal(cfg.context.language, "fr");
  });

  it("maps MODEL=flash to modelSlot=1", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "flash" },
    });
    assert.equal(cfg.context.modelSlot, 1);
  });

  it("maps MODEL=pro to modelSlot=3", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "pro" },
    });
    assert.equal(cfg.context.modelSlot, 3);
  });

  it("maps MODEL=flash-lite to modelSlot=6", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "flash-lite" },
    });
    assert.equal(cfg.context.modelSlot, 6);
  });

  it("maps MODEL=extended to modelSlot=3 (same as Pro)", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "extended" },
    });
    assert.equal(cfg.context.modelSlot, 3);
  });

  it("defaults modelSlot to 6 (Flash-Lite) when MODEL=auto", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "auto" },
    });
    assert.equal(cfg.context.modelSlot, 6);
  });

  it("accepts raw numeric MODEL as modelSlot", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "42" },
    });
    assert.equal(cfg.context.modelSlot, 42);
  });

  it("maps 3.6-flash and 3.1-pro aliases correctly", () => {
    const flash = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "3.6-flash" },
    });
    assert.equal(flash.context.modelSlot, 1);
    const pro = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", MODEL: "3.1-pro" },
    });
    assert.equal(pro.context.modelSlot, 3);
  });
});

describe("loadConfigFromEnv — runtime defaults", () => {
  it("provides positive timeout defaults", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f" },
    });
    assert.ok(cfg.runtime.streamIdleTimeoutMs > 0);
    assert.ok(cfg.runtime.streamMaxDurationMs > 0);
    assert.ok(cfg.runtime.imageStreamIdleTimeoutMs > cfg.runtime.streamIdleTimeoutMs);
  });

  it("respects STREAM_IDLE_TIMEOUT_MS override", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", STREAM_IDLE_TIMEOUT_MS: "9999" },
    });
    assert.equal(cfg.runtime.streamIdleTimeoutMs, 9999);
  });

  it("debugCandidates is false by default", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f" },
    });
    assert.equal(cfg.runtime.debugCandidates, false);
  });

  it("debugCandidates is true when DEBUG_CANDIDATES=1", () => {
    const cfg = loadConfigFromEnv({
      overrides: { COOKIES: "c", AT_TOKEN: "t", F_SID: "f", DEBUG_CANDIDATES: "1" },
    });
    assert.equal(cfg.runtime.debugCandidates, true);
  });
});

// ─── mergeProjectConfigIntoEnv — file loading ─────────────────────────────────

describe("mergeProjectConfigIntoEnv — JSON config file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetProjectConfigMergeCache();
    tmpDir = await (async () => {
      const d = path.join(
        os.tmpdir(),
        `nimji-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(d, { recursive: true });
      return d;
    })();
  });

  afterEach(async () => {
    resetProjectConfigMergeCache();
    // Clean up env keys we may have set
    delete process.env.__NIMJI_TEST_KEY__;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("merges top-level keys from config.jsonc into process.env", async () => {
    const cfg = { __NIMJI_TEST_KEY__: "from-config-file" };
    await writeFile(path.join(tmpDir, "config.jsonc"), JSON.stringify(cfg), "utf8");
    mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(process.env.__NIMJI_TEST_KEY__, "from-config-file");
  });

  it("existing env values win over config file", async () => {
    process.env.__NIMJI_TEST_KEY__ = "from-env";
    const cfg = { __NIMJI_TEST_KEY__: "from-config-file" };
    await writeFile(path.join(tmpDir, "config.json"), JSON.stringify(cfg), "utf8");
    mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(process.env.__NIMJI_TEST_KEY__, "from-env");
  });

  it("returns null when no config file found", () => {
    const emptyDir = path.join(tmpDir, "empty_subdir");
    // Don't create any config files
    const result = mergeProjectConfigIntoEnv(emptyDir);
    assert.equal(result, null);
  });

  it("handles config.json fallback when config.jsonc absent", async () => {
    const cfg = { __NIMJI_TEST_KEY__: "from-json" };
    await writeFile(path.join(tmpDir, "config.json"), JSON.stringify(cfg), "utf8");
    mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(process.env.__NIMJI_TEST_KEY__, "from-json");
  });

  it("is idempotent — second call does not re-merge", async () => {
    const cfg = { __NIMJI_TEST_KEY__: "first-merge" };
    await writeFile(path.join(tmpDir, "config.jsonc"), JSON.stringify(cfg), "utf8");
    mergeProjectConfigIntoEnv(tmpDir);
    // Now change the file (should be ignored on second call)
    await writeFile(
      path.join(tmpDir, "config.jsonc"),
      JSON.stringify({ __NIMJI_TEST_KEY__: "second-merge" }),
      "utf8",
    );
    mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(process.env.__NIMJI_TEST_KEY__, "first-merge");
  });
});

// ─── S3: mergeProjectConfigIntoEnv — oversized file guard ────────────────────

describe("mergeProjectConfigIntoEnv — oversized config file is skipped", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetProjectConfigMergeCache();
    tmpDir = await (async () => {
      const d = path.join(
        os.tmpdir(),
        `nimji-test-s3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(d, { recursive: true });
      return d;
    })();
  });

  afterEach(async () => {
    resetProjectConfigMergeCache();
    delete process.env.__NIMJI_S3_KEY__;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips a config file that exceeds 256 KiB and returns null", async () => {
    // Write a file just over 256 KiB; pad with spaces so it stays valid JSON
    const base = JSON.stringify({ __NIMJI_S3_KEY__: "should-not-appear" });
    const padding = " ".repeat(256 * 1024 + 1 - base.length);
    // The padding is outside the JSON value so the whole thing is valid JSON wrapped in an object
    // Actually we just need the file to be > 256KiB; content validity doesn't matter since it's skipped
    const bigContent = base + padding;
    await writeFile(path.join(tmpDir, "config.jsonc"), bigContent, "utf8");
    const result = mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(result, null, "oversized file should be skipped, returning null");
    assert.equal(
      process.env.__NIMJI_S3_KEY__,
      undefined,
      "env key must not be set from oversized file",
    );
  });

  it("accepts a config file just under 256 KiB", async () => {
    const base = JSON.stringify({ __NIMJI_S3_KEY__: "under-limit" });
    // No padding needed — a normal small file is well under the cap
    await writeFile(path.join(tmpDir, "config.jsonc"), base, "utf8");
    mergeProjectConfigIntoEnv(tmpDir);
    assert.equal(process.env.__NIMJI_S3_KEY__, "under-limit");
  });
});

// ─── S2: KEEPALIVE_F_REQ_PATH — path traversal guard ─────────────────────────

describe("loadConfigFromEnv — KEEPALIVE_F_REQ_PATH path traversal guard", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetProjectConfigMergeCache();
    tmpDir = await (async () => {
      const d = path.join(
        os.tmpdir(),
        `nimji-test-s2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await mkdir(d, { recursive: true });
      return d;
    })();
  });

  afterEach(async () => {
    resetProjectConfigMergeCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when KEEPALIVE_F_REQ_PATH escapes the cwd via ..", async () => {
    // Write a dummy JSON file one level above tmpDir that we try to escape to
    const outsideFile = path.join(os.tmpdir(), `nimji-escape-target-${Date.now()}.json`);
    await writeFile(outsideFile, '[[["aPya6c","payload"]]]', "utf8");

    try {
      assert.throws(
        () =>
          loadConfigFromEnv({
            cwd: tmpDir,
            overrides: {
              COOKIES: "c",
              AT_TOKEN: "t",
              F_SID: "f",
              KEEPALIVE_F_REQ_PATH: path.relative(tmpDir, outsideFile),
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(
            err.message.includes("must be inside the project directory"),
            `unexpected message: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it("accepts a KEEPALIVE_F_REQ_PATH that is inside cwd", async () => {
    const innerFile = path.join(tmpDir, "keepalive.json");
    await writeFile(innerFile, '[[["aPya6c","payload"]]]', "utf8");

    assert.doesNotThrow(() =>
      loadConfigFromEnv({
        cwd: tmpDir,
        overrides: {
          COOKIES: "c",
          AT_TOKEN: "t",
          F_SID: "f",
          KEEPALIVE_F_REQ_PATH: innerFile,
        },
      }),
    );
  });
});
