import type { Weights } from './profile.ts';
import { POINT_SCALE, RULES_V1 } from './profile.ts';

// The deterministic scorer. Given the same inputs and weights, it returns the same score.
// Verdicts are not inputs. The AI supplies factor values with evidence, and this code
// turns them into points. The AI never assigns the final score.

export type Confidence = 'high' | 'medium' | 'low';
export type EvidenceField = 'title' | 'location' | 'description' | 'subject' | 'resume';

export interface Evidence {
  quote: string;
  field: EvidenceField;
}

// Validated AI output. Only the fields the scorer reads are typed here.
export interface Extraction {
  tn: { class: 'explicit' | 'design_centric' | 'partial' | 'none'; evidence: Evidence[] };
  role: {
    seniority_match: { value: number; evidence: Evidence[] };
    design_engineering_balance: { value: number; evidence: Evidence[] };
    stack_overlap: { value: number; evidence: Evidence[] };
  };
  role_family: string;
  missing: string[];
}

export interface ScoreInput {
  now: Date;
  weights: Weights;
  title: string;
  company: string | null;
  location: string | null;
  arrangement: 'onsite' | 'hybrid' | 'remote' | null;
  postedAt: string | null;
  // True when postedAt is the earliest alert date, not a posting time the listing stated.
  postedEstimated?: boolean;
  pay: { min: number; max: number; currency: string; annualized: boolean } | null;
  easyApply: boolean;
  directTier: 0 | 1 | 2 | 3;
  description: string | null;
  resumeText: string;
  extraSources: string[];
  extraction: Extraction | null;
  acceptedGeography: string[];
  tnHostileAgencies: string[];
  companyKey: string | null;
  alreadyApplied: boolean;
  possibleDuplicate: boolean;
}

export interface FactorLine {
  factor: string;
  aiValue: string | null;
  points: number;
  max: number;
  evidence: Evidence[];
  sourceField: string | null;
  confidence: Confidence | null;
}

export interface ScoreOutput {
  mode: 'ai' | 'rules_only';
  score: number;
  confidence: Confidence;
  factors: FactorLine[];
  penalties: FactorLine[];
  hardNegatives: Evidence[];
  ruleBlocked: boolean;
  missing: string[];
  flags: string[];
  unsupportedFactors: number;
  postingTimeKnown: boolean;
}

// Hard negatives (brief 8.5). Matched against title, subject, location, and description.
// "clearance required" counts only when no TN path is stated.
const HARD_NEGATIVE_PHRASES: RegExp[] = [/\bus citizens? only\b/i, /\bno sponsorship\b/i, /\bmust be authorized to work without sponsorship\b/i];
const CLEARANCE = /\bclearance required\b/i;
const TN_PATH = /\bTN\b|\bUSMCA\b|\bNAFTA\b|sponsorship (is )?(available|provided|offered)/i;
const JUNIOR = /\b(intern|internship|entry[- ]level|junior)\b/i;
const DAY = 86_400_000;

export function findHardNegatives(texts: Array<{ field: EvidenceField; text: string }>): Evidence[] {
  const found: Evidence[] = [];
  const hasTnPath = texts.some((t) => TN_PATH.test(t.text));
  for (const { field, text } of texts) {
    for (const re of HARD_NEGATIVE_PHRASES) {
      const m = re.exec(text);
      if (m) found.push({ quote: m[0], field });
    }
    if (!hasTnPath) {
      const c = CLEARANCE.exec(text);
      if (c) found.push({ quote: c[0], field });
    }
  }
  return found;
}

