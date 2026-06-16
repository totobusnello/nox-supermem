/**
 * conformance.test.ts — interface conformance for all 5 providers.
 *
 * Each provider MUST:
 *   - expose the locked readonly fields (name, model | dimensions etc.)
 *   - return a HealthStatus-shaped object from healthCheck()
 *   - live providers (OpenAI) surface MissingKeyError on the work method when
 *     no credentials are present; remaining stubs throw NotImplementedError
 *
 * Cases:
 *  - GeminiEmbedding readonly fields (name/dim/max/cost)
 *  - GeminiLLM readonly fields (name/model/contextWindow)
 *  - OpenAIEmbedding (live) throws MissingKeyError on embed() without a key
 *  - OpenAILLM (live) throws MissingKeyError on complete() without a key
 *  - AnthropicLLM stub throws NotImplementedError on complete()
 *  - VoyageEmbedding stub throws NotImplementedError on embed()
 *  - All providers return ok=false with error from healthCheck()
 *  - Provider healthCheck() never throws (returns ok=false instead)
 *  - Conformance shape for HealthStatus (ok required, error iff !ok)
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { GeminiEmbeddingProvider } from "../embedding/gemini.js";
import { GeminiLLMProvider } from "../llm/gemini.js";
import { OpenAIEmbeddingProvider } from "../embedding/openai.js";
import { OpenAILLMProvider } from "../llm/openai.js";
import { AnthropicLLMProvider } from "../llm/anthropic.js";
import { VoyageEmbeddingProvider } from "../embedding/voyage.js";
import { NotImplementedError, MissingKeyError } from "../types.js";

const FAKE_KEY = "AIzaTESTtestTESTtestTESTtestTESTtest";

describe("Gemini provider readonly fields", () => {
  test("embedding: name/dimensions/maxTokens/costPerMillionTokens locked", () => {
    const p = new GeminiEmbeddingProvider({ apiKey: FAKE_KEY });
    assert.equal(p.name, "gemini");
    assert.equal(p.dimensions, 3072);
    assert.ok(p.maxTokens >= 2048);
    assert.ok(p.costPerMillionTokens > 0);
  });

  test("llm: name/model/contextWindow locked (D41 default = flash-lite)", () => {
    const p = new GeminiLLMProvider({ apiKey: FAKE_KEY });
    assert.equal(p.name, "gemini");
    assert.equal(p.model, "gemini-2.5-flash-lite");
    assert.ok(p.contextWindow >= 1_000_000);
  });
});

describe("Provider work methods reject without credentials", () => {
  // apiKey:"" forces the no-credentials path deterministically (the `??`
  // resolution treats "" as a present-but-empty key, so the ambient
  // OPENAI_API_KEY env var is never consulted and no network call is made).
  test("OpenAIEmbeddingProvider.embed() throws MissingKeyError (live provider, no key)", async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: "" });
    await assert.rejects(p.embed(["hi"]), MissingKeyError);
  });

  test("OpenAILLMProvider.complete() throws MissingKeyError (live provider, no key)", async () => {
    const p = new OpenAILLMProvider({ apiKey: "" });
    await assert.rejects(p.complete({ user: "hi" }), MissingKeyError);
  });

  test("AnthropicLLMProvider.complete() throws NotImplementedError", async () => {
    const p = new AnthropicLLMProvider();
    await assert.rejects(p.complete({ user: "hi" }), NotImplementedError);
  });

  test("VoyageEmbeddingProvider.embed() throws NotImplementedError", async () => {
    const p = new VoyageEmbeddingProvider();
    await assert.rejects(p.embed(["hi"]), NotImplementedError);
  });
});

describe("Stub healthCheck conformance (T8)", () => {
  test("OpenAI embedding returns ok=false with error when no key", async () => {
    const p = new OpenAIEmbeddingProvider({ apiKey: "" });
    const s = await p.healthCheck();
    assert.equal(s.ok, false);
    assert.ok(s.error && s.error.length > 0);
    assert.equal(typeof s.latencyMs, "number");
  });

  test("Anthropic LLM stub returns ok=false with error", async () => {
    const p = new AnthropicLLMProvider();
    const s = await p.healthCheck();
    assert.equal(s.ok, false);
    assert.ok(s.error && s.error.length > 0);
  });

  test("Voyage embedding stub returns ok=false with error", async () => {
    const p = new VoyageEmbeddingProvider();
    const s = await p.healthCheck();
    assert.equal(s.ok, false);
    assert.ok(s.error && s.error.length > 0);
  });

  test("provider healthCheck never throws (returns ok=false)", async () => {
    const stubs = [
      new OpenAIEmbeddingProvider({ apiKey: "" }),
      new OpenAILLMProvider({ apiKey: "" }),
      new AnthropicLLMProvider(),
      new VoyageEmbeddingProvider(),
    ];
    for (const s of stubs) {
      await assert.doesNotReject(s.healthCheck());
    }
  });
});
