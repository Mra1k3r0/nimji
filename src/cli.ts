#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "./client.js";
import { IMAGE_PIPELINE_DISABLED } from "./images.js";
import { loadConfigFromEnv, mergeProjectConfigIntoEnv, validateConfig } from "./config.js";
import { resolveAppHomeDir } from "./paths.js";
import { createSessionStore } from "./session.js";
import type { GemaiClient, GemaiHooks, GenerateResult, Result } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPkgVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const j = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof j.version === "string" ? j.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PKG_VERSION = readPkgVersion();

const argValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  const eqMatch = process.argv.find((arg) => arg.startsWith(prefix));
  if (eqMatch) return eqMatch.slice(prefix.length);

  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
};

const hasFlag = (...names: string[]): boolean => names.some((name) => process.argv.includes(name));
const valueOf = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = argValue(name);
    if (value) return value;
  }
  return undefined;
};

const toPositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const nextReqId = (): string => String(Math.floor(1_000_000 + Math.random() * 9_000_000));
const nextSourcePath = (): string => `/app/${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const withRefreshedContext = (config: ReturnType<typeof loadConfigFromEnv>) => ({
  ...config,
  context: {
    ...config.context,
    reqId: nextReqId(),
    requestUuid: randomUUID().toUpperCase(),
    sourcePath: nextSourcePath(),
  },
});

const COLOR_ENABLED =
  process.env.NO_COLOR !== "1" &&
  process.env.TERM !== "dumb" &&
  (process.env.FORCE_COLOR === "1" ||
    process.env.FORCE_COLOR === "true" ||
    process.stdout.isTTY ||
    process.stderr.isTTY);

const hex = (value: string, text: string): string => {
  if (!COLOR_ENABLED) return text;
  const cleaned = value.replace("#", "");
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
};
const muted = (text: string): string => hex("#8b95a7", text);
const accent = (text: string): string => hex("#6ea8fe", text);
const success = (text: string): string => hex("#59d499", text);
const warn = (text: string): string => hex("#ffb86c", text);
const strong = (text: string): string => hex("#d7e3ff", text);
const danger = (text: string): string => hex("#ff6b7a", text);
const codeTone = (text: string): string => hex("#b4c7ff", text);
/** Fenced code only — block / line comments vs executable lines. */
const codeCommentTone = (text: string): string => {
  if (!COLOR_ENABLED) return text;
  return `\u001b[3m${hex("#7d9a88", text)}\u001b[23m`;
};
const dim = (text: string): string => (COLOR_ENABLED ? `\u001b[2m${text}\u001b[0m` : text);

const betaPill = (label = "beta"): string => {
  if (!COLOR_ENABLED) return `[${label}]`;
  const fr = 255;
  const fg = 247;
  const fb = 230;
  const br = 194;
  const bg = 65;
  const bb = 12;
  return `\u001b[1m\u001b[38;2;${fr};${fg};${fb}m\u001b[48;2;${br};${bg};${bb}m ${label} \u001b[0m`;
};

type EmitLine = (line: string) => void;

const termWidth = (): number => {
  const cols = process.stdout.columns ?? process.stderr.columns ?? 100;
  return Math.max(72, Math.min(cols, 120));
};

const brand = (subtitle: string): void => {
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const left = `${strong("nimji")} ${muted("•")} ${muted(subtitle)}`;
  const right = muted(stamp);
  const space = Math.max(1, termWidth() - left.length - right.length - 3);
  console.error(`\n${dim("─".repeat(termWidth()))}`);
  console.error(`${left}${" ".repeat(space)}${right}`);
  console.error(`${dim("─".repeat(termWidth()))}`);
};

const section = (title: string, emit: EmitLine = console.log): void => {
  const label = strong(title.toUpperCase());
  emit(`\n${accent("▌")} ${label}`);
};

const kv = (label: string, value: string | number, emit: EmitLine = console.log): void => {
  const left = muted(label.padEnd(12, " "));
  emit(`  ${left} ${strong(String(value))}`);
};

const banner = (kind: "ok" | "warn" | "error", text: string): void => {
  const color = kind === "ok" ? success : kind === "warn" ? warn : danger;
  const tag = kind === "ok" ? "info" : kind === "warn" ? "warn" : "error";
  console.error(`  ${color(tag.padEnd(5, " "))} ${text}`);
};

type UiDensity = "compact" | "comfortable";
type AnswerStyle = "boxed" | "plain";

function normalizeUiDensity(raw: string | undefined, fallback: UiDensity): UiDensity {
  const t = raw?.trim().toLowerCase();
  if (t === "compact") return "compact";
  if (t === "comfortable") return "comfortable";
  return fallback;
}

function normalizeAnswerStyle(raw: string | undefined, fallback: AnswerStyle): AnswerStyle {
  const t = raw?.trim().toLowerCase();
  if (t === "plain") return "plain";
  if (t === "boxed") return "boxed";
  return fallback;
}

function startKeepaliveInBackground(intervalMinutes: number): void {
  const keepaliveFile = path.resolve(__dirname, "runtime", "keepalive.js");
  const keepaliveSessionFile = process.env.KEEPALIVE_SESSION_FILE ?? "keepalive-session.json";
  const child = spawn(process.execPath, [...process.execArgv, keepaliveFile, "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      KEEPALIVE_INTERVAL_MINUTES: String(intervalMinutes),
      KEEPALIVE_BASE_DIR: resolveAppHomeDir(),
      KEEPALIVE_SESSION_FILE: keepaliveSessionFile,
    },
  });
  child.unref();
  console.error(
    `  ${success(
      `[keepalive] background on  pid=${child.pid ?? "unknown"}  every=${intervalMinutes}m  file=${keepaliveSessionFile}`,
    )}  ${betaPill()}`,
  );
}

function printHelp(): void {
  console.log(`nimji ${PKG_VERSION} — Gemini StreamGenerate CLI`);
  console.log("");
  console.log("One-shot (single reply, then exit):");
  console.log('  nimji [prompt]              Default prompt: "hi" if omitted');
  console.log('  nimji --prompt "text"       Explicit prompt');
  console.log("");
  console.log("Interactive chat (multi-turn, readline):");
  console.log("  nimji --chat");
  console.log("  nimji --chat --keep-alive   In-process session pings");
  console.log("");
  console.log("Shared flags:");
  console.log("  --image                     Extra retries for image-style prompts");
  console.log("  --no-save-images            Skip disk (with --image)");
  console.log("  --save-images               Always save images");
  console.log("  --upload, --upload-images   ImgBB upload when IMG_BB_API_KEY is set");
  console.log(
    "                              (inactive while IMAGE_PIPELINE_DISABLED in images.ts)",
  );
  console.log("  --show-source-image-urls    Print lh3 URLs even after save");
  console.log("  --reset-session             Clear conversation file");
  console.log("  --no-session                Do not load/save session.json");
  console.log("  --keepalive / --keep-alive  Chat: in-process pings; else: detached daemon");
  console.log("  --keepalive-minutes N       Ping interval (default 10)");
  console.log("  --no-retry                  Disable generate retries");
  console.log("  --density compact|comfortable   --answer-style plain|boxed");
  console.log("");
  console.log("Environment (required): COOKIES, AT_TOKEN, F_SID");
  console.log(
    "Optional: MODEL (auto | paste full boq_* bl string), BL_PARAM (overrides MODEL), USER_AGENT, NIMJI_HOME (fallback GEMAI_HOME), NIMJI_CONFIG (fallback GEMAI_CONFIG), UI_DENSITY, UI_ANSWER_STYLE, DEBUG_CANDIDATES=1, NO_COLOR, FORCE_COLOR",
  );
  console.log(
    "Keepalive extras: KEEPALIVE_RPC, KEEPALIVE_F_REQ_PATH | KEEPALIVE_F_REQ, KEEPALIVE_INNER_PAYLOAD, KEEPALIVE_GOOG_EXT_525001261_JSPB",
  );
  console.log(
    "Config files (first match fills missing env): ./config.jsonc or ./config.json in cwd, then",
  );
  console.log(
    "  ~/.nimji/config.jsonc or ~/.nimji/config.json (override dir with NIMJI_HOME). Env always wins.",
  );
  console.log("");
  console.log("Exit codes: 0 success, 1 error");
}

type ResponseIssue = "none" | "partial_stream" | "no_text";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function classifyResponse(value: {
  text: string | null;
  meta: { chunkCount: number; rawSize: number; statusCode: number };
}): ResponseIssue {
  if (value.meta.statusCode !== 200) return "partial_stream";
  if (value.meta.chunkCount <= 1 || value.meta.rawSize < 220) return "partial_stream";
  if (!value.text || value.text.trim().length === 0) return "no_text";
  return "none";
}

async function runGenerateWithRetry(
  client: GemaiClient,
  prompt: string,
  saveImages: boolean,
  uploadImages: boolean,
  noRetry: boolean,
  allowSessionRecovery: boolean,
  maxRetries: number,
): Promise<{
  result: Result<GenerateResult>;
  issue: ResponseIssue;
  usedRetry: boolean;
  usedSessionRecovery: boolean;
  usedFreshNoSessionRetry: boolean;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  const result = await client.generate({
    prompt,
    includeImages: true,
    saveImages,
    uploadImages,
  });
  if (!result.ok) {
    return {
      result,
      issue: "partial_stream",
      usedRetry: false,
      usedSessionRecovery: false,
      usedFreshNoSessionRetry: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  let issue = classifyResponse(result.value);
  if (issue === "none" || noRetry) {
    return {
      result,
      issue,
      usedRetry: false,
      usedSessionRecovery: false,
      usedFreshNoSessionRetry: false,
      elapsedMs: Date.now() - startedAt,
    };
  }
  let usedRetry = false;
  let retried: Result<GenerateResult> = result;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const retryConfig = loadConfigFromEnv();
    const checked = validateConfig(retryConfig);
    if (!checked.ok) {
      return {
        result,
        issue,
        usedRetry: false,
        usedSessionRecovery: false,
        usedFreshNoSessionRetry: false,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const conversationState = client.getConversation();
    const retryClient = createClient({
      ...checked.value,
      context: { ...checked.value.context, reqId: nextReqId() },
    });
    retryClient.setConversation(conversationState);

    retried = await retryClient.generate({
      prompt,
      includeImages: true,
      saveImages,
      uploadImages,
    });
    usedRetry = true;

    if (retried.ok) {
      client.setConversation(retryClient.getConversation());
      issue = classifyResponse(retried.value);
      if (issue === "none") break;
    } else {
      issue = "partial_stream";
    }

    if (attempt < maxRetries) await sleep(1200);
  }

  if (
    allowSessionRecovery &&
    retried.ok &&
    issue !== "none" &&
    Boolean(client.getConversation().conversationId)
  ) {
    const freshConfig = loadConfigFromEnv();
    const freshChecked = validateConfig(freshConfig);
    if (!freshChecked.ok) {
      return {
        result: retried,
        issue,
        usedRetry,
        usedSessionRecovery: false,
        usedFreshNoSessionRetry: false,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const recoveryClient = createClient({
      ...withRefreshedContext(freshChecked.value),
      conversation: {},
    });

    const recovered = await recoveryClient.generate({
      prompt,
      includeImages: true,
      saveImages,
      uploadImages,
    });
    if (recovered.ok) {
      issue = classifyResponse(recovered.value);
      client.resetConversation();
      client.setConversation(recoveryClient.getConversation());
    }
    return {
      result: recovered,
      issue,
      usedRetry,
      usedSessionRecovery: true,
      usedFreshNoSessionRetry: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (allowSessionRecovery && retried.ok && issue !== "none") {
    const freshConfig = loadConfigFromEnv();
    const freshChecked = validateConfig(freshConfig);
    if (!freshChecked.ok) {
      return {
        result: retried,
        issue,
        usedRetry,
        usedSessionRecovery: false,
        usedFreshNoSessionRetry: false,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const freshClient = createClient({
      ...withRefreshedContext(freshChecked.value),
      conversation: {},
    });

    const fresh = await freshClient.generate({
      prompt,
      includeImages: true,
      saveImages,
      uploadImages,
    });
    if (fresh.ok) {
      issue = classifyResponse(fresh.value);
      client.resetConversation();
      client.setConversation(freshClient.getConversation());
    } else {
      issue = "partial_stream";
    }

    return {
      result: fresh,
      issue,
      usedRetry,
      usedSessionRecovery: false,
      usedFreshNoSessionRetry: true,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    result: retried,
    issue,
    usedRetry,
    usedSessionRecovery: false,
    usedFreshNoSessionRetry: false,
    elapsedMs: Date.now() - startedAt,
  };
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

type CodeStyleChunk = { readonly text: string; readonly comment: boolean };

/** Line `//` and block (slash-star … star-slash) comments, incl. multi-line blocks; quote-aware. */
function scanJsLikeCodeLine(
  line: string,
  blockContinuesIn: boolean,
): { chunks: CodeStyleChunk[]; blockContinues: boolean } {
  type Mode = "code" | "blk" | "sq" | "dq" | "tm";
  let mode: Mode = blockContinuesIn ? "blk" : "code";
  let commentFlag = blockContinuesIn;
  const chunks: CodeStyleChunk[] = [];
  let cur = "";

  const flush = (): void => {
    if (!cur) return;
    chunks.push({ text: cur, comment: commentFlag });
    cur = "";
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const n = line[i + 1];

    if (mode === "code") {
      if (c === "/" && n === "/") {
        flush();
        commentFlag = true;
        cur = line.slice(i);
        flush();
        return { chunks, blockContinues: false };
      }
      if (c === "/" && n === "*") {
        flush();
        commentFlag = true;
        cur = "/*";
        i += 2;
        mode = "blk";
        continue;
      }
      if (c === "'") {
        cur += "'";
        i += 1;
        mode = "sq";
        continue;
      }
      if (c === '"') {
        cur += '"';
        i += 1;
        mode = "dq";
        continue;
      }
      if (c === "`") {
        cur += "`";
        i += 1;
        mode = "tm";
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }

    if (mode === "blk") {
      if (c === "*" && n === "/") {
        cur += "*/";
        i += 2;
        flush();
        commentFlag = false;
        mode = "code";
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }

    if (mode === "sq") {
      cur += c;
      i += 1;
      if (c === "\\" && i < line.length) {
        cur += line[i];
        i += 1;
      } else if (c === "'") {
        mode = "code";
      }
      continue;
    }

    if (mode === "dq") {
      cur += c;
      i += 1;
      if (c === "\\" && i < line.length) {
        cur += line[i];
        i += 1;
      } else if (c === '"') {
        mode = "code";
      }
      continue;
    }

    if (mode === "tm") {
      cur += c;
      i += 1;
      if (c === "\\" && i < line.length) {
        cur += line[i];
        i += 1;
      } else if (c === "`") {
        mode = "code";
      }
      continue;
    }
  }

  flush();
  return { chunks, blockContinues: mode === "blk" };
}

function mergeAdjacentCodeChunks(chunks: CodeStyleChunk[]): CodeStyleChunk[] {
  const out: CodeStyleChunk[] = [];
  for (const ch of chunks) {
    const prev = out[out.length - 1];
    if (prev && prev.comment === ch.comment) {
      out[out.length - 1] = { text: prev.text + ch.text, comment: prev.comment };
    } else {
      out.push({ ...ch });
    }
  }
  return out;
}

/** Word-wrap fenced code with per-token styling; hard-wraps tokens longer than width. */
function wrapCodeStyleChunks(chunks: CodeStyleChunk[], wrapWidth: number): string[] {
  const merged = mergeAdjacentCodeChunks(chunks);
  const linesOut: string[] = [];
  let buf = "";
  let len = 0;

  const appendFrag = (frag: string, comment: boolean): void => {
    if (!frag) return;
    let offset = 0;
    while (offset < frag.length) {
      const room = wrapWidth - len;
      if (room <= 0) {
        linesOut.push(buf);
        buf = "";
        len = 0;
        continue;
      }
      const take = Math.min(room, frag.length - offset);
      const piece = frag.slice(offset, offset + take);
      const styled = comment ? codeCommentTone(piece) : codeTone(piece);
      buf += styled;
      len += take;
      offset += take;
      if (offset < frag.length) {
        linesOut.push(buf);
        buf = "";
        len = 0;
      }
    }
  };

  const emitToken = (raw: string, comment: boolean): void => {
    if (!raw) return;
    const tokens = raw.match(/\S+|\s+/g) ?? [];
    for (const tok of tokens) {
      appendFrag(tok, comment);
    }
  };

  for (const ch of merged) {
    emitToken(ch.text, ch.comment);
  }
  if (len > 0) linesOut.push(buf);
  return linesOut;
}

/** Inline spans for answers (fenced blocks skipped). Code wins over `**` wrapping. */
type InlineToken =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "boldCode"; readonly text: string };

function parseInlineMarkdownTokens(line: string, bold = false): InlineToken[] {
  const out: InlineToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const j = line.indexOf("`", i + 1);
      if (j !== -1) {
        const inner = line.slice(i + 1, j);
        out.push(bold ? { kind: "boldCode", text: inner } : { kind: "code", text: inner });
        i = j + 1;
        continue;
      }
    }
    if (!bold && line[i] === "*" && line[i + 1] === "*") {
      const j = line.indexOf("**", i + 2);
      if (j !== -1) {
        const inner = line.slice(i + 2, j);
        out.push(...parseInlineMarkdownTokens(inner, true));
        i = j + 2;
        continue;
      }
    }
    let j = i;
    while (j < line.length) {
      if (line[j] === "`") break;
      if (!bold && line[j] === "*" && line[j + 1] === "*") break;
      j += 1;
    }
    const textRun = line.slice(i, j);
    if (textRun) {
      out.push(bold ? { kind: "bold", text: textRun } : { kind: "plain", text: textRun });
    }
    i = j;
  }
  return out;
}

function stylizeInlineWord(word: string, kind: InlineToken["kind"]): string {
  if (!COLOR_ENABLED) return word;
  switch (kind) {
    case "plain":
      return word;
    case "bold":
      return `\u001b[1m${strong(word)}\u001b[22m`;
    case "code":
      return codeTone(word);
    case "boldCode":
      return `\u001b[1m${codeTone(word)}\u001b[22m`;
    default:
      return word;
  }
}

/** Word-wrap using visible length only; preserves ANSI spans from {@link stylizeInlineWord}. */
function wrapInlineTokens(tokens: InlineToken[], width: number): string[] {
  const lines: string[] = [];
  let buf = "";
  let len = 0;

  const emitWord = (word: string, kind: InlineToken["kind"]): void => {
    const ansi = stylizeInlineWord(word, kind);
    const wlen = word.length;
    const needSpace = len > 0 ? 1 : 0;
    if (len + needSpace + wlen <= width || len === 0) {
      buf += (needSpace ? " " : "") + ansi;
      len += needSpace + wlen;
    } else {
      lines.push(buf);
      buf = ansi;
      len = wlen;
    }
  };

  for (const tok of tokens) {
    const parts = tok.text.split(/\s+/).filter(Boolean);
    for (const w of parts) emitWord(w, tok.kind);
  }
  if (len > 0) lines.push(buf);
  return lines;
}

function uppercaseHeadingTokens(tokens: InlineToken[]): InlineToken[] {
  return tokens.map((t) => {
    if (t.kind === "code" || t.kind === "boldCode") return t;
    return { ...t, text: t.text.toUpperCase() };
  });
}

const renderMarkdownLines = (text: string, width: number, density: UiDensity): string[] => {
  const lines = text.split("\n");
  const rendered: string[] = [];
  let inCode = false;
  let codeBlockComment = false;
  const gap = density === "comfortable" ? "" : null;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, "  ");
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      codeBlockComment = false;
      if (density === "comfortable") rendered.push("");
      continue;
    }

    if (inCode) {
      const { chunks, blockContinues } = scanJsLikeCodeLine(line, codeBlockComment);
      codeBlockComment = blockContinues;
      const innerWidth = Math.max(10, width - 2);
      const codeLines = wrapCodeStyleChunks(chunks, innerWidth);
      if (codeLines.length === 0) {
        rendered.push("  ");
      } else {
        for (const item of codeLines) {
          rendered.push(`  ${item}`);
        }
      }
      continue;
    }

    if (!trimmed) {
      if (density === "comfortable" && rendered[rendered.length - 1] !== "") rendered.push("");
      continue;
    }

    if (trimmed.startsWith("#")) {
      const heading = trimmed.replace(/^#+\s*/, "");
      const headingTokens = uppercaseHeadingTokens(parseInlineMarkdownTokens(heading));
      const richHeading = headingTokens.some((t) => t.kind !== "plain");
      const wrapped = wrapInlineTokens(headingTokens, width);
      rendered.push(...(richHeading ? wrapped : wrapped.map((w) => strong(w))));
      if (density === "comfortable") rendered.push("");
      continue;
    }

    const bulletMatch = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
      const content = bulletMatch[2];
      const wrapped = wrapInlineTokens(parseInlineMarkdownTokens(content), Math.max(10, width - 4));
      if (wrapped.length > 0) {
        rendered.push(`${accent("•")} ${wrapped[0]}`);
        for (const item of wrapped.slice(1)) rendered.push(`  ${item}`);
      }
      continue;
    }

    const wrapped = wrapInlineTokens(parseInlineMarkdownTokens(trimmed), width);
    rendered.push(...wrapped);
    if (gap !== null) rendered.push(gap);
  }

  while (rendered.length > 0 && rendered[rendered.length - 1] === "") rendered.pop();
  return rendered;
};

const stripAnsi = (value: string): string => {
  let out = "";
  let inEsc = false;
  for (const ch of value) {
    if (!inEsc && ch === "\u001b") {
      inEsc = true;
      continue;
    }
    if (inEsc) {
      if (ch === "m") inEsc = false;
      continue;
    }
    out += ch;
  }
  return out;
};

const renderAssistantBlock = (text: string, style: AnswerStyle, density: UiDensity): void => {
  const width =
    style === "boxed"
      ? Math.max(50, Math.min(termWidth() - 8, 96))
      : Math.max(50, Math.min(termWidth() - 4, 100));
  const rendered = renderMarkdownLines(text, width, density);

  if (style === "plain") {
    for (const lineText of rendered) {
      console.log(`  ${lineText}`);
    }
    return;
  }

  console.log(dim(`  ┌${"─".repeat(width + 2)}┐`));
  for (const lineText of rendered) {
    const plain = stripAnsi(lineText);
    const padded = lineText + " ".repeat(Math.max(0, width - plain.length));
    console.log(dim("  │ ") + padded + dim(" │"));
  }
  console.log(dim(`  └${"─".repeat(width + 2)}┘`));
};

function printGenerateOutput(
  value: GenerateResult,
  issue: ResponseIssue,
  saveImages: boolean,
  uploadImages: boolean,
  showSourceImageUrls: boolean,
  elapsedMs: number,
  answerStyle: AnswerStyle,
  density: UiDensity,
): void {
  section("Response", console.error);
  kv("status", value.meta.statusCode, console.error);
  kv("size", formatBytes(value.meta.rawSize), console.error);
  kv("chunks", value.meta.chunkCount, console.error);
  kv("latency", `${elapsedMs} ms`, console.error);
  kv("content", value.meta.contentType, console.error);

  if (value.text) {
    section("Answer");
    renderAssistantBlock(value.text, answerStyle, density);
  }

  if (issue !== "none") {
    const reason = issue === "partial_stream" ? "partial stream payload" : "no text extracted";
    banner("warn", `${reason}. usually stale auth/session state.`);
  }

  if (value.savedImagePaths.length > 0) {
    section("Saved images");
    for (const file of value.savedImagePaths) {
      console.log(`- ${file}`);
    }
  } else if (saveImages && value.imageUrls.length > 0) {
    banner("warn", "image URLs found but save failed (gated/expired).");
  }

  if (value.uploadedImageUrls.length > 0) {
    section("Uploaded images");
    for (const url of value.uploadedImageUrls) {
      console.log(`- ${url}`);
    }
  } else if (uploadImages && value.imageUrls.length > 0) {
    if (value.savedImagePaths.length === 0) {
      banner("warn", "image download failed/gated, so upload was skipped.");
    } else {
      banner("warn", "image upload failed or IMG_BB_API_KEY is missing.");
    }
  }

  if (value.imageUrls.length > 0) {
    const hideEphemeral = value.savedImagePaths.length > 0 && !showSourceImageUrls;
    section("Source image urls");
    if (hideEphemeral) {
      console.log(
        dim(
          `  Omitted ${value.imageUrls.length} ephemeral lh3 link(s); files above are canonical. ${muted("--show-source-image-urls to print CDN URLs.")}`,
        ),
      );
    } else {
      console.log(dim("  Google CDN — links may expire; use saved paths or uploads when present."));
      for (const url of value.imageUrls) {
        console.log(`- ${url}`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    printHelp();
    process.exit(0);
  }
  if (hasFlag("--version", "-v")) {
    console.log(PKG_VERSION);
    process.exit(0);
  }

  mergeProjectConfigIntoEnv(process.cwd());

  const argv = process.argv.slice(2);
  const consumedValues = new Set<string>();
  const promptFromFlag = valueOf("--prompt");
  if (promptFromFlag) consumedValues.add(promptFromFlag);

  const positional = argv.filter((arg) => !arg.startsWith("--") && !consumedValues.has(arg));
  const prompt = promptFromFlag ?? positional[0] ?? "hi";
  const imageMode = hasFlag("--image");
  const saveImagesExplicit = process.argv.includes("--save-images");
  const noSaveImages = process.argv.includes("--no-save-images");
  const saveImagesRequested = saveImagesExplicit || (imageMode && !noSaveImages);
  const uploadImagesRequested = hasFlag("--upload-images", "--upload");
  const saveImages = saveImagesRequested && !IMAGE_PIPELINE_DISABLED;
  const uploadImages = uploadImagesRequested && !IMAGE_PIPELINE_DISABLED;
  const showSourceImageUrls = hasFlag("--show-source-image-urls");
  const resetSession = process.argv.includes("--reset-session");
  const noSession = process.argv.includes("--no-session");
  const keepalive = hasFlag("--keepalive", "--keep-alive");
  const noRetry = process.argv.includes("--no-retry");
  const noSessionRecover = process.argv.includes("--no-session-recover");
  const mode = (hasFlag("--chat") ? "chat" : (valueOf("--mode") ?? "once")).toLowerCase();
  const keepaliveMinutes = toPositiveInt(
    valueOf("--keepalive-minutes", "--keep-alive-minutes") ??
      process.env.KEEPALIVE_INTERVAL_MINUTES,
    10,
  );
  const density = normalizeUiDensity(valueOf("--density") ?? process.env.UI_DENSITY, "comfortable");
  const answerStyle = normalizeAnswerStyle(
    valueOf("--answer-style") ?? process.env.UI_ANSWER_STYLE,
    "boxed",
  );
  const maxRetries = imageMode ? 2 : 1;

  if (keepalive && mode !== "chat") {
    startKeepaliveInBackground(keepaliveMinutes);
  }

  const config = loadConfigFromEnv();

  if (IMAGE_PIPELINE_DISABLED && (saveImagesRequested || uploadImagesRequested)) {
    banner(
      "warn",
      "image save/upload skipped — lh3 pipeline disabled (images.ts IMAGE_PIPELINE_DISABLED)",
    );
  }

  const store = createSessionStore(path.resolve(resolveAppHomeDir(), "session.json"));

  const hooks: GemaiHooks = {
    onCandidates: async (candidates) => {
      if (!config.runtime.debugCandidates) return;
      console.error("[*] Top text candidates:");
      for (const item of candidates.slice(0, 40)) {
        console.error(`  [${item.score}] ${item.value.slice(0, 200)}`);
      }
    },
    onImageDownloadSkip: async (reason, url) => {
      console.error(`[*] Skipped image URL (${reason}): ${url.slice(0, 120)}`);
    },
  };

  let client: GemaiClient;
  try {
    client = createClient(config, hooks);
  } catch (err) {
    banner("error", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (!noSession) {
    const restored = await store.load();
    if (restored.conversationId) {
      client.setConversation(restored);
    }
  }

  if (resetSession) {
    client.resetConversation();
    if (!noSession) {
      await store.clear();
    }
    banner("ok", "session reset");
  }

  if (mode === "chat") {
    if (keepalive) {
      client.startKeepalive({
        enabled: true,
        intervalMs: keepaliveMinutes * 60_000,
        prompt: process.env.KEEPALIVE_PROMPT ?? "hi",
      });
      banner("ok", `keepalive active (${keepaliveMinutes}m interval)  ${betaPill()}`);
    }
    brand("interactive chat");
    console.error(`  ${muted("commands")}  ${strong("/exit")} ${muted("or")} ${strong("/quit")}`);
    console.error(`  ${muted("ui")}  style=${answerStyle} density=${density}`);
    if (imageMode) console.error(`  ${muted("mode")}  ${accent("image (extra retries)")}`);
    if (imageMode && saveImages && !saveImagesExplicit) {
      console.error(
        `  ${muted("images")}  ${accent("auto-save on")} ${muted("(./output-images · --no-save-images to skip)")}`,
      );
    }
    const rl = createInterface({ input, output });
    try {
      while (true) {
        const line = (await rl.question(`${accent("nimji")} ${muted("›")} `)).trim();
        if (!line) continue;
        if (line === "/exit" || line === "/quit") break;

        const {
          result,
          issue,
          usedRetry,
          usedSessionRecovery,
          usedFreshNoSessionRetry,
          elapsedMs,
        } = await runGenerateWithRetry(
          client,
          line,
          saveImages,
          uploadImages,
          noRetry,
          !noSessionRecover,
          maxRetries,
        );
        if (!result.ok) {
          banner("error", result.error.message);
          continue;
        }
        if (usedSessionRecovery) {
          banner("ok", "session recovery applied");
        }
        if (usedFreshNoSessionRetry) {
          banner("ok", "fresh no-session retry applied");
        }
        if (usedRetry && issue !== "none") {
          banner("warn", "retry used, response still limited");
        }
        printGenerateOutput(
          result.value,
          issue,
          saveImages,
          uploadImages,
          showSourceImageUrls,
          elapsedMs,
          answerStyle,
          density,
        );
      }
    } finally {
      rl.close();
      client.stopKeepalive();
    }
  } else {
    brand("one-shot mode");
    section("Prompt", console.error);
    console.error(`  ${accent(prompt)}`);
    if (imageMode) banner("ok", "image mode enabled (extra retries)");
    if (imageMode && saveImages && !saveImagesExplicit) {
      banner("ok", "auto-saving images to ./output-images (--no-save-images to skip disk)");
    }
    const { result, issue, usedRetry, usedSessionRecovery, usedFreshNoSessionRetry, elapsedMs } =
      await runGenerateWithRetry(
        client,
        prompt,
        saveImages,
        uploadImages,
        noRetry,
        !noSessionRecover,
        maxRetries,
      );
    if (!result.ok) {
      banner("error", result.error.message);
      process.exit(1);
    }
    if (usedSessionRecovery) {
      banner("ok", "session recovery applied");
    }
    if (usedFreshNoSessionRetry) {
      banner("ok", "fresh no-session retry applied");
    }
    if (usedRetry && issue !== "none") {
      banner("warn", `${issue} detected, still limited response`);
    }
    printGenerateOutput(
      result.value,
      issue,
      saveImages,
      uploadImages,
      showSourceImageUrls,
      elapsedMs,
      answerStyle,
      density,
    );
  }

  const finalState = client.getConversation();
  if (!noSession) {
    await store.save(finalState);
  }
}

main().catch((err) => {
  banner("error", `fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
