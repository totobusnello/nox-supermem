#!/usr/bin/env node
import { Command } from "commander";
import { search, formatResults } from "./search.js";
import { ingestFile } from "./ingest.js";
import { reindex } from "./reindex.js";
import { primer } from "./primer.js";
import { getStats } from "./stats.js";
import { closeDb } from "./db.js";

const program = new Command();

program.name("nox-mem").description("Nox Supermem — search, consolidate, recover").version("2.1.2");

program
  .command("search <query>")
  .description("Search memory (FTS5 + boost + recency)")
  .option("-n, --limit <n>", "Number of results", "5")
  .action((query: string, opts: { limit: string }) => {
    console.log(formatResults(search(query, parseInt(opts.limit, 10))));
    closeDb();
  });

program
  .command("ingest <file>")
  .description("Index a specific .md or .json file")
  .action((file: string) => {
    const result = ingestFile(file);
    console.log(`[INFO] Ingested ${file}: ${result.chunks} chunks`);
    closeDb();
  });

program
  .command("reindex")
  .description("Rebuild entire index from markdown files (preserves consolidation state)")
  .action(() => {
    const result = reindex();
    console.log(`[INFO] Reindexed ${result.files} files, ${result.chunks} chunks`);
  });

program
  .command("primer")
  .description("Generate context recovery summary (~500 tokens)")
  .action(() => {
    console.log(primer());
    closeDb();
  });

program
  .command("stats")
  .description("Show memory statistics")
  .action(() => {
    console.log(getStats());
    closeDb();
  });

program
  .command("consolidate")
  .description("Consolidate daily notes into topic files (requires Ollama)")
  .action(async () => {
    const { consolidate } = await import("./consolidate.js");
    const { syncToNotion } = await import("./notion-sync.js");
    const result = await consolidate();
    if (result.notionItems.length > 0) {
      await syncToNotion(result.notionItems);
    }
    if (result.remaining > 0) {
      console.log(`[INFO] ${result.remaining} daily notes still pending — run again or wait for next cron`);
    }
    closeDb();
  });

program
  .command("retry-failed")
  .description("Retry consolidation of previously failed daily notes")
  .action(async () => {
    const { consolidate } = await import("./consolidate.js");
    const { syncToNotion } = await import("./notion-sync.js");
    const result = await consolidate({ retryFailed: true });
    if (result.notionItems.length > 0) {
      await syncToNotion(result.notionItems);
    }
    closeDb();
  });

program
  .command("digest")
  .description("Generate weekly digest")
  .action(async () => {
    const { digest } = await import("./digest.js");
    await digest();
    closeDb();
  });

program
  .command("sync-notion")
  .description("Re-sync last consolidation items to Notion")
  .action(async () => {
    const { syncToNotion, loadSyncLog } = await import("./notion-sync.js");
    const items = loadSyncLog();
    if (items.length === 0) {
      console.log("[INFO] No items to sync — run consolidate first");
      return;
    }
    console.log(`[INFO] Re-syncing ${items.length} items from last consolidation...`);
    await syncToNotion(items);
  });

program
  .command("doctor")
  .description("Diagnostic check — Ollama, SQLite, FTS5, watcher, Notion")
  .action(async () => {
    const { doctor } = await import("./doctor.js");
    await doctor();
    closeDb();
  });

program.parse();
