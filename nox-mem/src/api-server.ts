#!/usr/bin/env node
/**
 * nox-mem API Server — lightweight HTTP API for dashboard consumption
 * Port 18800, CORS enabled, JSON responses
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { getDb, closeDb } from "./db.js";
import { searchHybrid } from "./search.js";
import { getGraphStats, formatEntityQuery } from "./knowledge-graph.js";
import { profileAllAgents, mergeCrossKnowledgeGraphs, findPath } from "./cross-agent-v2.js";
import { getStats } from "./stats.js";
import { reflect, getReflectCacheStats } from "./reflect.js";
import { crystallize, validateProcedure, listProcedures, type ValidationOptions } from "./crystallize.js";
import { getRetentionDistribution, countArchiveCandidates, getSalienceDistribution, getSectionDistribution } from "./tier-manager.js";
import { getSalienceMode, type SalienceMode } from "./salience.js";
import { getOpAuditStats, reapZombies } from "./lib/op-audit.js";
import { getVaultFacts } from "./lib/spo-injection.js";
import { getEvalMetricsSnapshot } from "./lib/eval.js";
import { execFileSync } from "child_process";
import { applyCorsHeaders, handlePreflight } from "./api/cors.js";
import { registerWireUpRoutes } from "./api/wire-up.js";
import { handleBrief } from "./api/brief.js";
import { handleIngestEvent } from "./api/ingest-event.js";
import {
  handleObsHealth,
  handleObsRecentOps,
  handleObsCanaryTail,
} from "./observability.js";
import { handleObsEvals } from "./evals.js";
import {
  recordRequest,
  handleObsTelemetry,
} from "./lib/telemetry-collector.js";
import {
  handleObsShadow,
  tracker as shadowTracker,
} from "./lib/shadow-tracker.js";
import { join } from "path";
import { readFileSync as fsReadFile, statSync as fsStat } from "fs";

const PORT = parseInt(process.env.NOX_API_PORT || "18800");
// Security 2026-04-23: bind to loopback by default (was 0.0.0.0).
// retentionDistribution + chunks/types fields are info-leak if exposed publicly
// in case UFW drops. Override via NOX_API_HOST=0.0.0.0 only if behind VPN/reverse proxy.
const HOST = process.env.NOX_API_HOST || "127.0.0.1";

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Name",
  });
  res.end(JSON.stringify(data));
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const part of url.substring(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

function readBody(req: IncomingMessage, limit = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Payload too large")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  try { return JSON.parse(raw) as T; }
  catch { throw new Error("Invalid JSON body"); }
}

const ALLOWED_SERVICES = new Set([
  "openclaw-gateway",
  "nox-mem-watch",
  "nox-mem-api",
  "ollama",
  "tailscaled",
  "relayplane-proxy",
]);

function serviceStatus(name: string): boolean {
  if (!ALLOWED_SERVICES.has(name)) return false;
  try {
    const out = execFileSync("systemctl", ["is-active", name], { encoding: "utf-8" });
    return out.trim() === "active";
  } catch { return false; }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (handlePreflight(req, res)) return;
  applyCorsHeaders(req, res);
  const url = req.url || "/";
  const path = url.split("?")[0];

  if (req.method === "OPTIONS") { json(res, {}); return; }

  // F2 Session Priming Loop (2026-06-04): token gate pro caminho tailnet.
  // `tailscale serve` proxia pro loopback e adiciona x-forwarded-for; chamadas
  // diretas de localhost (agentes, cron, watcher) NÃO carregam o header e
  // passam livres. Com NOX_API_TOKEN setado, request proxiada exige Bearer.
  // Defense-in-depth: o tailnet (WireGuard) já restringe a devices do operador.
  const apiToken = process.env.NOX_API_TOKEN;
  if (apiToken && req.headers["x-forwarded-for"]) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${apiToken}`) {
      json(res, { error: "unauthorized" }, 401);
      return;
    }
  }

  try {
    switch (path) {
      case "/api/health/lite": {
        // 2026-05-09: endpoint super-leve pra liveness check (health-probe cron */10).
        // Sem queries SQLite — apenas confirma que o event-loop está vivo + responde.
        // /api/health full continua disponível pra dashboards/morning-report,
        // mas em momentos de lock contention (canary-bundle */15 lê chunks/vec_chunk_map
        // simultaneamente) o /api/health full passava de 3s e o probe restartava a API
        // achando que estava morta. /lite resolve esse race.
        json(res, { ok: true, ts: new Date().toISOString(), pid: process.pid });
        return;
      }
      case "/api/health": {
        const db = getDb();
        const total = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
        const types = db.prepare("SELECT chunk_type, COUNT(*) as c FROM chunks GROUP BY chunk_type ORDER BY c DESC").all();
        const consolidated = db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = 1").get() as { c: number };
        const failed = db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = -1").get() as { c: number };
        const lastCon = db.prepare("SELECT MAX(processed_at) as d FROM consolidated_files").get() as { d: string | null };
        // Count ONLY vec_chunk_map entries whose chunk_id still exists in chunks.
        // Previously this counted all map rows (including orphans from consolidation/dedup
        // that never cleaned vec_chunk_map), silently claiming embeddings we don't have.
        let embedded = 0;
        let embeddingOrphans = 0;
        try {
          const sqliteVec = await import("sqlite-vec"); sqliteVec.load(db);
          embedded = (db.prepare(
            "SELECT COUNT(DISTINCT m.chunk_id) as c FROM vec_chunk_map m INNER JOIN chunks c ON c.id = m.chunk_id"
          ).get() as { c: number }).c;
          const totalMap = (db.prepare("SELECT COUNT(*) as c FROM vec_chunk_map").get() as { c: number }).c;
          embeddingOrphans = Math.max(0, totalMap - embedded);
        } catch {
          try {
            embedded = (db.prepare(
              "SELECT COUNT(DISTINCT m.chunk_id) as c FROM vec_chunk_map m INNER JOIN chunks c ON c.id = m.chunk_id"
            ).get() as { c: number }).c;
          } catch {}
        }

        // KG stats
        let kgEntities = 0, kgRelations = 0;
        try {
          kgEntities = (db.prepare("SELECT COUNT(*) as c FROM kg_entities").get() as { c: number }).c;
          kgRelations = (db.prepare("SELECT COUNT(*) as c FROM kg_relations").get() as { c: number }).c;
        } catch {}

        // Reflect cache stats (entries, total hits, top queries)
        let reflectCache: { entries: number; total_hits: number; top_queries: Array<{ query: string; hits: number; last_hit_at: string | null }> } = {
          entries: 0, total_hits: 0, top_queries: []
        };
        try { reflectCache = getReflectCacheStats(); } catch {}

        // Procedures count
        let procedures = 0;
        try {
          procedures = (db.prepare("SELECT COUNT(*) as c FROM chunks WHERE chunk_type = 'procedure'").get() as { c: number }).c;
        } catch {}

        // Fase 1.6 — search telemetry (last 24h rolling window)
        let searchTelemetry: {
          count_24h: number;
          avg_results: number;
          semantic_ratio: number;
          p95_latency_ms: number;
          expansion_enabled: boolean;
          skip_reasons: Record<string, number>;
        } = {
          count_24h: 0, avg_results: 0, semantic_ratio: 0, p95_latency_ms: 0,
          expansion_enabled: true, skip_reasons: {},
        };
        try {
          const agg = db.prepare(`
            SELECT COUNT(*) as c,
                   COALESCE(AVG(results_count), 0) as avg_r,
                   COALESCE(AVG(has_semantic), 0) as sem_ratio
            FROM search_telemetry
            WHERE ts >= datetime('now', '-24 hours')
          `).get() as { c: number; avg_r: number; sem_ratio: number };
          const latencies = db.prepare(`
            SELECT latency_ms FROM search_telemetry
            WHERE ts >= datetime('now', '-24 hours')
            ORDER BY latency_ms ASC
          `).all() as Array<{ latency_ms: number }>;
          const p95Idx = Math.max(0, Math.floor(latencies.length * 0.95) - 1);
          const p95 = latencies.length > 0 ? latencies[p95Idx].latency_ms : 0;
          const reasons = db.prepare(`
            SELECT expansion_skipped_reason as r, COUNT(*) as c
            FROM search_telemetry
            WHERE ts >= datetime('now', '-24 hours') AND expansion_skipped_reason IS NOT NULL
            GROUP BY expansion_skipped_reason
          `).all() as Array<{ r: string; c: number }>;
          const cfg = db.prepare("SELECT value FROM meta WHERE key = 'expansion_enabled'").get() as { value: string } | undefined;
          searchTelemetry = {
            count_24h: agg.c,
            avg_results: Math.round(agg.avg_r * 100) / 100,
            semantic_ratio: Math.round(agg.sem_ratio * 1000) / 1000,
            p95_latency_ms: p95,
            expansion_enabled: !cfg || (cfg.value !== "false" && cfg.value !== "0"),
            skip_reasons: Object.fromEntries(reasons.map((r) => [r.r, r.c])),
          };
        } catch {}

        const services = {
          "openclaw-gateway": serviceStatus("openclaw-gateway"),
          "nox-mem-watch": serviceStatus("nox-mem-watch"),
          "ollama": serviceStatus("ollama"),
          "tailscaled": serviceStatus("tailscaled"),
        };

        // Fase 1.7b-a — retention distribution + archive candidates (never-decay,
        // expiring in 30d/90d/365d windows, already expired, candidates for archive)
        let retentionDistribution: ReturnType<typeof getRetentionDistribution> = {
          never_decay: 0, expiring_30d: 0, expiring_90d: 0, expiring_365d: 0, expiring_later: 0, already_expired: 0,
        };
        let archiveCandidates = 0;
        try { retentionDistribution = getRetentionDistribution(db); } catch {}
        try { archiveCandidates = countArchiveCandidates(db); } catch {}

        // Fase 1.7b-b — salience distribution (shadow-mode read-only until
        // NOX_SALIENCE_MODE=active). Always computed for observability.
        let salienceDistribution: ReturnType<typeof getSalienceDistribution> = {
          promote_candidates: 0, retain: 0, review_needed: 0, archive_candidates: 0, mean: 0, median: 0,
        };
        let salienceMode: SalienceMode = "shadow";
        try { salienceDistribution = getSalienceDistribution(db); } catch {}
        try { salienceMode = getSalienceMode(); } catch {}

        // Fase 1.7b-c — section distribution (compiled truth vs timeline vs legacy)
        let sectionDistribution: ReturnType<typeof getSectionDistribution> = {
          compiled: 0, frontmatter: 0, timeline: 0, legacy: 0,
        };
        try { sectionDistribution = getSectionDistribution(db); } catch {}

        // A1 (2026-04-25): ops_audit stats for /api/health
        let opsAudit: ReturnType<typeof getOpAuditStats> = { total_24h: 0, success_24h: 0, failed_24h: 0, crashed_24h: 0, last_op: null, byDbSource: {} };
        try { opsAudit = getOpAuditStats(); } catch {}

        json(res, {
          chunks: { total, types },
          consolidation: { done: consolidated.c, failed: failed.c, last: lastCon.d },
          vectorCoverage: { embedded, total, orphans: embeddingOrphans },
          knowledgeGraph: { entities: kgEntities, relations: kgRelations },
          retentionDistribution,
          archiveCandidates,
          salience: { mode: salienceMode, ...salienceDistribution },
          sectionDistribution,
          reflectCache,
          procedures,
          searchTelemetry,
          opsAudit,
          services,
          dbSizeMB: Math.round((db.prepare("SELECT page_count * page_size as s FROM pragma_page_count(), pragma_page_size()").get() as { s: number }).s / 1024 / 1024 * 10) / 10,
        });
        break;
      }

      case "/api/observability/health": {
        const db = getDb();
        json(res, handleObsHealth(db));
        break;
      }

      case "/api/observability/recent-ops": {
        const db = getDb();
        const params = parseQuery(url);
        const n = parseInt(params.n || "10", 10);
        json(res, handleObsRecentOps(db, Number.isFinite(n) ? n : 10));
        break;
      }

      case "/api/observability/canary-tail": {
        const params = parseQuery(url);
        const n = parseInt(params.n || "3", 10);
        json(res, handleObsCanaryTail(Number.isFinite(n) ? n : 3));
        break;
      }

      case "/api/observability/evals": {
        const params = parseQuery(url);
        const limit = parseInt(params.limit || "500", 10);
        const dbSource = params.db_source || params.dbSource || undefined;
        // Explicit auditsRoot pointing to workspace-level audits dir
        // (default `cwd/../audits` resolves to `tools/audits` em VPS, errado).
        const workspace = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
        json(res, handleObsEvals(
          { dbSource, limit: Number.isFinite(limit) ? limit : 500 },
          { auditsRoot: `${workspace}/audits` },
        ));
        break;
      }

      case "/api/observability/telemetry": {
        // F10 Phase C Phase 1 (2026-05-24): in-process latency/throughput telemetry.
        const params = parseQuery(url);
        json(res, handleObsTelemetry(params));
        break;
      }

      case "/api/observability/shadow": {
        // F10 Phase D (2026-05-24): shadow-mode baseline-vs-candidate A/B comparisons.
        const params = parseQuery(url);
        json(res, handleObsShadow(params));
        break;
      }

      case "/observability/health.html":
      case "/observability/health.js":
      case "/observability/health.css":
      case "/observability/evals.html":
      case "/observability/evals.js":
      case "/observability/evals.css":
      case "/observability/telemetry.html":
      case "/observability/telemetry.js":
      case "/observability/telemetry.css":
      case "/observability/shadow.html":
      case "/observability/shadow.js":
      case "/observability/shadow.css":
      case "/observability/gate-annotations.json": {
        const filename = path.split("/").pop()!;
        const fullPath = join(process.cwd(), "public", "observability", filename);
        try {
          fsStat(fullPath);
          const body = fsReadFile(fullPath, "utf-8");
          const ext = filename.split(".").pop();
          const ct =
            ext === "html" ? "text/html; charset=utf-8" :
            ext === "js"   ? "application/javascript; charset=utf-8" :
            ext === "css"  ? "text/css; charset=utf-8" :
            ext === "json" ? "application/json; charset=utf-8" :
            "application/octet-stream";
          res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
          res.end(body);
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found");
        }
        break;
      }

      case "/api/agents": {
        json(res, profileAllAgents());
        break;
      }

      case "/api/kg": {
        const db = getDb();
        try {
          const entities = db.prepare("SELECT id, name, entity_type as type, mention_count as mentions FROM kg_entities ORDER BY mention_count DESC LIMIT 200").all();
          const relations = db.prepare(`
            SELECT e1.name as source, r.relation_type as relation, e2.name as target, r.confidence
            FROM kg_relations r
            JOIN kg_entities e1 ON e1.id = r.source_entity_id
            JOIN kg_entities e2 ON e2.id = r.target_entity_id
            ORDER BY r.confidence DESC LIMIT 500
          `).all();
          json(res, { entities, relations });
        } catch { json(res, { entities: [], relations: [] }); }
        break;
      }

      case "/api/kg/path": {
        const q = parseQuery(url);
        if (!q.from || !q.to) { json(res, { error: "from and to required" }, 400); break; }
        const result = findPath(q.from, q.to);
        json(res, { path: result });
        break;
      }

      case "/api/eval-metrics": {
        // R01a (2026-05-02): eval harness metrics surface.
        json(res, getEvalMetricsSnapshot());
        break;
      }

      case "/api/ingest-event": {
        // F4b Fluxo D (2026-06-04): write-side do Session Priming Loop —
        // digest de sessão vira chunk type=daily/90d, dedup por session_id.
        // Auth: token gate global (F2) já cobre o caminho proxiado.
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); break; }
        const body = await readJson<unknown>(req);
        const out = handleIngestEvent(getDb(), body);
        json(res, out.body, out.status);
        break;
      }

      case "/api/brief": {
        // F1 Session Priming Loop (2026-06-04): digest top-N por salience
        // filtrado por escopo. Spec: memoria-nox specs/2026-06-04-F1-*.md.
        const out = handleBrief(getDb(), parseQuery(url));
        if ("text" in out) {
          res.writeHead(out.status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(out.text);
        } else {
          json(res, out.body, out.status);
        }
        break;
      }
            case "/api/search": {
        // F10 Phase C Phase 1 (2026-05-24): in-process telemetry capture
        const _t0 = Date.now();
        // 2026-05-05 fix: accept both GET (query string) and POST (JSON body).
        // Previously POST silently failed with q-required because parseQuery only reads URL.
        let qText: string | undefined;
        let limitStr: string | undefined;
        let trackStr: string | undefined;
        if (req.method === "POST") {
          const body = await readJson<{ q?: string; query?: string; limit?: number | string; track?: boolean | string }>(req);
          qText = body.q ?? body.query;
          limitStr = body.limit !== undefined ? String(body.limit) : undefined;
          trackStr = body.track !== undefined ? String(body.track) : undefined;
        } else {
          const q = parseQuery(url);
          qText = q.q ?? q.query;
          limitStr = q.limit;
          trackStr = q.track;
        }
        if (!qText) { json(res, { error: "q parameter required (POST body or GET query string, field name: q or query)" }, 400); break; }
        const limit = parseInt(limitStr || "10");
        // D1 (2026-06-07): healthchecks/canary pass ?track=false so automated
        // probes don't inflate access_count → salience feedback loop. Default
        // true (genuine reads still update recency/access for salience).
        const trackAccess = !(trackStr === "false" || trackStr === "0");
        // E12 (2026-05-04): propagate requesting agent from header
        const agentHeader = req.headers["x-agent-name"];
        const requestingAgent = (Array.isArray(agentHeader) ? agentHeader[0] : agentHeader) ?? process.env.NOX_AGENT_NAME;
        const results = await searchHybrid(qText, limit, trackAccess);
        // E03a (2026-05-02): SPO injection envelope. Mode shadow → compute+log only.
        // Mode active → surface vaultFacts in response. Mode off → no compute.
        const vf = getVaultFacts(qText, getDb());
        // F10 Phase C: record request telemetry (fire-and-forget, sync, zero overhead).
        // searchHybrid returns Array<Result> directly OR { results: [...], meta: {...} }
        // depending on search.ts version. Probe both shapes; fall back safely.
        const _isArr = Array.isArray(results);
        const _resArr = _isArr
          ? (results as unknown[])
          : (results as { results?: unknown[] })?.results;
        const _meta = _isArr
          ? undefined
          : (results as { meta?: { path_used?: string; semantic_used?: boolean } })?.meta;
        const _pathUsed = _meta?.path_used ?? "hybrid";
        const _semantic = _meta?.semantic_used !== false; // default true
        recordRequest(
          "search",
          _t0,
          Date.now(),
          Array.isArray(_resArr) ? _resArr.length : 0,
          _pathUsed,
          _semantic,
        );
        if (vf.surface && vf.block) {
          json(res, { results, vaultFacts: vf.block });
        } else {
          json(res, results);
        }
        break;
      }

      case "/api/cross-kg": {
        json(res, mergeCrossKnowledgeGraphs());
        break;
      }

      case "/api/reflect": {
        const q = parseQuery(url);
        if (!q.q) { json(res, { error: "q parameter required" }, 400); break; }
        const noCache = q.nocache === "1" || q.nocache === "true";
        const result = await reflect(q.q, { noCache });
        json(res, result);
        break;
      }

      case "/api/procedures": {
        json(res, { procedures: listProcedures() });
        break;
      }

      case "/api/crystallize": {
        if (req.method !== "POST") { json(res, { error: "POST required" }, 405); break; }
        const body = await readJson<{
          title?: string; steps?: string[]; agent?: string;
          tags?: string[]; preconditions?: string[];
        }>(req);
        if (!body.title || !Array.isArray(body.steps) || body.steps.length === 0) {
          json(res, { error: "title and steps[] required" }, 400); break;
        }
        const id = await crystallize({
          title: body.title,
          steps: body.steps,
          agent: body.agent,
          tags: body.tags,
          preconditions: body.preconditions,
        });
        json(res, { id, ok: true });
        break;
      }

      case "/api/crystallize/validate": {
        if (req.method !== "POST") { json(res, { error: "POST required" }, 405); break; }
        const q = parseQuery(url);
        const id = parseInt(q.id || "0");
        if (!id) { json(res, { error: "id query param required" }, 400); break; }
        // Optional structured validation payload
        let opts: ValidationOptions = {};
        try {
          const body = await readJson<ValidationOptions>(req);
          if (body && typeof body === "object") {
            if (body.outcome && ["success","failure","partial"].includes(body.outcome)) opts.outcome = body.outcome;
            if (typeof body.agent === "string") opts.agent = body.agent;
            if (typeof body.notes === "string") opts.notes = body.notes;
          }
        } catch { /* no body, use defaults */ }
        try { validateProcedure(id, opts); json(res, { id, ok: true, applied: opts }); }
        catch (err) { json(res, { error: String(err) }, 404); }
        break;
      }

      default:
        if (await registerWireUpRoutes(req, res)) break;
        json(res, {
          error: "Not found",
          endpoints: [
            "/api/health", "/api/health/lite", "/api/agents", "/api/kg", "/api/kg/path",
            "/api/search", "/api/brief", "/api/ingest-event", "/api/cross-kg", "/api/reflect",
            "/api/procedures", "/api/crystallize", "/api/crystallize/validate",
            "/api/observability/health", "/api/observability/recent-ops",
            "/api/observability/canary-tail", "/observability/health.html",
            "/api/observability/evals", "/observability/evals.html",
            "/api/observability/telemetry", "/observability/telemetry.html",
            "/api/observability/shadow", "/observability/shadow.html",
            "/observability/gate-annotations.json"
          ]
        }, 404);
    }
  } catch (err) {
    json(res, { error: String(err) }, 500);
  }
}

