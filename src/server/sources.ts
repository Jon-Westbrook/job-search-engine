import { readFileSync } from 'node:fs';

export interface SourceConfig {
  id: string;
  type: 'gmail';
  enabled: boolean;
  senders: string[];
  query: string;
  overlap_days: number;
  initial_lookback_days: number;
  parser_version: string;
}

// Reads config/sources.json and checks each entry. A bad entry stops startup rather than
// silently ingesting the wrong mail.
export function loadSources(path: string): SourceConfig[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { sources?: unknown };
  if (!Array.isArray(raw.sources)) throw new Error('config/sources.json must contain a sources array');
  return raw.sources.map((s, i) => validateSource(s, i));
}

function validateSource(value: unknown, index: number): SourceConfig {
  const s = value as Record<string, unknown>;
  const where = `sources[${index}]`;
  if (typeof s.id !== 'string' || !s.id) throw new Error(`${where}.id is required`);
  if (s.type !== 'gmail') throw new Error(`${where}.type must be "gmail" in Phase 1A`);
  if (!Array.isArray(s.senders) || s.senders.length === 0 || !s.senders.every((x) => typeof x === 'string' && x.includes('@'))) {
    throw new Error(`${where}.senders must list at least one sender address`);
  }
  if (typeof s.query !== 'string' || !s.query) throw new Error(`${where}.query is required`);
  if (/linkedin\.com\/?(\s|$|\))/i.test(s.query) && !/jobalerts-noreply|jobs-noreply/i.test(s.query)) {
    throw new Error(`${where}.query targets linkedin.com directly, which is not allowed`);
  }
  const overlap = Number(s.overlap_days);
  const lookback = Number(s.initial_lookback_days);
  if (!Number.isInteger(overlap) || overlap < 0) throw new Error(`${where}.overlap_days must be a whole number`);
  if (!Number.isInteger(lookback) || lookback < 1) throw new Error(`${where}.initial_lookback_days must be a whole number`);
  if (typeof s.parser_version !== 'string') throw new Error(`${where}.parser_version is required`);
  return {
    id: s.id,
    type: 'gmail',
    enabled: s.enabled !== false,
    senders: s.senders as string[],
    query: s.query,
    overlap_days: overlap,
    initial_lookback_days: lookback,
    parser_version: s.parser_version,
  };
}
