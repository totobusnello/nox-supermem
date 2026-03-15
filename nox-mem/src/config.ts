import { resolve, dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Diretório do módulo (equivalente a __dirname em ESM)
const __dirname = dirname(fileURLToPath(import.meta.url));

// Raiz do projeto nox-mem (um nível acima de src/)
const PROJECT_ROOT = resolve(__dirname, "..");

export interface SupermemConfig {
  workspace: string;
  promptsDir: string;
  dbPath: string;
  ollama: {
    url: string;
    model: string;
  };
  notion: {
    enabled: boolean;
    token: string;
    databaseId: string;
    apiVersion: string;
  };
  consolidation: {
    maxFilesPerRun: number;
    timeoutMs: number;
    retries: number;
  };
  watcher: {
    debounceMs: number;
    excludeFiles: string[];
  };
}

// Cache do singleton
let cached: SupermemConfig | null = null;

/**
 * Detecta o workspace seguindo a cadeia de prioridade:
 * 1. config.json na raiz do projeto
 * 2. Variável de ambiente $OPENCLAW_WORKSPACE
 * 3. Comando `openclaw config get workspace`
 * 4. Fallback: ~/.openclaw/workspace
 */
function detectWorkspace(fileConfig: Record<string, unknown>): string {
  // 1. config.json
  if (typeof fileConfig.workspace === "string" && fileConfig.workspace) {
    return resolveHome(fileConfig.workspace);
  }

  // 2. Variável de ambiente
  const envVal = process.env.OPENCLAW_WORKSPACE;
  if (envVal) {
    return resolveHome(envVal);
  }

  // 3. Comando CLI (string literal fixa — sem risco de injeção)
  try {
    const result = execSync("openclaw config get workspace", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result) return resolveHome(result);
  } catch {
    // Comando não disponível — segue para fallback
  }

  // 4. Fallback
  return resolve(homedir(), ".openclaw", "workspace");
}

/** Resolve ~ para o diretório home do usuário */
function resolveHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/** Carrega config.json da raiz do projeto, retorna {} se não existir */
function loadFileConfig(): Record<string, unknown> {
  const configPath = resolve(PROJECT_ROOT, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Retorna a configuração do Supermem (singleton, carrega uma vez) */
export function getConfig(): SupermemConfig {
  if (cached) return cached;

  const file = loadFileConfig();
  const workspace = detectWorkspace(file);

  const ollama = (file.ollama ?? {}) as Record<string, unknown>;
  const notion = (file.notion ?? {}) as Record<string, unknown>;
  const consolidation = (file.consolidation ?? {}) as Record<string, unknown>;
  const watcher = (file.watcher ?? {}) as Record<string, unknown>;

  cached = {
    workspace,
    promptsDir: resolve(PROJECT_ROOT, "prompts"),
    dbPath: resolve(workspace, "tools", "nox-mem", "nox-mem.db"),
    ollama: {
      url: String(ollama.url ?? "http://localhost:11434"),
      model: String(ollama.model ?? "llama3.2:3b"),
    },
    notion: {
      enabled: Boolean(notion.enabled ?? false),
      token: String(notion.token ?? ""),
      databaseId: String(notion.databaseId ?? ""),
      apiVersion: String(notion.apiVersion ?? "2025-09-03"),
    },
    consolidation: {
      maxFilesPerRun: Number(consolidation.maxFilesPerRun ?? 5),
      timeoutMs: Number(consolidation.timeoutMs ?? 120000),
      retries: Number(consolidation.retries ?? 3),
    },
    watcher: {
      debounceMs: Number(watcher.debounceMs ?? 3000),
      excludeFiles: Array.isArray(watcher.excludeFiles)
        ? (watcher.excludeFiles as string[])
        : ["MEMORY.md", "SESSION-STATE.md"],
    },
  };

  return cached;
}
