// Normalization for matching (brief section 7). Keys are for comparison only. The stored
// display values keep their original text.

const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'lp', 'llp']);
const TITLE_STOPWORDS = new Set(['of', 'the', 'and', 'a', 'an', 'for', 'in', 'at', 'to', 'with']);

// Lowercase, accents removed, ampersand spelled out, punctuation to spaces, spaces collapsed.
export function foldText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Legal suffixes are removed from the end. Known aliases map to one key. Seniority words
// stay in titles because they change the role.
export function normalizeCompany(name: string | null | undefined, aliases: Record<string, string> = {}): string | null {
  if (!name) return null;
  const tokens = foldText(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1] ?? '')) tokens.pop();
  const key = tokens.join(' ');
  if (!key) return null;
  return aliases[key] ?? key;
}

export function normalizeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const key = foldText(title);
  return key || null;
}

export function normalizeLocation(location: string | null | undefined): string | null {
  if (!location) return null;
  const key = foldText(location).replace(/\b(metropolitan area|city)\b/g, '').replace(/\s+/g, ' ').trim();
  return key || null;
}

export function titleTokens(titleKey: string): Set<string> {
  return new Set(titleKey.split(' ').filter((t) => t && !TITLE_STOPWORDS.has(t)));
}

// Jaccard similarity over meaningful title words. 1 means the same words in any order.
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const WEAK_TITLE_THRESHOLD = 0.5;
