import {getAddress} from "ethers";

import {StateStore} from "../../services/stateStore";

/**
 * Persistent forward index: human → current affiliate group.
 *
 * Built by replaying AffiliateGroupChanged events from the registry. Used by
 * runReputationReconciliation to discover humans whose current affiliate is
 * a managed group but who aren't yet trusted (e.g. because their reputation
 * was below threshold at event-time and has since recovered, or because they
 * joined while we were down).
 *
 * Not a security boundary: a stale/incomplete map can only fail to add trusts.
 * Untrust decisions remain rooted in on-chain trustee reads (see logic.ts).
 */

export type AffiliateMapSnapshot = {
  /** Highest block whose AffiliateGroupChanged events have been reduced into the map. */
  lastScannedBlock: number;
  /** Lowercased human → lowercased current affiliate group. */
  entries: Record<string, string>;
};

export class AffiliateMap {
  private readonly humanToGroup = new Map<string, string>();
  private readonly groupToHumans = new Map<string, Set<string>>();
  private _lastScannedBlock: number;
  private _dirty = false;

  constructor(lastScannedBlock: number = 0) {
    this._lastScannedBlock = lastScannedBlock;
  }

  static fromSnapshot(snapshot: AffiliateMapSnapshot): AffiliateMap {
    const map = new AffiliateMap(snapshot.lastScannedBlock);
    for (const [human, group] of Object.entries(snapshot.entries ?? {})) {
      const normalizedHuman = normalize(human);
      const normalizedGroup = normalize(group);
      if (!normalizedHuman || !normalizedGroup) continue;
      map.humanToGroup.set(normalizedHuman, normalizedGroup);
      addToReverse(map.groupToHumans, normalizedGroup, normalizedHuman);
    }
    map._dirty = false;
    return map;
  }

  /**
   * Apply an AffiliateGroupChanged event. Records the most recent (highest cursor)
   * group per human. Caller is responsible for invoking this in cursor order;
   * runForAffiliateEvents already sorts by cursor before applying.
   */
  set(human: string, newGroup: string, observedAtBlock?: number): void {
    const normalizedHuman = normalize(human);
    const normalizedGroup = normalize(newGroup);
    if (!normalizedHuman || !normalizedGroup) return;

    const previousGroup = this.humanToGroup.get(normalizedHuman);
    if (previousGroup === normalizedGroup) {
      // Idempotent — but still advance lastScannedBlock if needed.
      this.maybeAdvanceCursor(observedAtBlock);
      return;
    }

    if (previousGroup) {
      removeFromReverse(this.groupToHumans, previousGroup, normalizedHuman);
    }
    this.humanToGroup.set(normalizedHuman, normalizedGroup);
    addToReverse(this.groupToHumans, normalizedGroup, normalizedHuman);
    this._dirty = true;
    this.maybeAdvanceCursor(observedAtBlock);
  }

  getGroup(human: string): string | undefined {
    const normalized = normalize(human);
    return normalized ? this.humanToGroup.get(normalized) : undefined;
  }

  getAffiliatesOf(group: string): string[] {
    const normalized = normalize(group);
    if (!normalized) return [];
    const set = this.groupToHumans.get(normalized);
    return set ? Array.from(set).sort() : [];
  }

  size(): number {
    return this.humanToGroup.size;
  }

  get lastScannedBlock(): number {
    return this._lastScannedBlock;
  }

  /**
   * Bump the scan cursor without changing entries — used after backfilling
   * a block range that contained no events for managed humans.
   */
  advanceCursor(blockNumber: number): void {
    if (blockNumber > this._lastScannedBlock) {
      this._lastScannedBlock = blockNumber;
      this._dirty = true;
    }
  }

  get dirty(): boolean {
    return this._dirty;
  }

  snapshot(): AffiliateMapSnapshot {
    const entries: Record<string, string> = {};
    for (const [human, group] of this.humanToGroup) {
      entries[human] = group;
    }
    return {
      lastScannedBlock: this._lastScannedBlock,
      entries
    };
  }

  /**
   * Persist to the state store under a dedicated app_name key, distinct from
   * the worker's own scan cursor row. Safe to call when not dirty (no-op).
   */
  async save(stateStore: StateStore, appName: string): Promise<void> {
    if (!this._dirty) return;
    await stateStore.save(appName, this._lastScannedBlock, this.snapshot() as unknown as Record<string, unknown>);
    this._dirty = false;
  }

  static async load(stateStore: StateStore, appName: string): Promise<AffiliateMap | null> {
    const persisted = await stateStore.load(appName);
    if (!persisted) return null;
    const data = persisted.data as Partial<AffiliateMapSnapshot> | undefined;
    if (!data || typeof data.entries !== "object" || data.entries === null) {
      return AffiliateMap.fromSnapshot({
        lastScannedBlock: persisted.lastScannedBlock,
        entries: {}
      });
    }
    return AffiliateMap.fromSnapshot({
      lastScannedBlock: persisted.lastScannedBlock,
      entries: data.entries as Record<string, string>
    });
  }

  private maybeAdvanceCursor(blockNumber?: number): void {
    if (typeof blockNumber === "number" && blockNumber > this._lastScannedBlock) {
      this._lastScannedBlock = blockNumber;
    }
  }
}

function normalize(address: string): string | null {
  try {
    return getAddress(address).toLowerCase();
  } catch {
    return null;
  }
}

function addToReverse(map: Map<string, Set<string>>, group: string, human: string): void {
  let set = map.get(group);
  if (!set) {
    set = new Set();
    map.set(group, set);
  }
  set.add(human);
}

function removeFromReverse(map: Map<string, Set<string>>, group: string, human: string): void {
  const set = map.get(group);
  if (!set) return;
  set.delete(human);
  if (set.size === 0) map.delete(group);
}
