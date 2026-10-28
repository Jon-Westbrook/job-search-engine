import type { Db } from './db/index.ts';
import type { Logger } from './log.ts';
import type { GogRunner } from './gog/wrapper.ts';
import { runIngestion, type SyncResult, type SyncSource } from './ingest/sync.ts';
import type { SourceConfig } from './sources.ts';

// Runs one refresh at a time. A refresh starts only when the owner presses Refresh. It
// never starts on launch or on a timer.
export class RefreshService {
  private running = false;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;
  private startedAt: string | null = null;

  private readonly deps: { db: Db; runner: GogRunner; logger: Logger; now?: () => Date };
  private readonly sources: SourceConfig[];

  constructor(deps: { db: Db; runner: GogRunner; logger: Logger; now?: () => Date }, sources: SourceConfig[]) {
    this.deps = deps;
    this.sources = sources;
  }

  status(): { running: boolean; started_at: string | null; last: SyncResult | null; last_error: string | null } {
    return { running: this.running, started_at: this.startedAt, last: this.lastResult, last_error: this.lastError };
  }

  // Starts a refresh in the background and returns at once. Returns false if one is running.
  start(): boolean {
    if (this.running) return false;
    this.running = true;
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

  private async execute(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    try {
      for (const source of this.sources.filter((s) => s.enabled)) {
        const syncSource: SyncSource = {
          id: source.id,
          query: source.query,
          senders: source.senders,
          overlap_days: source.overlap_days,
          initial_lookback_days: source.initial_lookback_days,
          parser_version: source.parser_version,
        };
        const result = await runIngestion({ db: this.deps.db, runner: this.deps.runner, logger: this.deps.logger, now: this.deps.now }, syncSource);
        results.push(result);
        this.lastResult = result;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'refresh failed';
      this.deps.logger.error('refresh failed', { error: err });
    } finally {
      this.running = false;
    }
    return results;
  }
}
