/**
 * Persist block scan cursors to PostgreSQL so event-driven apps
 * resume from last successful scan instead of re-scanning from genesis.
 *
 * Graceful fallback: if PG is unavailable, logs a warning and returns null / is a no-op.
 * Uses the LEADER_DB_URL env var — historical name from when this connection
 * also served leader election; now it's just the shared state-DB URL.
 */
import pg from "pg";

// Shared advisory-lock key for group-tms DDL. Serializes concurrent
// CREATE TABLE IF NOT EXISTS across StateStore + PgRouterEnablementStore
// so multiple workers booting against the same Postgres can't race on
// pg_type_typname_nsp_index during the implicit CREATE TYPE under each
// CREATE TABLE. xact-scoped so the lock auto-releases on COMMIT —
// required for pgbouncer transaction-pool mode (session-scoped locks
// would orphan).
export const GROUP_TMS_DDL_LOCK_KEY = 7281992451;

const DDL = `
CREATE TABLE IF NOT EXISTS public.group_tms_state (
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
    // Fast path: once the table exists (every boot after the first), skip the
    // advisory lock + DDL. On a near-idle shared state DB the boot-time
    // pg_advisory_xact_lock wait gets counted as multi-second query time by
    // pgbouncer; probing existence first avoids the lock in the common case.
    // The locked DDL path still runs on a fresh DB to serialize the concurrent
    // CREATE TABLE (the pg_type race the lock guards against).
    // Schema-qualify the probe (and DDL) so existence detection is independent
    // of the connection's search_path — the probe must look in exactly the
    // schema the DDL targets, otherwise a non-default search_path could mask a
    // present table and re-take the lock every boot.
    try {
      const probe = await this.pool.query("SELECT to_regclass('public.group_tms_state') AS reg");
      if (probe.rows[0]?.reg != null) return;
    } catch (err) {
      // Probe failed (connectivity/permission/unexpected) — log a breadcrumb and
      // fall through to the locked create path, which re-surfaces any real error.
      console.warn("[state-store] table-existence probe failed; using locked create path:", (err as Error).message);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [GROUP_TMS_DDL_LOCK_KEY]);
      await client.query(DDL);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
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
