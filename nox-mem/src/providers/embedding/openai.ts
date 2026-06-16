/**
 * src/providers/embedding/openai.ts — OpenAI-compatible embedding provider (A3.1, real).
 *
 * Talks the OpenAI Embeddings wire shape:
 *   POST {baseUrl}/embeddings
 *   Authorization: Bearer <apiKey>
 *   body: { model, input: string[], dimensions? }
 *   parse: data[].embedding   (sorted by data[].index to preserve input order)
 *
 * Single class drives any OpenAI-compatible embedding endpoint via `baseUrl`:
 *
 *   | Backend     | baseUrl                                | example model            |
 *   |-------------|----------------------------------------|--------------------------|
 *   | OpenAI      | https://api.openai.com/v1 (default)    | text-embedding-3-small   |
 *   | Together    | https://api.together.xyz/v1            | BAAI/bge-large-en-v1.5   |
 *   | OpenRouter  | https://openrouter.ai/api/v1           | (varies by listing)      |
 *   | DeepInfra   | https://api.deepinfra.com/v1/openai    | BAAI/bge-m3              |
 *   | local       | http://127.0.0.1:11434/v1 (ollama)     | nomic-embed-text         |
 *
 * ⚠ EMBEDDING DIMENSION CAVEAT (read before switching):
 *   The DB / sqlite-vec virtual table is fixed at the dim it was created with
 *   (nox-mem prod = 3072, from gemini-embedding-001). Mixing dims, or even the
 *   same dim from a different model, corrupts semantic search — vectors are not
 *   comparable across models. To swap to OpenAI you MUST re-embed the whole
 *   corpus with a single model at a single dim, and that dim MUST equal the
 *   vec0 table dim. `text-embedding-3-large` supports dimensions=3072 (parity
 *   with the existing table); `text-embedding-3-small` defaults to 1536 and is
 *   only safe on a fresh 1536-dim table. Set `NOX_EMBEDDING_MODEL` +
 *   `NOX_EMBEDDING_DIM` deliberately.
 *
 * Design parity with GeminiEmbeddingProvider:
 * - `fetch` (Node 18+), no SDK. `fetchFn` injectable for tests.
 * - Key from constructor arg → OPENAI_API_KEY env. Stored privately, redacted
 *   from all error text.
 * - Construction is NON-throwing when no key present (factory conformance). The
 *   missing key surfaces as MissingKeyError on the first embed()/healthCheck().
 * - Returns Float32Array[] (one per input, in input order), each length = dim.
 *   Per-vector copy into a fresh Float32Array (no Buffer aliasing — lesson
 *   2026-05-03).
 */
import type { EmbeddingProvider } from "./types.js";
import type { HealthStatus } from "../types.js";
import { MissingKeyError } from "../types.js";
import { redactSecrets, type FetchLike } from "./gemini.js";

export const OPENAI_EMBED_DEFAULT_MODEL = "text-embedding-3-small";
/** Default dim for `text-embedding-3-small`. `text-embedding-3-large` supports 3072. */
export const OPENAI_EMBED_DEFAULT_DIM = 1536;
/** Per OpenAI public pricing 2026-05: $0.02 / 1M for 3-small, $0.13 / 1M for 3-large. */
export const OPENAI_EMBED_DEFAULT_COST = 0.02;
export const OPENAI_EMBED_MAX_TOKENS = 8191;

/** Default endpoint. Override for Together/OpenRouter/DeepInfra/local. */
export const OPENAI_EMBED_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIEmbeddingOpts {
  /** Override model. Default: text-embedding-3-small. */
  model?: string;
  /** Override output dimensions. Default: 1536. MUST equal the vec0 table dim. */
  dimensions?: number;
  /** Override API key. Else read OPENAI_API_KEY. */
  apiKey?: string;
  /** Injected fetch for tests; defaults to globalThis.fetch. */
  fetchFn?: FetchLike;
  /** Base URL override (no trailing slash). Default https://api.openai.com/v1. */
  baseUrl?: string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  public readonly name = "openai";
  public readonly model: string;
  public readonly dimensions: number;
  public readonly maxTokens: number = OPENAI_EMBED_MAX_TOKENS;
  public readonly costPerMillionTokens: number = OPENAI_EMBED_DEFAULT_COST;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OpenAIEmbeddingOpts = {}) {
    this.model = opts.model ?? OPENAI_EMBED_DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? OPENAI_EMBED_DEFAULT_DIM;
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? OPENAI_EMBED_DEFAULT_BASE_URL);
    // NON-throwing at construction (factory conformance). Key validated lazily.
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    const f = opts.fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error(
        "OpenAIEmbeddingProvider: no fetch available (Node<18?). Pass opts.fetchFn explicitly.",
      );
    }
    this.fetchFn = f;
  }

  public async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new MissingKeyError("openai", "OPENAI_API_KEY");
    }
    const url = `${this.baseUrl}/embeddings`;
    // `dimensions` is honoured by OpenAI text-embedding-3-* and most compatible
    // backends. Backends that ignore it must be paired with a matching model so
    // the returned length still equals `this.dimensions` (validated below).
    const body = JSON.stringify({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const redacted = redactSecrets(raw).slice(0, 200);
      throw new Error(
        `OpenAIEmbeddingProvider: HTTP ${res.status} ${res.statusText} — ${redacted}`,
      );
    }
    const parsed = (await res.json()) as OpenAIEmbeddingResponse;
    if (!parsed.data || !Array.isArray(parsed.data)) {
      throw new Error("OpenAIEmbeddingProvider: malformed response (no data[])");
    }
    if (parsed.data.length !== texts.length) {
      throw new Error(
        `OpenAIEmbeddingProvider: response count mismatch ` +
          `(got ${parsed.data.length}, expected ${texts.length})`,
      );
    }
    // OpenAI may return data out of order; sort by `index` to align with inputs.
    const ordered = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const out: Float32Array[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const values = ordered[i]?.embedding;
      if (!values || values.length !== this.dimensions) {
        throw new Error(
          `OpenAIEmbeddingProvider: response index ${i} dim mismatch ` +
            `(got ${values?.length ?? 0}, expected ${this.dimensions}). ` +
            `Set NOX_EMBEDDING_DIM/model to match the vec0 table dim.`,
        );
      }
      // Fresh Float32Array copy — never Buffer-view (Node pool aliasing corrupts
      // typed arrays under GC; lesson 2026-05-03).
      const f32 = new Float32Array(this.dimensions);
      for (let j = 0; j < this.dimensions; j++) {
        f32[j] = values[j] ?? 0;
      }
      out.push(f32);
    }
    return out;
  }

  public async healthCheck(): Promise<HealthStatus> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        ok: false,
        latencyMs: 0,
        error: "health: OPENAI_API_KEY unset (provider selected but no credentials)",
      };
    }
    try {
      // Cheapest real probe: GET /models (no token billing).
      const url = `${this.baseUrl}/models`;
      const res = await this.fetchFn(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          error: `health: HTTP ${res.status} ${res.statusText}`,
        };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, latencyMs, error: `health: ${redactSecrets(msg)}` };
    }
  }
}

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

interface OpenAIEmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}
