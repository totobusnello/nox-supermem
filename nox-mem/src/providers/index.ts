/**
 * src/providers/index.ts — Public registry / factories (T2 + T8).
 *
 * Two factories drive provider selection:
 *   - selectEmbeddingProvider(name?)
 *   - selectLLMProvider(name?)
 *
 * Resolution order:
 *   1. explicit `name` arg
 *   2. env var `NOX_EMBEDDING_PROVIDER` / `NOX_LLM_PROVIDER`
 *   3. default = 'gemini' (D41)
 *
 * Model override:
 *   - `NOX_EMBEDDING_MODEL=text-embedding-3-large`  (alias: NOX_EMBED_MODEL)
 *   - `NOX_LLM_MODEL=gemini-2.5-flash`     (CLAUDE.md regra #3 — explicit only)
 *
 * OpenAI-compatible overrides (A3.1 — DeepSeek/OpenRouter/Together/local):
 *   LLM:
 *     - `NOX_LLM_BASE_URL`   (default https://api.openai.com/v1 for openai)
 *     - `NOX_LLM_API_KEY`    (fallback: GEMINI_API_KEY for gemini, OPENAI_API_KEY for openai)
 *   Embedding (canonical prefix is NOX_EMBEDDING_*; NOX_EMBED_* accepted as alias):
 *     - `NOX_EMBEDDING_BASE_URL` (alias NOX_EMBED_BASE_URL)
 *     - `NOX_EMBEDDING_API_KEY`  (alias NOX_EMBED_API_KEY; fallback GEMINI_API_KEY/OPENAI_API_KEY)
 *     - `NOX_EMBEDDING_DIM`      (alias NOX_EMBED_DIM) — MUST equal the vec0 table dim
 *
 * Boot-time health check (T8):
 *   - `bootProviderHealth({ embedding?, llm?, failFast? })`
 *   - failFast=true (default) throws `ProviderHealthError` on any down provider
 *   - failFast=false logs a warning via `onWarn` callback; caller continues
 *   - Driven by `NOX_PROVIDER_HEALTH_FAIL_FAST` env (default '1')
 *
 * Stubs (openai/anthropic/voyage) return `ok=false` from healthCheck() by
 * design. boot health by default ONLY probes the *selected* providers, NOT
 * every registered one — so a user who keeps Gemini defaults never gets
 * spurious failures from un-activated stubs.
 */
import type { EmbeddingProvider } from "./embedding/types.js";
import type { LLMProvider } from "./llm/types.js";
import {
  ProviderHealthError,
  UnknownProviderError,
  type HealthStatus,
} from "./types.js";

import { GeminiEmbeddingProvider } from "./embedding/gemini.js";
import { OpenAIEmbeddingProvider } from "./embedding/openai.js";
import { VoyageEmbeddingProvider } from "./embedding/voyage.js";

import { GeminiLLMProvider } from "./llm/gemini.js";
import { OpenAILLMProvider } from "./llm/openai.js";
import { AnthropicLLMProvider } from "./llm/anthropic.js";
import {
  buildFallbackChainFromEnv,
  type LLMFallbackChain,
  type FallbackChainOpts,
} from "./llm/chain.js";

// Re-exports — single import surface for the rest of the codebase.
export type { EmbeddingProvider } from "./embedding/types.js";
export type { LLMProvider, CompleteOpts, CompleteResult } from "./llm/types.js";
export type { HealthStatus } from "./types.js";
export {
  MissingKeyError,
  UnknownProviderError,
  NotImplementedError,
  ProviderHealthError,
} from "./types.js";

export const KNOWN_EMBEDDING_PROVIDERS = ["gemini", "openai", "voyage"] as const;
export const KNOWN_LLM_PROVIDERS = ["gemini", "openai", "anthropic"] as const;

export type EmbeddingProviderName = (typeof KNOWN_EMBEDDING_PROVIDERS)[number];
export type LLMProviderName = (typeof KNOWN_LLM_PROVIDERS)[number];

/**
 * Factory: returns an EmbeddingProvider.
 *
 * @param name explicit provider name; else `NOX_EMBEDDING_PROVIDER` env; else 'gemini'
 * @param env  optional env override (test seam)
 *
 * Throws `UnknownProviderError` if name is not in `KNOWN_EMBEDDING_PROVIDERS`.
 * May throw `MissingKeyError` (Gemini) at construction.
 */
export function selectEmbeddingProvider(
  name?: string,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const resolvedName = (
    name ?? env.NOX_EMBEDDING_PROVIDER ?? env.NOX_EMBED_PROVIDER ?? "gemini"
  ).trim();
  // Canonical NOX_EMBEDDING_*; NOX_EMBED_* accepted as a convenience alias.
  const model = env.NOX_EMBEDDING_MODEL ?? env.NOX_EMBED_MODEL;
  const baseUrl = env.NOX_EMBEDDING_BASE_URL ?? env.NOX_EMBED_BASE_URL;
  const dimRaw = env.NOX_EMBEDDING_DIM ?? env.NOX_EMBED_DIM;
  const dimensions =
    dimRaw && dimRaw.trim() !== "" ? Number(dimRaw) : undefined;
  switch (resolvedName) {
    case "gemini": {
      // Pass apiKey through so a test-env arg fully isolates from real process.env.
      const apiKey =
        env.NOX_EMBEDDING_API_KEY ?? env.NOX_EMBED_API_KEY ?? env.GEMINI_API_KEY;
      return new GeminiEmbeddingProvider({ model, apiKey, baseUrl, dimensions });
    }
    case "openai": {
      const apiKey =
        env.NOX_EMBEDDING_API_KEY ?? env.NOX_EMBED_API_KEY ?? env.OPENAI_API_KEY;
      return new OpenAIEmbeddingProvider({ model, apiKey, baseUrl, dimensions });
    }
    case "voyage":
      return new VoyageEmbeddingProvider({ model });
    default:
      throw new UnknownProviderError(resolvedName, KNOWN_EMBEDDING_PROVIDERS);
  }
}

