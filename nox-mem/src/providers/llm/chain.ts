/**
 * src/providers/llm/chain.ts — LLM fallback chain (T9).
 *
 * `LLMFallbackChain` wraps a primary + ordered list of fallback providers.
 * Activation: gated by `NOX_LLM_FALLBACK` env var (otherwise primary-only).
 *
 * Retry / fallback policy (per A3 spec §T10):
 *   - primary timeout (default 30s) → try fallback[0], then fallback[1], etc.
 *   - HTTP 429 (rate limit) → mark primary cooldown 60s, try next provider
 *   - HTTP 401/403 (auth) → fail-fast, do NOT try fallback (user config bug)
 *   - max 1 retry per provider in a single call
 *   - `CompleteResult.providerId` filled so callers attribute telemetry correctly
 *
 * EMBEDDINGS ARE NOT CHAINED: mixing embedding providers mid-corpus silently
 * corrupts semantic search (A3 spec §5). Only LLM calls go through this chain.
 *
 * Building the chain from env:
 *   NOX_LLM_FALLBACK=anthropic:claude-3-5-haiku,openai:gpt-4o-mini
 *   → chain = [primary, anthropicProvider, openaiProvider]
 *
 * Use `buildFallbackChain(env?)` to construct from env vars.
 */
import type { LLMProvider, CompleteOpts, CompleteResult } from "./types.js";
import type { HealthStatus } from "../types.js";
import { redactSecrets } from "../embedding/gemini.js";

// ─── Error classification ────────────────────────────────────────────────────

/** HTTP status codes that are auth failures → fail-fast, no fallback. */
const AUTH_FAIL_STATUSES = new Set([401, 403]);

/** HTTP status codes that are rate-limited → try next provider. */
const RATE_LIMIT_STATUSES = new Set([429]);

/** Extract HTTP status from an error message if it was formatted by a provider. */
function extractHttpStatus(msg: string): number | null {
  const m = msg.match(/HTTP (\d{3})/);
  return m ? parseInt(m[1] ?? "0", 10) : null;
}

// ─── Cooldown tracker ────────────────────────────────────────────────────────

interface CooldownEntry {
  until: number; // Date.now() ms
}

const cooldownMap = new Map<string, CooldownEntry>();

/** True if provider is currently in rate-limit cooldown. */
function isCooledDown(providerId: string): boolean {
  const e = cooldownMap.get(providerId);
  if (!e) return false;
  if (Date.now() >= e.until) {
    cooldownMap.delete(providerId);
    return false;
  }
  return true;
}

/** Mark provider in rate-limit cooldown for `durationMs` (default 60s). */
function markCooldown(providerId: string, durationMs = 60_000): void {
  cooldownMap.set(providerId, { until: Date.now() + durationMs });
}

/** Clear all cooldowns (test utility). */
export function clearAllCooldowns(): void {
  cooldownMap.clear();
}

// ─── Telemetry event ─────────────────────────────────────────────────────────

export interface FallbackEvent {
  kind: "primary_ok" | "primary_fail_try_next" | "fallback_ok" | "all_fail" | "auth_fail";
  usedProviderId: string;
  attemptIndex: number; // 0 = primary
  errorKind?: "timeout" | "rate_limit" | "auth" | "network" | "unknown";
  latencyMs: number;
}

// ─── Core chain class ─────────────────────────────────────────────────────────

export interface FallbackChainOpts {
  /** Primary provider. REQUIRED. */
  primary: LLMProvider;
  /** Ordered fallbacks. Empty = no fallback (primary-only). */
  fallbacks?: LLMProvider[];
  /** Per-provider call timeout in ms. Default: 30_000. */
  timeoutMs?: number;
  /** Rate-limit cooldown in ms. Default: 60_000. */
  cooldownMs?: number;
  /** Optional telemetry callback. Never throws. */
  onEvent?: (event: FallbackEvent) => void;
}

export class LLMFallbackChain implements LLMProvider {
  public readonly name: string;
  public readonly model: string;
  public readonly contextWindow: number;

  private readonly primary: LLMProvider;
  private readonly fallbacks: LLMProvider[];
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly onEvent?: (event: FallbackEvent) => void;

  constructor(opts: FallbackChainOpts) {
    this.primary = opts.primary;
    this.fallbacks = opts.fallbacks ?? [];
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.onEvent = opts.onEvent;

    // Expose primary's identity as the chain's identity (D41: Gemini is default).
    this.name = opts.primary.name;
    this.model = opts.primary.model;
    this.contextWindow = opts.primary.contextWindow;
  }

