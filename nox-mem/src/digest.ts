import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { getConfig } from "./config.js";
import { execFileSync } from "child_process";
import { getDb } from "./db.js";


function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function callOllamaText(prompt: string, retries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(getConfig().ollama.url.replace(/\/api\/generate$/, "") + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: getConfig().ollama.model, prompt, stream: false, options: { temperature: 0.3 } }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        console.error(`[WARN] Ollama HTTP ${response.status} (attempt ${attempt}/${retries})`);
        continue;
      }
      const data = (await response.json()) as { response: string };
      if (data.response && data.response.trim().length > 10) return data.response;
      console.error(`[WARN] Empty response (attempt ${attempt}/${retries})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED")) { console.error("[WARN] Ollama offline"); return null; }
      console.error(`[WARN] Ollama error (attempt ${attempt}/${retries}): ${msg}`);
    }
  }
  console.error("[ERROR] Digest failed after all retries");
  return null;
}

export async function digest(): Promise<void> {
  const db = getDb();
  const promptTemplate = readFileSync(resolve(getConfig().promptsDir, "digest.txt"), "utf-8");
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const chunks = db.prepare(
    "SELECT chunk_text, source_file, chunk_type FROM chunks WHERE source_date >= ? AND chunk_type IN ('decision','lesson','person','project','pending','daily') ORDER BY source_date ASC"
  ).all(sevenDaysAgo) as Array<{ chunk_text: string; source_file: string; chunk_type: string }>;

  if (chunks.length === 0) {
    console.log("[INFO] No data from last 7 days for digest");
    return;
  }

  const fullText = chunks.map((c) => `[${c.chunk_type}] ${c.chunk_text}`).join("\n\n");
  const prompt = promptTemplate + fullText;

  const result = await callOllamaText(prompt);
  if (!result) return;

  const weekId = getISOWeek(new Date());
  const digestDir = resolve(getConfig().workspace, "memory", "digests");
  mkdirSync(digestDir, { recursive: true });

  const digestPath = resolve(digestDir, `${weekId}.md`);
  const content = `# Weekly Digest — ${weekId}\n\n*Gerado automaticamente em ${new Date().toISOString()}*\n\n${result}`;
  writeFileSync(digestPath, content, "utf-8");
  console.log(`[INFO] Digest saved to ${digestPath}`);

  try {
    execFileSync("git", ["-C", getConfig().workspace, "add", `memory/digests/${weekId}.md`], { stdio: "pipe" });
    execFileSync("git", ["-C", getConfig().workspace, "commit", "-m", `chore(memory): weekly digest ${weekId}`], { stdio: "pipe" });
    console.log(`[INFO] Git commit: weekly digest ${weekId}`);
  } catch {}
}