// Keeps evidence only when the quote appears in the source field text. Anything the AI
// cannot quote from the listing is dropped, so it cannot support a factor.
export function verifiedEvidence(evidence: Evidence[], sources: Record<EvidenceField, string>): Evidence[] {
  return evidence.filter((e) => {
    const text = sources[e.field] ?? '';
    return text.length > 0 && normalizeSpace(text).toLowerCase().includes(normalizeSpace(e.quote).toLowerCase());
  });
}

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// The owner's target roles, from the title alone. No AI, so it is explainable and fixed.
// Strong: forward deployed and design engineer. Near: frontend and full-stack. Adjacent: close titles.
export type TargetRoleTier = 'strong' | 'near' | 'adjacent';
const TARGET_ROLE_PATTERNS: Array<[TargetRoleTier, RegExp]> = [
  ['strong', /\bforward[\s-]+deploy/i],
  ['strong', /\bdesign[\s-]+engineer/i],
  ['near', /\bfront[\s-]?end\b/i],
  ['near', /\bfull[\s-]?stack\b/i],
  ['adjacent', /\bproduct engineer/i],
  ['adjacent', /\bui\s*\/?\s*ux engineer/i],
  ['adjacent', /\bcreative (technolog|engineer)/i],
  ['adjacent', /\binteraction engineer/i],
  ['adjacent', /\bweb developer\b/i],
];

export function targetRoleTier(title: string): TargetRoleTier | null {
  for (const [tier, pattern] of TARGET_ROLE_PATTERNS) if (pattern.test(title)) return tier;
  return null;
}

function scale(points: number, weight: number, defaultWeight: number): number {
  return Math.round((points * weight) / defaultWeight * 10) / 10;
}

