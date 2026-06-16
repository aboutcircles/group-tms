/**
 * Persist router-tms enablement + quarantine state to PostgreSQL so a worker
 * restart resumes its de-duplication state instead of re-emitting every
 * `enableCRCForRouting` tx for avatars that were already processed but are
 * not (yet) in the router's on-chain trust set.
 *
 * Graceful fallback: pg errors are logged and the method resolves quietly
 * so a transient PG hiccup never crashes the run loop.
 *
 * Shares GROUP_TMS_DDL_LOCK_KEY with StateStore so all group-tms DDL
 * serializes against the system-catalog race (pg_type_typname_nsp_index)
 * when multiple workers boot concurrently.
 */
import {getAddress} from "ethers";
import pg from "pg";

import {GROUP_TMS_DDL_LOCK_KEY} from "../../services/stateStore";
import {
  IRouterEnablementStore,
  RouterEnablementSource,
  RouterEnablementStatus
} from "../../interfaces/IRouterEnablementStore";

const DDL = `
CREATE TABLE IF NOT EXISTS router_tms_enablement (
  avatar              TEXT PRIMARY KEY,
  fallback_enabled    BOOLEAN     NOT NULL DEFAULT FALSE,
  base_group_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  quarantined_until   TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function tryNormalize(address: string): string | null {
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function normalizeBatch(addresses: string[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    const n = tryNormalize(a);
    if (n !== null) out.push(n);
  }
  return out;
}

export class PgRouterEnablementStore implements IRouterEnablementStore {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(dbUrl: string, private quarantineTtlMs: number) {
    this.pool = new pg.Pool({connectionString: dbUrl, max: 2});
    this.ready = this.ensureTable();
  }

  private async ensureTable(): Promise<void> {
    // Fast path: once the table exists (every boot after the first), skip the
    // advisory lock + DDL. On a near-idle shared state DB the boot-time
    // pg_advisory_xact_lock wait gets counted as multi-second query time by
    // pgbouncer; probing existence first avoids the lock in the common case.
    // The locked DDL path still runs on a fresh DB to serialize the concurrent
    // CREATE TABLE (the pg_type race the lock guards against).
    try {
      const probe = await this.pool.query("SELECT to_regclass('router_tms_enablement') AS reg");
      if (probe.rows[0]?.reg != null) return;
    } catch {
      // fall through to the locked create path on any probe error
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

  async loadEnablementStatuses(): Promise<RouterEnablementStatus[]> {
    try {
      await this.ready;
      const result = await this.pool.query(
        `SELECT avatar, fallback_enabled, base_group_enabled
           FROM router_tms_enablement
          WHERE fallback_enabled OR base_group_enabled`
      );
      return result.rows.map((row) => ({
        avatar: row.avatar,
        fallbackEnabled: row.fallback_enabled,
        baseGroupEnabled: row.base_group_enabled
      }));
    } catch (err) {
      console.warn(
        `[router-enablement-store] Failed to load enablement statuses:`,
        (err as Error).message
      );
      return [];
    }
  }

  async markEnabled(addresses: string[], source: RouterEnablementSource): Promise<void> {
    const normalized = normalizeBatch(addresses);
    if (normalized.length === 0) return;
    // Column name is internal-only (one of two literals) — safe to interpolate.
    const col = source === "fallback" ? "fallback_enabled" : "base_group_enabled";
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO router_tms_enablement (avatar, ${col}, updated_at)
           SELECT unnest($1::text[]), TRUE, now()
         ON CONFLICT (avatar) DO UPDATE
           SET ${col} = router_tms_enablement.${col} OR EXCLUDED.${col},
               updated_at = now()`,
        [normalized]
      );
    } catch (err) {
      console.warn(
        `[router-enablement-store] Failed to mark ${normalized.length} address(es) enabled (${source}):`,
        (err as Error).message
      );
    }
  }

  async loadQuarantinedAddresses(): Promise<string[]> {
    try {
      await this.ready;
      const result = await this.pool.query(
        `SELECT avatar
           FROM router_tms_enablement
          WHERE quarantined_until IS NOT NULL
            AND quarantined_until > now()`
      );
      return result.rows.map((row) => row.avatar);
    } catch (err) {
      console.warn(
        `[router-enablement-store] Failed to load quarantined addresses:`,
        (err as Error).message
      );
      return [];
    }
  }

  async markQuarantined(addresses: string[]): Promise<void> {
    const normalized = normalizeBatch(addresses);
    if (normalized.length === 0) return;
    const until = new Date(Date.now() + this.quarantineTtlMs).toISOString();
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO router_tms_enablement (avatar, quarantined_until, updated_at)
           SELECT unnest($1::text[]), $2::timestamptz, now()
         ON CONFLICT (avatar) DO UPDATE
           SET quarantined_until = EXCLUDED.quarantined_until,
               updated_at = now()`,
        [normalized, until]
      );
    } catch (err) {
      console.warn(
        `[router-enablement-store] Failed to mark ${normalized.length} address(es) quarantined:`,
        (err as Error).message
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
