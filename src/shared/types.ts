// API types shared by the server and the web app. Keep these in step with the routes.

export type Band = 'good' | 'review' | 'low' | 'blocked' | 'unscored';
export type Filter = 'all' | 'good' | 'review' | 'blocked' | 'applied';
export type Verdict = 'good' | 'maybe' | 'bad';
export type Confidence = 'high' | 'medium' | 'low';
export type DirectFilter = 'any' | 'tier1' | 'tier2plus';
export type SortKey = 'score' | 'age' | 'pay' | 'confidence';

export interface PayInfo {
  text: string;
  min: number;
  max: number;
  period: string | null;
  annualized: boolean;
}

export interface JobListItem {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  arrangement: string | null;
  posted_at: string | null;
  pay: PayInfo | null;
  score: number | null;
  confidence: Confidence | null;
  mode: 'ai' | 'rules_only' | null;
  weight_version: number | null;
  verdict: Verdict | null;
  tn_label: string | null;
  direct_tier: 0 | 1 | 2 | 3;
  direct_label: string;
  flags: string[];
  missing: string[];
  blocked: { at: string; reason: string } | null;
  rule_blocked: boolean;
  applied: { date: string | null; reason: string; status: string } | null;
  possible_duplicate: boolean;
  source_count: number;
  first_seen: string;
  last_seen: string;
  band: Band;
}

export interface JobsResponse {
  items: JobListItem[];
  counts: Record<Filter, number>;
}

export interface FactorRow {
  factor: string;
  ai_value: string | null;
  points: number;
  max: number;
  evidence_excerpt: string | null;
  source_field: string | null;
  confidence: Confidence | null;
}

export interface SourceRow {
  id: number;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  alert_received_at: string;
  message_id: string;
  thread_id: string;
  match_type: string;
  match_reason: string | null;
  observations: number;
}

export interface WeakMatchRow {
  jobId: number;
  title: string;
  company: string | null;
  url: string;
  similarity: number;
}

export interface JobDetail extends JobListItem {
  canonical_url: string;
  scored_at: string | null;
  score_version: number | null;
  factors: FactorRow[];
  penalties: FactorRow[];
  hard_negatives: Array<{ quote: string; field: string }>;
  rule_block_evidence: Array<{ quote: string; field: string }>;
  sources: SourceRow[];
  weak_matches: WeakMatchRow[];
  has_description: boolean;
  events: Array<{ type: string; created_at: string; payload: unknown }>;
  reason_tags: string[];
}

export interface RefreshStatus {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  progress: { done: number; total: number; messages: number } | null;
  last: { status: string; counts: Record<string, number>; errors?: Array<{ error: string; message_id?: string; thread_id?: string }> } | null;
  last_error: string | null;
  scoring: { ai_available: boolean; scored: number; paused: boolean; errors: string[] } | null;
}

export interface WeightProfileView {
  version: number;
  weights: Record<'tn' | 'role' | 'direct' | 'recency' | 'compensation' | 'effort', number>;
  reason: string | null;
  author: string;
  created_at: string;
}

export const APP_CONSTANTS = {
  goodFit: 75,
  review: 50,
  undoMs: 5000,
} as const;

export const REASON_TAGS = ['Role fit', 'Seniority', 'Pay', 'Location', 'Visa', 'Stack', 'Company', 'Other'] as const;