/**
 * Factory: returns an LLMProvider.
 *
 * @param name explicit provider name; else `NOX_LLM_PROVIDER` env; else 'gemini'
 * @param env  optional env override (test seam)
 *
 * Throws `UnknownProviderError` if unknown. Gemini may throw `MissingKeyError`
 * at construction.
 *
 * Default model for gemini is `gemini-2.5-flash-lite` (D41). Override via
 * `NOX_LLM_MODEL` env (CLAUDE.md regra #3: switching to flash full is opt-in).
 */
export function selectLLMProvider(
  name?: string,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  const resolvedName = (name ?? env.NOX_LLM_PROVIDER ?? "gemini").trim();
  const model = env.NOX_LLM_MODEL;
  const baseUrl = env.NOX_LLM_BASE_URL;
  switch (resolvedName) {
    case "gemini": {
      const apiKey = env.NOX_LLM_API_KEY ?? env.GEMINI_API_KEY;
      return new GeminiLLMProvider({ model, apiKey, baseUrl });
    }
    case "openai": {
      const apiKey = env.NOX_LLM_API_KEY ?? env.OPENAI_API_KEY;
      return new OpenAILLMProvider({ model, apiKey, baseUrl });
    }
    case "anthropic":
      return new AnthropicLLMProvider({ model });
    default:
      throw new UnknownProviderError(resolvedName, KNOWN_LLM_PROVIDERS);
  }
}

/**
 * Select the primary LLM provider AND, if `NOX_LLM_FALLBACK` is set, wrap it in
 * an env-driven fallback chain — injecting `selectLLMProvider` as the factory so
 * `chain.ts` stays free of a circular import.
 *
 * Returns the bare primary provider when no fallback is configured. Either way
 * the result implements `LLMProvider`, so callers can swap this in for
 * `selectLLMProvider()` transparently.
 */
export function selectLLMProviderWithFallback(
  name?: string,
  env: NodeJS.ProcessEnv = process.env,
  chainOpts?: Omit<FallbackChainOpts, "primary" | "fallbacks">,
): LLMProvider | LLMFallbackChain {
  const primary = selectLLMProvider(name, env);
  const chain = buildFallbackChainFromEnv(
    primary,
    (n, e) => selectLLMProvider(n, e ?? env),
    env,
    chainOpts,
  );
  return chain ?? primary;
}

// ─── T8 Boot-time health check ──────────────────────────────────────────────

export interface BootHealthOpts {
  embedding?: EmbeddingProvider;
  llm?: LLMProvider;
  /** Override env-driven fail-fast (`NOX_PROVIDER_HEALTH_FAIL_FAST=0` to soft-warn). */
  failFast?: boolean;
  /** Per-probe timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Hook for soft-warn mode; receives `{providerName, kind, error}`. */
  onWarn?: (warning: { providerName: string; kind: "embedding" | "llm"; error: string }) => void;
  /** Env override for tests. */
  env?: NodeJS.ProcessEnv;
}

export interface BootHealthReport {
  embedding?: HealthStatus & { providerName: string };
  llm?: HealthStatus & { providerName: string };
  /** True iff every probed provider returned ok=true. */
  allOk: boolean;
}

/**
 * Probe configured providers and (by default) throw if any are down.
 *
 * Returns a structured report regardless of failFast: in soft-warn mode
 * the caller gets the full picture and can decide. In fail-fast mode the
 * report is also returned (alongside the throw) so caller's stack trace
 * shows the actual probe latencies for forensics.
 */
export async function bootProviderHealth(
  opts: BootHealthOpts = {},
): Promise<BootHealthReport> {
  const env = opts.env ?? process.env;
  const failFast =
    opts.failFast ?? !(env.NOX_PROVIDER_HEALTH_FAIL_FAST === "0");
  const timeoutMs = opts.timeoutMs ?? 5000;

  const report: BootHealthReport = { allOk: true };
  const downs: string[] = [];

  if (opts.embedding) {
    const e = opts.embedding;
    const status = await probeWithTimeout(() => e.healthCheck(), timeoutMs);
    report.embedding = { ...status, providerName: e.name };
    if (!status.ok) {
      report.allOk = false;
      downs.push(`embedding:${e.name} (${status.error ?? "unknown"})`);
      opts.onWarn?.({
        providerName: e.name,
        kind: "embedding",
        error: status.error ?? "unknown",
      });
    }
  }

  if (opts.llm) {
    const l = opts.llm;
    const status = await probeWithTimeout(() => l.healthCheck(), timeoutMs);
    report.llm = { ...status, providerName: l.name };
    if (!status.ok) {
      report.allOk = false;
      downs.push(`llm:${l.name} (${status.error ?? "unknown"})`);
      opts.onWarn?.({
        providerName: l.name,
        kind: "llm",
        error: status.error ?? "unknown",
      });
    }
  }

  if (failFast && downs.length > 0) {
    throw new ProviderHealthError(downs.map((d) => d.split(" ")[0] ?? d).join(", "), downs.join("; "));
  }
  return report;
}

/** Wrap a probe in a hard timeout so a hung provider can't block boot forever. */
async function probeWithTimeout(
  fn: () => Promise<HealthStatus>,
  timeoutMs: number,
): Promise<HealthStatus> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<HealthStatus>([
      fn(),
      new Promise<HealthStatus>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`health probe timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs: Date.now() - t0, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
