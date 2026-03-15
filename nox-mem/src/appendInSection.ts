import { existsSync, readFileSync, writeFileSync } from "fs";

/**
 * Cria o arquivo com cabeçalho se não existir.
 */
export function ensureFile(path: string, header: string): void {
  if (!existsSync(path)) writeFileSync(path, header + "\n\n", "utf-8");
}

/**
 * Insere conteúdo dentro da seção correta de um arquivo Markdown.
 * Localiza o cabeçalho da seção e insere ANTES do próximo ## (ou no fim do arquivo).
 */
export function appendInSection(path: string, section: string, content: string): void {
  let existing = readFileSync(path, "utf-8");

  if (!existing.includes(section)) {
    // Seção não existe — adiciona no final
    existing = existing.trimEnd() + "\n\n" + section + "\n\n" + content + "\n";
    writeFileSync(path, existing, "utf-8");
    return;
  }

  // Localiza a seção e insere antes do próximo ## cabeçalho
  const sectionIdx = existing.indexOf(section);
  const afterSection = sectionIdx + section.length;

  const nextHeaderMatch = existing.substring(afterSection).match(/\n## /);
  const insertPos = nextHeaderMatch
    ? afterSection + nextHeaderMatch.index!
    : existing.length;

  const before = existing.substring(0, insertPos).trimEnd();
  const after = existing.substring(insertPos);
  writeFileSync(path, before + "\n" + content + "\n" + after, "utf-8");
}