export function scoreListing(input: ScoreInput): ScoreOutput {
  const w = input.weights;
  const factors: FactorLine[] = [];
  const penalties: FactorLine[] = [];
  const missing: string[] = [];
  const flags: string[] = [];
  let unsupported = 0;
  const mode: 'ai' | 'rules_only' = input.extraction ? 'ai' : 'rules_only';

  const sources: Record<EvidenceField, string> = {
    title: input.title,
    location: input.location ?? '',
    description: input.description ?? '',
    subject: '',
    resume: input.resumeText,
  };
  const hardNegatives = findHardNegatives([
    { field: 'title', text: input.title },
    { field: 'location', text: input.location ?? '' },
    { field: 'description', text: input.description ?? '' },
  ]);
  const ruleBlocked = hardNegatives.length > 0;

  // TN and visa fit (max = weight.tn). Needs AI extraction.
  if (input.extraction) {
    const tn = input.extraction.tn;
    const evidence = verifiedEvidence(tn.evidence, sources);
    let cls = tn.class;
    if (cls !== 'none' && evidence.length === 0) {
      // No quotable evidence means the class is not supported. Fall back to the lowest class.
      cls = 'none';
      unsupported++;
      flags.push('TN fit unsupported by quoted evidence');
    }
    const raw = RULES_V1.tn[cls];
    const label = cls === 'design_centric' ? 'inferred' : cls === 'explicit' ? 'explicit' : cls === 'partial' ? 'partial' : 'none';
    factors.push({
      factor: 'TN and visa fit',
      aiValue: label,
      points: scale(raw, w.tn, POINT_SCALE.tn),
      max: w.tn,
      evidence,
      sourceField: evidence[0]?.field ?? null,
      confidence: evidence.length ? 'high' : 'low',
    });
  } else {
    missing.push('TN fit (no AI extraction)');
  }

  // Role and resume fit (max = weight.role). Average of three sub-values, each needing evidence.
  if (input.extraction) {
    const r = input.extraction.role;
    const subs = [
      { key: 'seniority match', v: r.seniority_match },
      { key: 'design-engineering balance', v: r.design_engineering_balance },
      { key: 'stack overlap', v: r.stack_overlap },
    ];
    const values: number[] = [];
    const quoted: Evidence[] = [];
    for (const s of subs) {
      const evidence = verifiedEvidence(s.v.evidence, sources);
      if (evidence.length === 0) {
        values.push(RULES_V1.role.missing_subvalue);
        unsupported++;
        flags.push(`${s.key} has no quoted evidence (scored 0.5)`);
      } else {
        values.push(clamp01(s.v.value));
        quoted.push(...evidence);
      }
    }
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    factors.push({
      factor: 'Role and resume fit',
      aiValue: `seniority ${values[0]}, balance ${values[1]}, stack ${values[2]}`,
      points: Math.round(RULES_V1.role.points_at_full * avg * (w.role / POINT_SCALE.role) * 10) / 10,
      max: w.role,
      evidence: quoted,
      sourceField: quoted[0]?.field ?? null,
      confidence: quoted.length >= 3 ? 'high' : quoted.length > 0 ? 'medium' : 'low',
    });
  }

  // Direct line (max = weight.direct). Tier comes from the contacts table and the alert's
  // unnamed signals. Unnamed signals never create a contact.
  const tierPoints = [RULES_V1.direct_tiers.none, RULES_V1.direct_tiers.tier1, RULES_V1.direct_tiers.tier2, RULES_V1.direct_tiers.tier3][input.directTier] ?? 0;
  factors.push({
    factor: 'Direct line',
    aiValue: input.directTier === 0 ? 'none' : `tier ${input.directTier}`,
    points: scale(tierPoints, w.direct, POINT_SCALE.direct),
    max: w.direct,
    evidence: [],
    sourceField: 'contacts',
    confidence: input.directTier === 0 ? null : 'high',
  });

  // Target role (max = weight.target_role). From the title only, so it does not depend on the AI.
  const tier = targetRoleTier(input.title);
  factors.push({
    factor: 'Target role',
    aiValue: tier ? `${tier} match` : 'no match',
    points: tier ? scale(RULES_V1.target_role[tier], w.target_role, POINT_SCALE.target_role) : 0,
    max: w.target_role,
    evidence: tier ? [{ quote: input.title, field: 'title' }] : [],
    sourceField: 'title',
    confidence: 'high',
  });

  // Recency (max = weight.recency). Computed, not AI. Unknown time gives 5 and Low confidence.
  const postingTimeKnown = Boolean(input.postedAt);
  if (input.postedAt) {
    const posted = Date.parse(input.postedAt);
    const ageDays = Math.max(0, (input.now.getTime() - posted) / DAY);
    const { full_days, zero_days } = RULES_V1.recency;
    const pts = ageDays <= full_days ? 10 : ageDays >= zero_days ? 0 : (10 * (zero_days - ageDays)) / (zero_days - full_days);
    factors.push({
      factor: 'Recency',
      aiValue: `${Math.round(ageDays * 10) / 10} days old${input.postedEstimated ? ' (estimated from alert date)' : ''}`,
      points: scale(Math.round(pts), w.recency, POINT_SCALE.recency),
      max: w.recency,
      evidence: [],
      sourceField: 'posted_at',
      confidence: input.postedEstimated ? 'medium' : 'high',
    });
    if (input.postedEstimated) flags.push('Posting time estimated from the alert date');
  } else {
    missing.push('posting time');
    factors.push({ factor: 'Recency', aiValue: 'unknown', points: scale(5, w.recency, POINT_SCALE.recency), max: w.recency, evidence: [], sourceField: null, confidence: 'low' });
  }

  // Compensation (max = weight.compensation). Annual base only. Hourly rates are not
  // annualized without stated hours, so they count as not listed.
  const c = RULES_V1.compensation;
  if (input.pay && input.pay.currency === 'USD' && input.pay.annualized) {
    const top = input.pay.max;
    let raw: number;
    if (top >= c.high_threshold) raw = c.at_or_above_160k;
    else if (top >= c.mid_threshold) raw = c.from_150k;
    else {
      raw = c.below_150k;
      penalties.push({ factor: 'Below target pay', aiValue: null, points: 0, max: 0, evidence: [], sourceField: 'pay', confidence: 'high' });
      flags.push('Below target pay');
    }
    factors.push({
      factor: 'Compensation',
      aiValue: `posted maximum ${top.toLocaleString('en-US')}`,
      points: scale(raw, w.compensation, POINT_SCALE.compensation),
      max: w.compensation,
      evidence: [],
      sourceField: 'pay',
      confidence: 'high',
    });
  } else {
    missing.push('pay');
    factors.push({
      factor: 'Compensation',
      aiValue: input.pay ? 'not annualized' : 'not listed',
      points: scale(c.not_listed, w.compensation, POINT_SCALE.compensation),
      max: w.compensation,
      evidence: [],
      sourceField: null,
      confidence: 'low',
    });
  }

  // Effort (max = weight.effort). Easy Apply is 5. Anything else is unknown (3) until a
  // route is known.
  factors.push({
    factor: 'Effort',
    aiValue: input.easyApply ? 'Easy Apply' : 'unknown route',
    points: scale(input.easyApply ? RULES_V1.effort.easy_apply : RULES_V1.effort.unknown, w.effort, POINT_SCALE.effort),
    max: w.effort,
    evidence: [],
    sourceField: 'alert',
    confidence: input.easyApply ? 'high' : 'low',
  });

  // Penalties and red flags (8.4). Shown separately from factor points.
  if (JUNIOR.test(input.title)) {
    penalties.push({ factor: 'Junior or internship role', aiValue: null, points: RULES_V1.penalties.junior_role, max: 0, evidence: [{ quote: input.title, field: 'title' }], sourceField: 'title', confidence: 'high' });
  }
  if (input.arrangement && input.arrangement !== 'remote' && input.location && input.acceptedGeography.length > 0) {
    const loc = input.location.toLowerCase();
    const inside = input.acceptedGeography.some((g) => loc.includes(g.toLowerCase()));
    if (!inside) {
      penalties.push({ factor: 'On-site outside accepted geography', aiValue: input.location, points: RULES_V1.penalties.onsite_outside_geography, max: 0, evidence: [], sourceField: 'location', confidence: 'high' });
      flags.push('Review: on-site outside accepted geography');
    }
  }
  if (input.arrangement === 'remote' && !/\b(united states|usa|us|canada|uk|mexico|india|new york|nj|ny|ca|tx|ma|wa)\b/i.test(input.location ?? '')) {
    flags.push('Review: remote eligibility unclear');
  }
  if (input.companyKey && input.tnHostileAgencies.includes(input.companyKey)) {
    penalties.push({ factor: 'Known TN-hostile staffing agency', aiValue: null, points: RULES_V1.penalties.tn_hostile_agency, max: 0, evidence: [], sourceField: 'company', confidence: 'high' });
  }
  if (!input.company) flags.push('Review: company missing');
  if (input.postedAt && (input.now.getTime() - Date.parse(input.postedAt)) / DAY > 60) flags.push('Review: listing may be expired');
  if (input.alreadyApplied) flags.push('Already applied');
  if (input.possibleDuplicate) flags.push('Possible duplicate');

  // Score = factor points + penalties, clamped to 0..100. A hard negative caps it at 5.
  const factorSum = factors.reduce((s, f) => s + f.points, 0);
  const penaltySum = penalties.reduce((s, p) => s + p.points, 0);
  let score = Math.round(Math.min(100, Math.max(0, factorSum + penaltySum)));
  if (ruleBlocked) score = Math.min(score, RULES_V1.hard_negative_cap);

  // Confidence (brief section 9).
  let confidence: Confidence;
  if (!postingTimeKnown || unsupported >= 2) {
    confidence = 'low';
  } else if (
    input.description &&
    factors.some((f) => f.factor === 'TN and visa fit' && f.evidence.length > 0) &&
    factors.some((f) => f.factor === 'Role and resume fit' && f.evidence.length > 0) &&
    unsupported === 0
  ) {
    confidence = 'high';
  } else if (input.extraSources.length > 0 || input.description || unsupported === 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  if (mode === 'rules_only') confidence = 'low';

  const missingAll = [...missing];
  if (!input.description) missingAll.push('full description');
  if (!input.extraction) missingAll.push('AI factor values');
  for (const m of input.extraction?.missing ?? []) if (!missingAll.includes(m)) missingAll.push(m.slice(0, 80));

  return {
    mode,
    score,
    confidence,
    factors,
    penalties,
    hardNegatives,
    ruleBlocked,
    missing: missingAll,
    flags,
    unsupportedFactors: unsupported,
    postingTimeKnown,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