const server = createServer(handleRequest);
server.listen(PORT, HOST, () => {
  console.log(`[nox-mem-api] Listening on http://${HOST}:${PORT}`);
  // A1 v2 (2026-04-25): reap zombie running rows de processos mortos antes do INSERT/UPDATE
  try {
    const reaped = reapZombies();
    if (reaped > 0) console.log(`[nox-mem-api] reaped ${reaped} zombie ops_audit rows on startup`);
  } catch (err) {
    console.error(`[nox-mem-api] reapZombies failed:`, err);
  }

  // F10 Phase D (2026-05-24): wire shared DB handle into the shadow tracker
  // singleton so append-only shadow_runs persistence is live for any caller
  // that invokes recordShadowComparison(). Schema was applied via out-of-band
  // migration (CHANGE 0 Option B in api-server.shadow-wire-up.md).
  try {
    shadowTracker.setDB(getDb());
    console.log(`[nox-mem-api] shadow tracker DB handle wired`);
  } catch (err) {
    console.error(`[nox-mem-api] shadow tracker setDB failed (persistence will fall back to in-memory only):`, err);
  }

  // D01 (2026-05-07): pre-warm reranker model se mode != off pra evitar p95 cold-start (~12-90s).
  // Spec specs/2026-05-07-D01-cross-encoder-reranker.md §risks §1. Single-shot, fire-and-forget.
  const rerankerMode = process.env.NOX_RERANKER_MODE ?? "off";
  if (rerankerMode === "shadow" || rerankerMode === "active") {
    import("./lib/reranker.js")
      .then(async (mod) => {
        const t0 = Date.now();
        await mod.preloadModel();
        console.log(`[nox-mem-api] reranker pre-warmed in ${Date.now() - t0}ms (mode=${rerankerMode})`);
      })
      .catch((err) => {
        console.error(`[nox-mem-api] reranker pre-warm failed (fail-open, lazy load on first call):`, err?.message ?? err);
      });
  }
});
