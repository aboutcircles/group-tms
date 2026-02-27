import { Pool } from "pg";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALENESS_THRESHOLD_SEC = 45;

interface LeaderElectionNotifier {
  notifySlackStartOrCrash(message: string): Promise<void>;
}

export class LeaderElection {
  private pool: Pool;
  private instanceId: string;
  private notifier: LeaderElectionNotifier | undefined;
  private onStatusUpdate: ((isLeader: boolean) => void) | undefined;
  private _isLeader = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    dbUrl: string,
    instanceId: string,
    notifier?: LeaderElectionNotifier,
    onStatusUpdate?: (isLeader: boolean) => void
  ) {
    this.pool = new Pool({ connectionString: dbUrl, max: 2 });
    this.instanceId = instanceId;
    this.notifier = notifier;
    this.onStatusUpdate = onStatusUpdate;
  }

  /**
   * Create a LeaderElection instance if both dbUrl and instanceId are provided.
   * Returns null when leader election is not configured (backward compatible).
   */
  static async create(
    dbUrl?: string,
    instanceId?: string,
    notifier?: LeaderElectionNotifier,
    onStatusUpdate?: (isLeader: boolean) => void
  ): Promise<LeaderElection | null> {
    if (!dbUrl || !instanceId) return null;
    const le = new LeaderElection(dbUrl, instanceId, notifier, onStatusUpdate);
    await le.start();
    return le;
  }

  async start(): Promise<void> {
    await this.ensureTable();
    await this.tryAcquire();
    this.heartbeatTimer = setInterval(() => this.tryAcquire(), HEARTBEAT_INTERVAL_MS);
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  private async ensureTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS group_tms_leader (
        id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        instance_id TEXT    NOT NULL,
        last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  private async tryAcquire(): Promise<void> {
    const wasLeader = this._isLeader;
    try {
      const result = await this.pool.query(
        `INSERT INTO group_tms_leader (id, instance_id, last_heartbeat)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE
           SET instance_id = $1, last_heartbeat = now()
           WHERE group_tms_leader.instance_id = $1
              OR group_tms_leader.last_heartbeat < now() - ($2 * INTERVAL '1 second')
         RETURNING instance_id`,
        [this.instanceId, STALENESS_THRESHOLD_SEC]
      );
      this._isLeader = result.rowCount !== null && result.rowCount > 0;
    } catch (err) {
      // PG unreachable → safe: go dry-run
      console.error(`[leader-election] PG error, falling back to standby:`, err instanceof Error ? err.message : err);
      this._isLeader = false;
    }

    if (!wasLeader && this._isLeader) {
      console.log(`[leader-election] Acquired leadership (instance=${this.instanceId})`);
      this.notifySlack(`🟢 Acquired leadership`);
    } else if (wasLeader && !this._isLeader) {
      console.log(`[leader-election] Lost leadership (instance=${this.instanceId})`);
      this.notifySlack(`🔴 Lost leadership — switching to dry-run`);
    }

    this.onStatusUpdate?.(this._isLeader);
  }

  private notifySlack(message: string): void {
    if (!this.notifier) return;
    this.notifier.notifySlackStartOrCrash(message).catch((err) => {
      console.warn(`[leader-election] Slack notification failed:`, err instanceof Error ? err.message : err);
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.pool.end();
  }
}

/**
 * Compute effective dry-run: if leader election is active, only the leader
 * runs wet. If leader election is not configured, fall through to env DRY_RUN.
 */
export function getEffectiveDryRun(le: LeaderElection | null, dryRun: boolean): boolean {
  if (!le) return dryRun;
  return dryRun || !le.isLeader;
}
