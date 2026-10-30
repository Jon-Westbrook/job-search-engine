import type { Db } from './db/index.ts';
import type { Logger } from './log.ts';
import type { GogRunner } from './gog/wrapper.ts';
import { runIngestion, type RefreshPhase, type SyncResult, type SyncSource } from './ingest/sync.ts';
import type { SourceConfig } from './sources.ts';
import { groupNewPostings } from './grouping.ts';
import { scoreNeeded, type ScoringDeps } from './score/service.ts';

export interface RefreshDeps {
  db: Db;
  runner: GogRunner;
  logger: Logger;
  aliases: Record<string, string>;
  now?: () => Date;
  scoring?: ScoringDeps;
  rulesOnly?: boolean;
  scoreLimit?: number;
  // Re-reads the personal lists (targets and contacts) before each refresh.
  syncLists?: () => void;
}

export interface RefreshProgress {
  phase: RefreshPhase;
  done: number;
  total: number;
  messages: number;
}

export interface ScoringSummary {
  ai_available: boolean;
  scored: number;
  paused: boolean;
  errors: string[];
  remaining: number;
}

// Runs one refresh at a time. A refresh starts only when the owner presses Refresh. It
// never starts on launch or on a timer.
export class RefreshService {
  private running = false;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;
  private startedAt: string | null = null;
  private lastScoring: ScoringSummary | null = null;
  private progress: RefreshProgress | null = null;
  private completedAt: string | null = null;
  private cancelRequested = false;

  private readonly deps: RefreshDeps;
  private readonly sources: SourceConfig[];

  constructor(deps: RefreshDeps, sources: SourceConfig[]) {
    this.deps = deps;
    this.sources = sources;
    // A restart keeps the last completed refresh time, so the status still shows it.
    const saved = deps.db.prepare("SELECT value FROM app_meta WHERE key = 'last_refresh_completed_at'").get() as { value: string } | undefined;
    this.completedAt = saved?.value ?? null;
  }

  status(): { running: boolean; started_at: string | null; completed_at: string | null; last: SyncResult | null; last_error: string | null; scoring: ScoringSummary | null; progress: RefreshProgress | null } {
    return { running: this.running, started_at: this.startedAt, completed_at: this.completedAt, last: this.lastResult, last_error: this.lastError, scoring: this.lastScoring, progress: this.progress };
  }

  // Asks the running refresh to stop after the current thread. Completed work is kept.
  cancel(): boolean {
    if (!this.running) return false;
    this.cancelRequested = true;
    return true;
  }

  // Starts a refresh in the background and returns at once. Returns false if one is running.
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    this.cancelRequested = false;
    this.startedAt = (this.deps.now ? this.deps.now() : new Date()).toISOString();
    this.lastError = null;
    void this.execute();
    return true;
  }

  // Test helper and CLI helper: runs a refresh and waits for it.
  async runNow(): Promise<SyncResult[]> {
    if (this.running) throw new Error('A refresh is already running');
    this.running = true;
    this.startedAt = new Date().toISOString();
    return this.execute();
  }

  // Scores new and changed jobs. Uses AI when the Codex sign-in works and rules-only mode
  // is not forced. A provider failure pauses scoring and keeps the last good scores.
  private async scoreAfterIngest(): Promise<void> {
    const scoring = this.deps.scoring;
    if (!scoring) return;
    const aiAvailable = this.deps.rulesOnly ? false : (await scoring.codex.status()).available;
    const res = await scoreNeeded(scoring, aiAvailable, this.deps.scoreLimit, (done, total) => {
      this.progress = { phase: 'scoring', done, total, messages: 0 };
    });
    this.lastScoring = { ai_available: aiAvailable, scored: res.scored, paused: res.paused, errors: res.errors, remaining: res.remaining };
  }

  private async execute(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    try {
      this.deps.syncLists?.();
      for (const source of this.sources.filter((s) => s.enabled)) {
        const syncSource: SyncSource = {
          id: source.id,
          query: source.query,
          senders: source.senders,
          overlap_days: source.overlap_days,
          initial_lookback_days: source.initial_lookback_days,
          parser_version: source.parser_version,
        };
        const result = await runIngestion(
          {
            db: this.deps.db,
            runner: this.deps.runner,
            logger: this.deps.logger,
            now: this.deps.now,
            onProgress: (p) => (this.progress = { ...p, phase: p.total === 0 && p.done === 0 ? 'searching' : 'downloading' }),
            isCancelled: () => this.cancelRequested,
          },
          syncSource,
        );
        results.push(result);
        this.lastResult = result;
      }
      this.progress = { phase: 'processing', done: 0, total: 0, messages: 0 };
      groupNewPostings(this.deps.db, this.deps.aliases, new Date().toISOString());
      await this.scoreAfterIngest();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'refresh failed';
      this.deps.logger.error('refresh failed', { error: err });
    } finally {
      this.running = false;
      this.progress = null;
      if (!this.lastError) {
        // Keep the previous completion as the baseline for "new since refresh".
        const now = new Date().toISOString();
        const previous = this.deps.db.prepare("SELECT value FROM app_meta WHERE key = 'last_refresh_completed_at'").get() as { value: string } | undefined;
        const baseline = previous?.value ?? '1970-01-01T00:00:00.000Z';
        const upsert = this.deps.db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
        upsert.run('refresh_baseline_at', baseline, now);
        upsert.run('last_refresh_completed_at', now, now);
        this.completedAt = now;
      }
    }
    return results;
  }
}
