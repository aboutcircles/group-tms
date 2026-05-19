/**
 * File-backed scan-cursor persistence for workers that have no leader DB
 * (group-affiliates runs without LEADER_DB_URL). Without this, every
 * restart re-scans from the configured start block — a full multi-million
 * block eth_getLogs replay that hammers the indexer and RPC.
 *
 * Mirrors the StateStore contract. Reads are graceful: a missing or
 * corrupt file yields null so the caller falls back to the start block
 * (same behaviour as having no store) rather than crashing. Writes are
 * atomic (write a temp file then rename) so a crash mid-write can never
 * leave a torn JSON file that would force a full replay.
 */
import {promises as fs} from "fs";
import * as path from "path";

import {CursorStateStore, PersistedState} from "./stateStore";

type StateFile = Record<string, PersistedState>;

export class FileStateStore implements CursorStateStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async readAll(): Promise<StateFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      console.warn(`[file-state-store] Failed to read ${this.filePath}:`, (err as Error).message);
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as StateFile;
      }
      console.warn(`[file-state-store] Ignoring non-object state in ${this.filePath}`);
      return {};
    } catch (err) {
      // Corrupt file (e.g. torn write from an older non-atomic version,
      // or manual edit) — fall back to a full replay rather than crash.
      console.warn(`[file-state-store] Failed to parse ${this.filePath}:`, (err as Error).message);
      return {};
    }
  }

  async load(appName: string): Promise<PersistedState | null> {
    const all = await this.readAll();
    const entry = all[appName];
    if (!entry || typeof entry.lastScannedBlock !== "number" || !Number.isFinite(entry.lastScannedBlock)) {
      return null;
    }
    return {lastScannedBlock: entry.lastScannedBlock, data: entry.data};
  }

  async save(appName: string, lastScannedBlock: number, data?: Record<string, unknown>): Promise<void> {
    // Serialise writes so concurrent saves can't interleave
    // read-modify-write and lose an update.
    const next = this.writeChain.then(async () => {
      const all = await this.readAll();
      all[appName] = {lastScannedBlock, data};
      const tmpPath = `${this.filePath}.tmp`;
      try {
        await fs.mkdir(path.dirname(this.filePath), {recursive: true});
        await fs.writeFile(tmpPath, JSON.stringify(all), "utf8");
        await fs.rename(tmpPath, this.filePath);
      } catch (err) {
        console.warn(`[file-state-store] Failed to save ${this.filePath}:`, (err as Error).message);
        await fs.rm(tmpPath, {force: true}).catch(() => undefined);
      }
    });
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async close(): Promise<void> {
    // Flush any in-flight write before returning.
    await this.writeChain;
  }
}
