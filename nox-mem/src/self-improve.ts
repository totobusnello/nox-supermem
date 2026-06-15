/**
 * self-improve.ts — Agent self-improvement via retrospective analysis
 * Analyzes recent decisions vs lessons, identifies patterns, suggests SOUL updates
 */
import Database from "better-sqlite3";
import { getDb } from "./db.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// NOX_AGENTS_DIR: base dir for agent sub-dirs. When absent on disk, functions
// degrade gracefully (existsSync / try-catch guards throughout).
const AGENTS_DIR = process.env.NOX_AGENTS_DIR ?? "/root/.openclaw/agents";
// NOX_AGENTS: comma-separated agent names. Empty list = no cross-agent analysis.
const AGENT_NAMES: string[] = process.env.NOX_AGENTS
  ? process.env.NOX_AGENTS.split(",").map(s => s.trim()).filter(Boolean)
  : ["nox", "atlas", "boris", "cipher", "forge", "lex"];

interface Insight {
  agent: string;
  type: "pattern" | "contradiction" | "gap" | "strength";
  description: string;
  evidence: string;
  suggestion?: string;
}

function findContradictions(): Insight[] {
  const db = getDb();
  const insights: Insight[] = [];

  const decisions = db.prepare(`
    SELECT chunk_text, source_file, source_date FROM chunks
    WHERE chunk_type = 'decision' ORDER BY id DESC LIMIT 30
  `).all() as Array<{ chunk_text: string; source_file: string; source_date: string }>;

  const lessons = db.prepare(`
    SELECT chunk_text, source_file FROM chunks
    WHERE chunk_type = 'lesson' ORDER BY id DESC LIMIT 30
  `).all() as Array<{ chunk_text: string; source_file: string }>;

  for (const decision of decisions) {
    const dWords = new Set(decision.chunk_text.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    for (const lesson of lessons) {
      const lWords = lesson.chunk_text.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const overlap = lWords.filter(w => dWords.has(w));

      if (overlap.length >= 5) {
        const hasNeg = (text: string) => /não|nunca|evitar|proibido|errado|falha|bug|erro/i.test(text);
        if (hasNeg(decision.chunk_text) !== hasNeg(lesson.chunk_text)) {
          insights.push({
            agent: "system",
            type: "contradiction",
            description: "Decision may contradict a learned lesson",
            evidence: `Decision: "${decision.chunk_text.substring(0, 100)}..."\nLesson: "${lesson.chunk_text.substring(0, 100)}..."`,
            suggestion: "Review if this decision accounts for the lesson learned",
          });
        }
      }
    }
  }
  return insights;
}

function findPatterns(): Insight[] {
  const db = getDb();
  const insights: Insight[] = [];

  const decisions = db.prepare(`
    SELECT chunk_text, source_date FROM chunks
    WHERE chunk_type = 'decision' AND source_date >= date('now', '-14 days')
    ORDER BY source_date DESC
  `).all() as Array<{ chunk_text: string; source_date: string }>;

  const topicCounts = new Map<string, number>();
  for (const d of decisions) {
    const words = d.chunk_text.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 5 && !/decisão|projeto|sistema|porque|quando|sempre/i.test(w));
    for (const w of words) {
      topicCounts.set(w, (topicCounts.get(w) || 0) + 1);
    }
  }

  for (const [topic, count] of topicCounts) {
    if (count >= 3) {
      insights.push({
        agent: "system",
        type: "pattern",
        description: `Topic "${topic}" appears in ${count} recent decisions`,
        evidence: `${count} decisions in last 14 days reference "${topic}"`,
        suggestion: `Consider adding a permanent rule about "${topic}" to SOUL.md`,
      });
    }
  }
  return insights;
}

