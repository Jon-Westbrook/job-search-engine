import { existsSync, readFileSync } from 'node:fs';
import { foldText } from './keys.ts';

// Company aliases from config/company_aliases.json (committed) and
// config/company_aliases.local.json (gitignored). Keys and values are normalized here.
export function loadAliases(committedPath: string, localPath: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const path of [committedPath, localPath]) {
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { aliases?: Record<string, string> };
    for (const [from, to] of Object.entries(raw.aliases ?? {})) {
      merged[foldText(from)] = foldText(to);
    }
  }
  return merged;
}
