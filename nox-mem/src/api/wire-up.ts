#!/usr/bin/env node
/**
 * src/api/wire-up.ts — HTTP route registration for handlers that live under
 * `src/api/*.ts` but aren't part of the native `src/api-server.ts` switch/case.
 *
 * Core kit: the only wired route is `POST /api/answer` (the flagship
 * synthesis endpoint). Enterprise/niche routes (export/import, SSE viewer,
 * conflict, confidence mark, hooks) were trimmed from the public package.
 *
 * This module exports `registerWireUpRoutes()` — a single function called
 * from `src/api-server.ts` immediately before its `default` (404) arm. It
 * pattern-matches the request path and delegates to the handler. Returns
 * `true` when the request was handled; `false` lets the host fall through to
 * the existing 404 reply.
 *
 * Framework constraint (regra "match existing routing pattern"):
 *   - Native Node `http` (`IncomingMessage` / `ServerResponse`). No Express.
 *   - JSON response helper signature mirrors `api-server.ts::json()`.
 *   - CORS headers piggyback the existing `json()` helper.
 *
 * Security defaults applied here:
 *   - G5 (error sanitizer): every catch funnels through `sanitizeErrorForHttp`
 *     so stack traces and internal paths never leak in 500 responses.
 */

import { IncomingMessage, ServerResponse } from "node:http";

// ─── CORS / JSON helpers (parity with src/api-server.ts) ────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Trace-Id, X-Request-ID, Authorization, Last-Event-ID",
};

function writeJson(
  res: ServerResponse,
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

// ─── Body parsing ────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf-8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJsonBody<T = unknown>(req: IncomingMessage, limit?: number): Promise<T> {
  const raw = await readBody(req, limit);
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

// ─── G5 sanitizer wiring (lazy, never crash boot) ──────────────────────────

type SanitizerFn = (err: unknown, opts?: { requestId?: string }) => { status: number; body: unknown };

let _sanitizer: SanitizerFn | null = null;

async function getSanitizer(): Promise<SanitizerFn> {
  if (_sanitizer) return _sanitizer;
  try {
    const mod: any = await import("../lib/error-sanitizer/sanitize.js");
    _sanitizer = (err, opts) => mod.sanitizeErrorForHttp(err, opts ?? {});
  } catch {
    // Fallback when G5 isn't deployed: minimal redaction (no stack, no paths).
    _sanitizer = () => ({
      status: 500,
      body: {
        error: "internal error",
        code: "INTERNAL_ERROR",
        requestId: "n/a",
      },
    });
  }
  return _sanitizer;
}

// Helper: header lookup (case-insensitive).
function getReqHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

// Helper: catch + sanitize wrapper around a route handler.
async function safeHandle(
  req: IncomingMessage,
  res: ServerResponse,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const sanitizer = await getSanitizer();
    const requestId = getReqHeader(req, "x-request-id");
    const out = sanitizer(err, { requestId });
    writeJson(res, out.body, out.status, { "X-Request-ID": String((out.body as any)?.requestId ?? requestId ?? "") });
  }
}

// ─── Route table ────────────────────────────────────────────────────────────

/** Cheap probe — caller can detect "is this URL ours?" without parsing body. */
export function matchesWireUpRoute(method: string, path: string): boolean {
  if (method === "POST" && path === "/api/answer") return true;
  return false;
}

/**
 * Main router. Returns true when the request was handled (response sent).
 * Returns false when caller should keep dispatching.
 */
export async function registerWireUpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url || "/";
  const path = url.split("?")[0];
  const method = (req.method || "GET").toUpperCase();

  if (!matchesWireUpRoute(method, path)) return false;

  // ── P1: POST /api/answer ────────────────────────────────────────────────
  if (method === "POST" && path === "/api/answer") {
    await safeHandle(req, res, async () => {
      const body = await readJsonBody(req);
      const mod: any = await import("./answer.js");
      const out = await mod.handleAnswerRequest({
        body,
        headers: req.headers,
      });
      writeJson(res, out.body, out.status, out.headers ?? {});
    });
    return true;
  }

  // Should be unreachable (matchesWireUpRoute already filtered), but be safe.
  return false;
}

// ─── Caller integration (src/api-server.ts) ──────────────────────────────────
//
// Add this line near the top:
//
//   import { registerWireUpRoutes } from "./api/wire-up.js";
//
// Then, inside `handleRequest()`, BEFORE the `default:` arm of the existing
// switch/case, insert:
//
//   if (await registerWireUpRoutes(req, res)) return;
//
// The function is idempotent and side-effect-free for paths it does not own.
