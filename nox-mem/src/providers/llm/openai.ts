/**
 * src/providers/llm/openai.ts — OpenAI-compatible LLM provider (A3.1, real).
 *
 * Talks the OpenAI Chat Completions wire shape:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer <apiKey>
 *   body: { model, messages: [...], temperature?, max_tokens? }
 *   parse: choices[0].message.content
 *
 * Because the wire shape is the de-facto standard, this single class also drives
 * any OpenAI-compatible endpoint by overriding `baseUrl` + `model` + `apiKey`:
 *
 *   | Backend     | baseUrl                                  | example model            |
 *   |-------------|------------------------------------------|--------------------------|
 *   | OpenAI      | https://api.openai.com/v1   (default)    | gpt-4o-mini              |
 *   | DeepSeek    | https://api.deepseek.com/v1              | deepseek-chat            |
 *   | OpenRouter  | https://openrouter.ai/api/v1             | deepseek/deepseek-chat   |
 *   | Together    | https://api.together.xyz/v1              | meta-llama/Llama-3.3-70B |
 *   | local       | http://127.0.0.1:11434/v1 (ollama etc.)  | llama3.1                 |
 *
 * Design parity with GeminiLLMProvider:
 * - `fetch` (Node 18+), no SDK dependency. `fetchFn` injectable for tests.
 * - Key resolved from constructor arg → OPENAI_API_KEY env. Stored privately,
 *   never echoed in errors (redactSecrets()).
 * - Construction is NON-throwing when no key is present (factory-conformance:
 *   selecting the provider must not fail boot when the user keeps Gemini default
 *   but happens to set NOX_LLM_PROVIDER=openai without a key yet). The missing
 *   key surfaces as MissingKeyError on the first real call (complete/healthCheck)
 *   — never as a NotImplementedError; this is a live provider now.
 */
import type { LLMProvider, CompleteOpts, CompleteResult } from "./types.js";
import type { HealthStatus } from "../types.js";
import { MissingKeyError } from "../types.js";
import { redactSecrets, type FetchLike } from "../embedding/gemini.js";

export const OPENAI_LLM_DEFAULT_MODEL = "gpt-4o-mini";
export const OPENAI_LLM_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
};

/** Default endpoint. Override for DeepSeek/OpenRouter/Together/local. */
export const OPENAI_LLM_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAILLMOpts {
  /** Override model. Default: gpt-4o-mini. */
  model?: string;
  /** Override API key. Else read OPENAI_API_KEY. */
  apiKey?: string;
  /** Injected fetch for tests; defaults to globalThis.fetch. */
  fetchFn?: FetchLike;
  /**
   * Base URL override (no trailing slash). Default https://api.openai.com/v1.
   * Point this at any OpenAI-compatible endpoint; `/chat/completions` and
   * `/models` are appended.
   */
  baseUrl?: string;
  /** Override context window (else inferred from `model`, fallback 128k). */
  contextWindow?: number;
}

export class OpenAILLMProvider implements LLMProvider {
  public readonly name = "openai";
  public readonly model: string;
  public readonly contextWindow: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: OpenAILLMOpts = {}) {
    this.model = opts.model ?? OPENAI_LLM_DEFAULT_MODEL;
    this.contextWindow =
      opts.contextWindow ?? OPENAI_LLM_CONTEXT_WINDOWS[this.model] ?? 128_000;
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? OPENAI_LLM_DEFAULT_BASE_URL);
    // NON-throwing at construction (factory conformance). Key validated lazily.
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    const f = opts.fetchFn ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error(
        "OpenAILLMProvider: no fetch available (Node<18?). Pass opts.fetchFn explicitly.",
      );
    }
    this.fetchFn = f;
  }

  public async complete(opts: CompleteOpts): Promise<CompleteResult> {
    if (!opts.user || typeof opts.user !== "string") {
      throw new Error("OpenAILLMProvider.complete: `user` is required and must be a string");
    }
    if (!this.apiKey) {
      throw new MissingKeyError("openai", "OPENAI_API_KEY");
    }
    const t0 = Date.now();
    const url = `${this.baseUrl}/chat/completions`;
    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system && opts.system.length > 0) {
      messages.push({ role: "system", content: opts.system });
    }
    messages.push({ role: "user", content: opts.user });
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1500,
    };
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const redacted = redactSecrets(raw).slice(0, 200);
      throw new Error(
        `OpenAILLMProvider: HTTP ${res.status} ${res.statusText} — ${redacted}`,
      );
    }
    const parsed = (await res.json()) as OpenAIChatResponse;
    const latencyMs = Date.now() - t0;
    const text = parsed.choices?.[0]?.message?.content ?? "";
    const usage = parsed.usage ?? {};
    return {
      text,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      latencyMs,
    };
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
      // Cheapest real probe: GET /models (no token billing on OpenAI-compat APIs).
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

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
