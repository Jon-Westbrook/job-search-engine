import type { Db } from '../db/index.ts';

// Weight profile v1 (brief section 8.1 and 8.2). Each weight is the factor's maximum.
// Changing a weight creates a new version. Old scores keep the version they used.
export interface Weights {
  tn: number;
  role: number;
  direct: number;
  recency: number;
  compensation: number;
  effort: number;
}

export const WEIGHT_KEYS: Array<keyof Weights> = ['tn', 'role', 'direct', 'recency', 'compensation', 'effort'];
export const DEFAULT_WEIGHTS: Weights = { tn: 30, role: 30, direct: 15, recency: 10, compensation: 10, effort: 5 };

// The point rules and thresholds used with the weights. Stored with each version so an
// old score can be explained later.
export const RULES_V1 = {
  tn: { explicit: 30, design_centric: 27, partial: 18, none: 8 },
  role: { points_at_full: 30, missing_subvalue: 0.5 },
  recency: { full_days: 1, zero_days: 14 },
  compensation: { at_or_above_160k: 10, from_150k: 6, below_150k: 2, not_listed: 5, high_threshold: 160000, mid_threshold: 150000 },
  effort: { easy_apply: 5, unknown: 3 },
  direct_tiers: { tier1: 15, tier2: 10, tier3: 5, none: 0 },
  penalties: { junior_role: -10, onsite_outside_geography: -15, tn_hostile_agency: -10 },
  hard_negative_cap: 5,
  bands: { good_fit: 75, review: 50 },
} as const;

export interface WeightProfile {
  id: number;
  version: number;
  weights: Weights;
  rules: unknown;
  author: string;
  reason: string | null;
  created_at: string;
  active: boolean;
}

export function seedWeightProfile(db: Db, nowIso: string): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM weight_profiles').get() as { n: number }).n;
  if (count > 0) return;
  db.prepare(
    `INSERT INTO weight_profiles (version, weights, rules, author, reason, created_at, active) VALUES (1, ?, ?, 'build', 'starting values from brief section 8', ?, 1)`,
  ).run(JSON.stringify(DEFAULT_WEIGHTS), JSON.stringify(RULES_V1), nowIso);
}

export function activeWeightProfile(db: Db): WeightProfile {
  const row = db.prepare('SELECT * FROM weight_profiles WHERE active = 1 ORDER BY version DESC LIMIT 1').get() as
    | { id: number; version: number; weights: string; rules: string; author: string; reason: string | null; created_at: string }
    | undefined;
  if (!row) throw new Error('No active weight profile. Run the seed first.');
  return {
    id: row.id,
    version: row.version,
    weights: JSON.parse(row.weights) as Weights,
    rules: JSON.parse(row.rules) as unknown,
    author: row.author,
    reason: row.reason,
    created_at: row.created_at,
    active: true,
  };
}

export class WeightError extends Error {}

export function validateWeights(value: unknown): Weights {
  if (!value || typeof value !== 'object') throw new WeightError('Weights must be an object');
  const obj = value as Record<string, unknown>;
  const out = {} as Weights;
  for (const key of WEIGHT_KEYS) {
    const n = obj[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) throw new WeightError(`${key} must be a number from 0 to 100`);
    out[key] = n;
  }
  const total = WEIGHT_KEYS.reduce((sum, k) => sum + out[k], 0);
  if (Math.abs(total - 100) > 0.001) throw new WeightError(`Weights must add to 100 (they add to ${total})`);
  return out;
}

// Creates a new active version. The previous version is kept.
export function saveWeightVersion(db: Db, weights: Weights, reason: string, author: string, nowIso: string): WeightProfile {
  const current = activeWeightProfile(db);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE weight_profiles SET active = 0 WHERE active = 1').run();
    db.prepare(
      `INSERT INTO weight_profiles (version, weights, rules, author, reason, created_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(current.version + 1, JSON.stringify(weights), JSON.stringify(current.rules), author, reason, nowIso);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return activeWeightProfile(db);
}
