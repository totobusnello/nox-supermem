/**
 * project-context-gen.ts - Auto-generate PROJECT_CONTEXT.md from memory chunks
 * Each project gets status extracted from latest memory entries
 */

import fs from "fs";
import path from "path";
import { getDb } from "./db.js";

const _ws_pcg = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
const PROJECTS_DIR = process.env.NOX_PROJECTS_DIR ?? (_ws_pcg + "/projects");
// NOX_KNOWN_PROJECTS: comma-separated project slugs for this operator.
// Default is empty — no personal project names ship in the open-source build.
// On the origin VPS set NOX_KNOWN_PROJECTS to restore original project list.
const KNOWN_PROJECTS = process.env.NOX_KNOWN_PROJECTS
  ? process.env.NOX_KNOWN_PROJECTS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

interface ProjectData {
  name: string;
  status: string;
  phase: string;
  lastUpdate?: string;
}

function extractProjectData(projectName: string): ProjectData {
  const db = getDb();
  const chunks = db.prepare(
    `SELECT chunk_text, source_date, chunk_type FROM chunks
     WHERE chunk_type = 'project' AND source_file LIKE ?
     ORDER BY source_date DESC LIMIT 10`
  ).all(`%${projectName}%`) as Array<{ chunk_text: string; source_date: string | null; chunk_type: string }>;

  const data: ProjectData = {
    name: projectName.replace(/-/g, " ").toUpperCase(),
    status: "—",
    phase: "—",
  };

  if (chunks.length > 0) {
    const lastChunk = chunks[0].chunk_text;
    if (lastChunk.includes("due diligence")) data.phase = "Due Diligence";
    else if (lastChunk.includes("estruturação")) data.phase = "Estruturação";
    else if (lastChunk.includes("operacional")) data.phase = "Operacional";
    else if (lastChunk.includes("ativo")) data.phase = "Ativo";
    data.lastUpdate = chunks[0].source_date || undefined;
  }

  return data;
}

function generateProjectMarkdown(data: ProjectData): string {
  return `# PROJECT_CONTEXT — ${data.name}

> Atualizar ao final de cada sessão com avanços relevantes.

## Status atual
- **Fase:** ${data.phase}
- **Última atualização:** ${data.lastUpdate ? new Date(data.lastUpdate).toLocaleDateString("pt-BR") : "—"}

## Progresso

| Item | Status | Responsável | Prazo |
|------|--------|-------------|-------|
| — | — | — | — |

## Decisões tomadas
<!-- Adicionar com data: YYYY-MM-DD: descrição -->

## Pendências
<!-- Adicionar com owner e prazo -->

## Histórico de atualizações
<!-- Formato: YYYY-MM-DD: o que mudou -->
`;
}

export function syncProjectContexts(): { updated: number; created: number; errors: number } {
  let updated = 0;
  let created = 0;
  let errors = 0;

  for (const project of KNOWN_PROJECTS) {
    try {
      const projectDir = path.join(PROJECTS_DIR, project);
      const contextPath = path.join(projectDir, "PROJECT_CONTEXT.md");

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const data = extractProjectData(project);
      const markdown = generateProjectMarkdown(data);

      if (fs.existsSync(contextPath)) {
        const existing = fs.readFileSync(contextPath, "utf-8");
        if (existing !== markdown) {
          fs.writeFileSync(contextPath, markdown);
          updated++;
        }
      } else {
        fs.writeFileSync(contextPath, markdown);
        created++;
      }
    } catch (err) {
      console.error(`[ERROR] Failed to sync project ${project}:`, (err as Error).message);
      errors++;
    }
  }

  return { updated, created, errors };
}

export function listProjects(): void {
  console.log("\nProjects:\n");
  const db = getDb();
  for (const project of KNOWN_PROJECTS) {
    const lastChunk = db.prepare(
      `SELECT source_date FROM chunks WHERE chunk_type = 'project' AND source_file LIKE ? ORDER BY source_date DESC LIMIT 1`
    ).get(`%${project}%`) as { source_date: string | null } | undefined;

    const dateStr = lastChunk?.source_date ? new Date(lastChunk.source_date).toLocaleDateString("pt-BR") : "—";
    console.log(`  • ${project.replace(/-/g, " ")} — última menção: ${dateStr}`);
  }
  console.log();
}
