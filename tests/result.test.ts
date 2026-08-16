/**
 * Tests for src/result.ts
 * Covers: ok, err, tryCatch, tryAsync, isOk, isErr, unwrap, unwrapOr, mapErr, match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ok, err, tryCatch, tryAsync } from "../src/result.js";

// ─── ok / err constructors ────────────────────────────────────────────────────

describe("ok()", () => {
  it("creates an Ok result", () => {
    const r = ok(42);
    assert.equal(r.ok, true);
    assert.equal(r.value, 42);
  });
});

describe("err()", () => {
  it("creates an Err result", () => {
    const e = new Error("boom");
    const r = err(e);
    assert.equal(r.ok, false);
    assert.equal(r.error, e);
  });
});

// ─── isOk / isErr ─────────────────────────────────────────────────────────────

describe(".isOk()", () => {
  it("returns true on Ok", () => {
    assert.equal(ok("hi").isOk(), true);
  });
  it("returns false on Err", () => {
    assert.equal(err(new Error("x")).isOk(), false);
  });
});

describe(".isErr()", () => {
  it("returns true on Err", () => {
    assert.equal(err("fail").isErr(), true);
  });
  it("returns false on Ok", () => {
    assert.equal(ok(1).isErr(), false);
  });
});

// ─── unwrap / unwrapOr ────────────────────────────────────────────────────────

describe(".unwrap()", () => {
  it("returns value on Ok", () => {
    assert.equal(ok(10).unwrap(), 10);
  });
  it("throws on Err", () => {
    const e = new Error("bad");
    assert.throws(() => err(e).unwrap(), { message: "bad" });
  });
  it("wraps non-Error throwables in Error", () => {
    assert.throws(() => err("string err").unwrap(), Error);
  });
});

describe(".unwrapOr()", () => {
  it("returns value on Ok", () => {
    assert.equal(ok(5).unwrapOr(0), 5);
  });
  it("returns fallback on Err", () => {
    assert.equal(err(new Error("nope")).unwrapOr(99), 99);
  });
});

// ─── mapErr ───────────────────────────────────────────────────────────────────

describe(".mapErr()", () => {
  it("transforms Err value", () => {
    const r = err(new Error("orig")).mapErr((e) => `mapped: ${e.message}`);
    assert.equal(r.ok, false);
    assert.equal(r.error, "mapped: orig");
  });
  it("leaves Ok untouched", () => {
    const r = ok(42).mapErr(() => "should not happen");
    assert.equal(r.ok, true);
    assert.equal(r.value, 42);
  });
});

// ─── match ────────────────────────────────────────────────────────────────────

describe(".match()", () => {
  it("calls ok arm on Ok", () => {
    const r = ok(7).match({
      ok: (v) => v * 2,
      err: () => -1,
    });
    assert.equal(r, 14);
  });
  it("calls err arm on Err", () => {
    const r = err(new Error("x")).match({
      ok: () => -1,
      err: (e) => e.message,
    });
    assert.equal(r, "x");
  });
});

// ─── tryCatch ─────────────────────────────────────────────────────────────────

describe("tryCatch()", () => {
  it("returns Ok on success", () => {
    const r = tryCatch(() => 2 + 2);
    assert.equal(r.ok, true);
    assert.equal(r.value, 4);
  });
  it("returns Err on throw", () => {
    const r = tryCatch(() => {
      throw new Error("fail");
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.message, "fail");
  });
  it("wraps non-Error throws", () => {
    const r = tryCatch(() => {
      throw 42;
    });
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
    assert.equal(r.error.message, "42");
  });
});

// ─── tryAsync ─────────────────────────────────────────────────────────────────

describe("tryAsync()", () => {
  it("returns Ok on async success", async () => {
    const r = await tryAsync(async () => "hello");
    assert.equal(r.ok, true);
    assert.equal(r.value, "hello");
  });
  it("returns Err on async throw", async () => {
    const r = await tryAsync(async () => {
      throw new Error("async fail");
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.message, "async fail");
  });
  it("wraps non-Error async throws", async () => {
    const r = await tryAsync(async () => {
      throw { code: 404 };
    });
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
  });
});

// ─── chaining ─────────────────────────────────────────────────────────────────

describe("chaining", () => {
  it("mapErr + unwrap chains correctly", () => {
    const r = tryCatch(() => JSON.parse('{"a":1}'))
      .mapErr((e) => new Error(`parse: ${e.message}`))
      .unwrap();
    assert.deepEqual(r, { a: 1 });
  });
  it("mapErr + unwrapOr chains correctly", () => {
    const r = tryCatch(() => JSON.parse("not json"))
      .mapErr((e) => new Error(`parse: ${e.message}`))
      .unwrapOr(null);
    assert.equal(r, null);
  });
  it("match + ok arm with side effects", () => {
    let sideEffect = "";
    ok("data").match({
      ok: (v) => {
        sideEffect = v;
      },
      err: () => {
        sideEffect = "err";
      },
    });
    assert.equal(sideEffect, "data");
  });
});