function findGaps(): Insight[] {
  const insights: Insight[] = [];
  const db = getDb();

  const lessons = db.prepare(`
    SELECT chunk_text FROM chunks
    WHERE chunk_type = 'lesson' AND source_date >= date('now', '-14 days')
  `).all() as Array<{ chunk_text: string }>;

  for (const agent of AGENT_NAMES) {
    const soulPath = resolve(AGENTS_DIR, agent, "SOUL.md");
    if (!existsSync(soulPath)) {
      insights.push({
        agent, type: "gap",
        description: `${agent} has no SOUL.md`,
        evidence: `Missing: ${soulPath}`,
        suggestion: `Create SOUL.md for ${agent}`,
      });
      continue;
    }

    const soul = readFileSync(soulPath, "utf-8").toLowerCase();

    for (const lesson of lessons) {
      const keywords = lesson.chunk_text.toLowerCase()
        .split(/\s+/).filter(w => w.length > 5).slice(0, 5);

      const relevantToAgent = lesson.chunk_text.toLowerCase().includes(agent.toLowerCase());
      if (relevantToAgent) {
        const keywordInSoul = keywords.filter(k => soul.includes(k)).length;
        if (keywordInSoul < 2) {
          insights.push({
            agent, type: "gap",
            description: `Recent lesson not reflected in ${agent}'s SOUL.md`,
            evidence: `Lesson: "${lesson.chunk_text.substring(0, 120)}..."`,
            suggestion: `Add relevant rule to ${agent}'s SOUL.md`,
          });
        }
      }
    }
  }
  return insights;
}

function findStrengths(): Insight[] {
  const insights: Insight[] = [];

  for (const agent of AGENT_NAMES) {
    const agentDb = resolve(AGENTS_DIR, agent, "tools", "nox-mem", "nox-mem.db");
    if (!existsSync(agentDb)) continue;

    try {
      const adb = new Database(agentDb, { readonly: true });
      const count = (adb.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
      const types = adb.prepare(
        "SELECT chunk_type, COUNT(*) as c FROM chunks GROUP BY chunk_type ORDER BY c DESC LIMIT 3"
      ).all() as Array<{ chunk_type: string; c: number }>;
      adb.close();

      if (count > 50) {
        insights.push({
          agent, type: "strength",
          description: `${agent} has ${count} memory chunks`,
          evidence: `Top types: ${types.map(t => `${t.chunk_type}:${t.c}`).join(", ")}`,
        });
      }
    } catch {}
  }
  return insights;
}

export async function selfImprove(): Promise<string> {
  const allInsights: Insight[] = [
    ...findContradictions(),
    ...findPatterns(),
    ...findGaps(),
    ...findStrengths(),
  ];

  if (allInsights.length === 0) {
    return "No improvement insights found. System operating consistently.";
  }

  const lines = ["=== Agent Self-Improvement Report ===\n"];

  const byType = {
    contradiction: allInsights.filter(i => i.type === "contradiction"),
    pattern: allInsights.filter(i => i.type === "pattern"),
    gap: allInsights.filter(i => i.type === "gap"),
    strength: allInsights.filter(i => i.type === "strength"),
  };

  if (byType.contradiction.length > 0) {
    lines.push(`\n## CONTRADICTIONS (${byType.contradiction.length}):`);
    for (const i of byType.contradiction) {
      lines.push(`  ${i.description}`);
      lines.push(`  Evidence: ${i.evidence.substring(0, 200)}`);
      if (i.suggestion) lines.push(`  > ${i.suggestion}\n`);
    }
  }

  if (byType.pattern.length > 0) {
    lines.push(`\n## RECURRING PATTERNS (${byType.pattern.length}):`);
    for (const i of byType.pattern) {
      lines.push(`  ${i.description}`);
      if (i.suggestion) lines.push(`  > ${i.suggestion}`);
    }
  }

  if (byType.gap.length > 0) {
    lines.push(`\n## GAPS (${byType.gap.length}):`);
    for (const i of byType.gap) {
      lines.push(`  [${i.agent}] ${i.description}`);
      if (i.suggestion) lines.push(`  > ${i.suggestion}`);
    }
  }

  if (byType.strength.length > 0) {
    lines.push(`\n## STRENGTHS (${byType.strength.length}):`);
    for (const i of byType.strength) {
      lines.push(`  [${i.agent}] ${i.description} — ${i.evidence}`);
    }
  }

  lines.push(`\n---\nTotal insights: ${allInsights.length}`);
  return lines.join("\n");
}
