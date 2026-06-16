/**
 * Single source of truth for the package version.
 *
 * Read from package.json at runtime so the CLI banner (`nox-mem --version`) and
 * the MCP server handshake never drift from the actually-published version — the
 * cause of the old hardcoded "2.3.0" / "3.0.0" mismatches. Bumping package.json
 * is now the only place a version lives.
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

export const VERSION: string = (() => {
  try {
    // Compiled file lives at dist/version.js → package.json is one level up.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
