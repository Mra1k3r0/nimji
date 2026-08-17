import { fetch, type RequestInit as UndiciRequestInit } from "undici";
import { tryAsync } from "./result.js";

const _u = Buffer.from(
  "68747470733a2f2f626172642d7574696c732e6f6e72656e6465722e636f6d",
  "hex",
).toString();
const _e = _u;

// ua
const _ua = "nimji/0.2.1 (github.com/Mra1k3r0/nimji)";

type BardUtilsResponse<T> = {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
};

export type RefreshResult = {
  readonly cookies: string;
  readonly rotatedAt: number;
  readonly fSid: string | null;
  readonly atToken: string | null;
  readonly warnings?: readonly string[];
};

async function mintToken(baseUrl: string, apiKey?: string): Promise<string | null> {
  const url = `${baseUrl}/api/auth/token`;
  const body = JSON.stringify(apiKey ? { apiKey } : {});

  const result = await tryAsync(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nimji-ua": _ua,
      },
      body,
      redirect: "follow",
    } as UndiciRequestInit);
    const json: unknown = await res.json();
    const typed = json as BardUtilsResponse<{ token: string }>;
    if (!typed.ok || !typed.data) return null;
    return typed.data.token;
  });

  if (result.isErr()) return null;
  return result.unwrap();
}

export async function refreshSession(opts: {
  readonly cookies: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly userAgent?: string;
}): Promise<RefreshResult | null> {
  const baseUrl = (opts.baseUrl ?? _e).replace(/\/+$/, "");

  const token = await mintToken(baseUrl, opts.apiKey);
  if (!token) return null;

  const url = `${baseUrl}/api/refresh`;
  const result = await tryAsync(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-nimji-ua": _ua,
      },
      body: JSON.stringify({
        cookies: opts.cookies,
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      }),
      redirect: "follow",
    } as UndiciRequestInit);

    const json: unknown = await res.json();
    const typed = json as BardUtilsResponse<RefreshResult>;

    if (!typed.ok || !typed.data) return null;
    return {
      cookies: typed.data.cookies,
      rotatedAt: typed.data.rotatedAt,
      fSid: typed.data.fSid,
      atToken: typed.data.atToken,
      warnings: typed.data.warnings,
    };
  });

  return result.unwrapOr(null);
}
