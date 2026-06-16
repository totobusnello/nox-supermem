/**
 * CLI: snapshot-main — Fase 4 / Gap A (2026-05-15).
 *
 * Cria snapshot do main DB via withOpAudit (callback no-op) → resulta em
 * VACUUM INTO atômico + integrity_check + rename + ops_audit row registrada.
 *
 * Forge Q1 sign-off (2026-05-15): sqlite3 CLI standalone NÃO carrega vec0.so,
 * snapshot do main precisa rodar em app context (better-sqlite3 + extension loaded
 * pela db.ts). Este script é o app context correto.
 *
 * Spec: plans/2026-05-15-op-audit-gaps-review.md §10.6 Q1+Q2
 *
 * Uso (origin VPS, via /root/.openclaw/scripts/snapshot-main-db.sh):
 *   NOX_DB_SOURCE=main \
 *   NOX_PRE_OP_SNAPSHOT_DIR=/var/backups/nox-mem/daily-main \
 *     node dist/cli/snapshot-main.js
 *
 * Standalone (2026-06-15): NOX_PRE_OP_SNAPSHOT_DIR is optional. If unset, the snapshot
 * lands in the configured default (op-audit computeDefaultSnapshotDir): origin →
 * /var/backups/nox-mem/pre-op; standalone → <NOX_MEM_DIR or DB dir>/.nox-snapshots.
 * The dir must fall inside NOX_OP_AUDIT_ALLOWED_PREFIXES (auto-includes the operator's
 * NOX_DB_PATH/NOX_MEM_DIR dirs by default). Example:
 *   NOX_DB_SOURCE=main NOX_MEM_DIR=/home/op/nox-mem \
 *     node dist/cli/snapshot-main.js
 *
 * Output: snapshot em <snapshot dir>/daily-main-main-<ts>-<pid>-<uid>.db
 * (naming inclui dbSource via Fase 1 — pattern "daily-main-main-..." é correto:
 *  opName=daily-main, dbSource=main).
 */

import { withOpAudit } from "../lib/op-audit.js";

async function main(): Promise<void> {
  console.log("[snapshot-main] starting daily main DB snapshot via withOpAudit");

  const result = await withOpAudit("daily-main", async () => {
    // Callback no-op: withOpAudit já cria snapshot atômico ANTES de invocar o callback.
    // Não há mutação no DB — apenas o snapshot fica como artefato.
    return {
      affected_rows: 0,
      notes: "daily main snapshot — no DB mutation, snapshot artifact only",
    };
  });

  console.log("[snapshot-main] complete ✅");
  console.log("[snapshot-main] result:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[snapshot-main] FAILED:", err);
  process.exit(1);
});