  /** Attempt a `complete()` call on `provider` with timeout enforcement. */
  private async attemptProvider(
    provider: LLMProvider,
    opts: CompleteOpts,
  ): Promise<CompleteResult & { providerId: string }> {
    const t0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race<CompleteResult>([
        provider.complete(opts),
        new Promise<CompleteResult>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`provider timeout after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        }),
      ]);
      return { ...result, providerId: provider.name, latencyMs: Date.now() - t0 };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public async complete(
    opts: CompleteOpts,
  ): Promise<CompleteResult & { providerId: string }> {
    const all = [this.primary, ...this.fallbacks];
    let lastError: Error | undefined;

    for (let i = 0; i < all.length; i++) {
      const provider = all[i];
      if (!provider) continue;

      // Skip if still in rate-limit cooldown.
      if (isCooledDown(provider.name)) continue;

      const t0 = Date.now();
      try {
        const result = await this.attemptProvider(provider, opts);
        this.emit({
          kind: i === 0 ? "primary_ok" : "fallback_ok",
          usedProviderId: provider.name,
          attemptIndex: i,
          latencyMs: Date.now() - t0,
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - t0;
        const httpStatus = extractHttpStatus(msg);

        // Auth failures → fail-fast, do NOT try fallback (A3 spec §T10).
        if (httpStatus !== null && AUTH_FAIL_STATUSES.has(httpStatus)) {
          this.emit({
            kind: "auth_fail",
            usedProviderId: provider.name,
            attemptIndex: i,
            errorKind: "auth",
            latencyMs,
          });
          throw new Error(
            `LLMFallbackChain: auth failure on provider "${provider.name}" ` +
              `(HTTP ${httpStatus}). Refusing to try fallback — likely user config error. ` +
              `Check API key for ${provider.name.toUpperCase()}_API_KEY env var.`,
          );
        }

        // Rate limit → cooldown + try next.
        const errorKind: FallbackEvent["errorKind"] =
          httpStatus !== null && RATE_LIMIT_STATUSES.has(httpStatus)
            ? "rate_limit"
            : msg.includes("timeout")
              ? "timeout"
              : "unknown";

        if (errorKind === "rate_limit") {
          markCooldown(provider.name, this.cooldownMs);
        }

        this.emit({
          kind: "primary_fail_try_next",
          usedProviderId: provider.name,
          attemptIndex: i,
          errorKind,
          latencyMs,
        });

        // Redact before storing to prevent key leakage in re-thrown error.
        lastError = new Error(redactSecrets(msg));
      }
    }

    // All providers failed.
    this.emit({
      kind: "all_fail",
      usedProviderId: "(none)",
      attemptIndex: all.length,
      errorKind: "unknown",
      latencyMs: 0,
    });
    throw lastError ?? new Error("LLMFallbackChain: all providers failed (chain empty?)");
  }

  public async healthCheck(): Promise<HealthStatus> {
    // Report primary health only; fallbacks are secondary.
    return this.primary.healthCheck();
  }

  private emit(event: FallbackEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Telemetry callback must never propagate to caller.
    }
  }
}

// ─── Factory: build chain from env ───────────────────────────────────────────

/**
 * A factory that builds an LLM provider from a provider name + optional model
 * override. Normally `selectLLMProvider` from index.ts; injected here to keep
 * chain.ts free of a circular import (index.ts → chain.ts → index.ts).
 */
export type LLMProviderFactory = (
  name: string,
  env?: NodeJS.ProcessEnv,
) => LLMProvider;

/** One parsed `provider:model` (model optional) fallback spec. */
export interface FallbackSpec {
  provider: string;
  model?: string;
}

/** Parse `provider:model,provider2` → ordered FallbackSpec[]. */
export function parseFallbackSpec(raw: string): FallbackSpec[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx === -1) return { provider: entry };
      return {
        provider: entry.slice(0, idx).trim(),
        model: entry.slice(idx + 1).trim() || undefined,
      };
    })
    .filter((s) => s.provider.length > 0);
}

/**
 * Parse `NOX_LLM_FALLBACK` env var and build the LLMFallbackChain.
 *
 * Format: `NOX_LLM_FALLBACK=anthropic:claude-3-5-haiku,openai:gpt-4o-mini`
 * Each entry is `provider` or `provider:model`. Built in order; each becomes a
 * fallback after `primary`.
 *
 * Returns `null` when `NOX_LLM_FALLBACK` is not set (primary-only mode).
 *
 * @param factory  Provider factory (inject `selectLLMProvider`). Required when
 *                 NOX_LLM_FALLBACK is set — keeps chain.ts free of circular import.
 *                 When omitted with a non-empty fallback spec we throw so the
 *                 misconfiguration is loud rather than silently primary-only.
 */
export function buildFallbackChainFromEnv(
  primary: LLMProvider,
  factory: LLMProviderFactory | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts?: Omit<FallbackChainOpts, "primary" | "fallbacks">,
): LLMFallbackChain | null {
  const raw = env.NOX_LLM_FALLBACK;
  if (!raw || raw.trim() === "") return null;

  const specs = parseFallbackSpec(raw);
  if (specs.length === 0) return null;

  if (!factory) {
    throw new Error(
      "buildFallbackChainFromEnv: NOX_LLM_FALLBACK is set but no provider factory " +
        "was supplied. Pass `selectLLMProvider` (from providers/index.js) as the " +
        "factory argument.",
    );
  }

  // Per-entry model override is applied via a one-shot env clone so the factory's
  // existing NOX_LLM_MODEL resolution path is reused verbatim.
  const fallbacks: LLMProvider[] = specs.map((spec) => {
    const entryEnv: NodeJS.ProcessEnv = spec.model
      ? { ...env, NOX_LLM_MODEL: spec.model }
      : env;
    return factory(spec.provider, entryEnv);
  });

  return new LLMFallbackChain({ primary, fallbacks, ...opts });
}

/**
 * Build fallback chain using a provider factory (seam for tests and for index.ts).
 *
 * @param primary   Pre-constructed primary provider.
 * @param fallbacks Pre-constructed ordered fallback providers.
 * @param opts      Chain tuning options.
 */
export function buildFallbackChain(
  primary: LLMProvider,
  fallbacks: LLMProvider[],
  opts?: Omit<FallbackChainOpts, "primary" | "fallbacks">,
): LLMFallbackChain {
  return new LLMFallbackChain({ primary, fallbacks, ...opts });
}
