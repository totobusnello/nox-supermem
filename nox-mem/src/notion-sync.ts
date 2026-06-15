import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { NotionItem } from "./consolidate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTION_API = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2025-09-03";
const DATABASE_ID = "31d8e29911ab8163b718d7af565f2fcc";
const SYNC_LOG_PATH = resolve(__dirname, "..", "last-sync.json");

function getNotionToken(): string | null {
  // Token can also be supplied directly via NOX_NOTION_TOKEN env var
  if (process.env.NOX_NOTION_TOKEN) return process.env.NOX_NOTION_TOKEN.trim();
  const tokenPath = process.env.NOX_NOTION_TOKEN_PATH ?? "/root/.config/notion/api_key";
  try {
    return readFileSync(tokenPath, "utf-8").trim();
  } catch {
    console.error(`[WARN] Notion token not found at ${tokenPath} (set NOX_NOTION_TOKEN or NOX_NOTION_TOKEN_PATH)`);
    return null;
  }
}

async function createNotionPage(token: string, item: NotionItem): Promise<boolean> {
  try {
    const body = {
      parent: { database_id: DATABASE_ID },
      properties: {
        "Título": { title: [{ text: { content: item.title.substring(0, 100) } }] },
        "Data": { date: { start: item.date } },
        "Categoria": { select: { name: item.category } },
        "Conteúdo": { rich_text: [{ text: { content: item.content.substring(0, 2000) } }] },
        "Fonte": { rich_text: [{ text: { content: item.source } }] },
      },
    };

    const response = await fetch(NOTION_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[WARN] Notion API ${response.status}: ${err.substring(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[WARN] Notion sync failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Save items to log for manual sync-notion command
export function saveSyncLog(items: NotionItem[]): void {
  writeFileSync(SYNC_LOG_PATH, JSON.stringify(items, null, 2), "utf-8");
}

// Load items from last consolidation for manual sync
export function loadSyncLog(): NotionItem[] {
  if (!existsSync(SYNC_LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(SYNC_LOG_PATH, "utf-8")) as NotionItem[];
  } catch {
    return [];
  }
}

export async function syncToNotion(items: NotionItem[]): Promise<{ synced: number; failed: number }> {
  if (items.length === 0) return { synced: 0, failed: 0 };

  // Save items for manual re-sync
  saveSyncLog(items);

  const token = getNotionToken();
  if (!token) return { synced: 0, failed: items.length };

  let synced = 0;
  let failed = 0;

  for (const item of items) {
    const ok = await createNotionPage(token, item);
    if (ok) {
      synced++;
      console.log(`[INFO] Notion: "${item.title.substring(0, 50)}..." → ${item.category}`);
    } else {
      failed++;
    }
    await sleep(350); // Rate limit ~3 req/s
  }

  console.log(`[INFO] Notion sync: ${synced} synced, ${failed} failed`);
  return { synced, failed };
}
