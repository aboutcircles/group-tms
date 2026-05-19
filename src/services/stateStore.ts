/**
 * Persist block scan cursors to PostgreSQL so event-driven apps
 * resume from last successful scan instead of re-scanning from genesis.
 *
 * Graceful fallback: if PG is unavailable, logs a warning and returns null / is a no-op.
 * Uses the same LEADER_DB_URL connection already available on both hosts.
 */
import pg from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS group_tms_state (
  app_name         TEXT PRIMARY KEY,
  last_scanned_block BIGINT NOT NULL,
  state_data       JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export interface PersistedState {
  lastScannedBlock: number;
  data?: Record<string, unknown>;
}

export class StateStore {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(dbUrl: string) {
    this.pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
    this.ready = this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(DDL);
    } finally {
      client.release();
    }
  }

  async load(appName: string): Promise<PersistedState | null> {
    try {
      await this.ready;
      const result = await this.pool.query(
        `SELECT last_scanned_block, state_data FROM group_tms_state WHERE app_name = $1`,
        [appName],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      return {
        lastScannedBlock: Number(row.last_scanned_block),
        data: row.state_data ?? undefined,
      };
    } catch (err) {
      // Graceful fallback — don't crash, just return null
      console.warn(`[state-store] Failed to load state for ${appName}:`, (err as Error).message);
      return null;
    }
  }

  async save(appName: string, lastScannedBlock: number, data?: Record<string, unknown>): Promise<void> {
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO group_tms_state (app_name, last_scanned_block, state_data, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (app_name) DO UPDATE
           SET last_scanned_block = EXCLUDED.last_scanned_block,
               state_data = EXCLUDED.state_data,
               updated_at = now()`,
        [appName, lastScannedBlock, data ? JSON.stringify(data) : null],
      );
    } catch (err) {
      // Graceful fallback — log and continue
      console.warn(`[state-store] Failed to save state for ${appName}:`, (err as Error).message);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
