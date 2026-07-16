import {getAddress} from "ethers";

import {StateStore} from "../../services/stateStore";

/**
 * Persistent MULTI-membership index built from the NEW MultiAffiliateGroupRegistry
 * (`0x4a25a7cf…`) `AffiliateGroupAdded` / `AffiliateGroupRemoved` events.
 *
 * Unlike group-affiliates' single-slot {@link AffiliateMap} (one group per human),
 * an avatar here belongs to MANY groups at once — mirroring the on-chain
 * per-avatar linked list. Maintained by history backfill on boot and kept current
 * by the realtime WSS listener; consumed by the reconciler as the membership
 * source so community-new no longer depends on the staging-only wishlist RPC.
 *
 * Not a security boundary: a stale/incomplete map can only under-report members
 * (fail to trust), never over-untrust — untrust decisions remain gated by the
 * reconciler's mode + circuit breaker.
 */
export type AffiliateMultiMapSnapshot = {
  /** Highest block whose registry events have been reduced into the map. */
  lastScannedBlock: number;
  /** Lowercased avatar → sorted list of lowercased affiliate group addresses. */
  entries: Record<string, string[]>;
};

export class AffiliateMultiMap {
  private readonly avatarToGroups = new Map<string, Set<string>>();
  private readonly groupToAvatars = new Map<string, Set<string>>();
  private _lastScannedBlock: number;
  private _dirty = false;

  constructor(lastScannedBlock = 0) {
    this._lastScannedBlock = lastScannedBlock;
  }

  static fromSnapshot(snapshot: AffiliateMultiMapSnapshot): AffiliateMultiMap {
    const map = new AffiliateMultiMap(snapshot.lastScannedBlock);
    for (const [avatar, groups] of Object.entries(snapshot.entries ?? {})) {
      for (const group of groups ?? []) {
        map.link(avatar, group);
      }
    }
    map._dirty = false;
    return map;
  }

  /** Apply an `AffiliateGroupAdded(group, avatar)` event. */
  add(avatar: string, group: string, observedAtBlock?: number): void {
    if (this.link(avatar, group)) this._dirty = true;
    this.maybeAdvanceCursor(observedAtBlock);
  }

  /** Apply an `AffiliateGroupRemoved(group, avatar)` event. */
  remove(avatar: string, group: string, observedAtBlock?: number): void {
    if (this.unlink(avatar, group)) this._dirty = true;
    this.maybeAdvanceCursor(observedAtBlock);
  }

  /** Groups the avatar currently belongs to. */
  getGroups(avatar: string): string[] {
    const normalized = normalize(avatar);
    if (!normalized) return [];
    const set = this.avatarToGroups.get(normalized);
    return set ? Array.from(set).sort() : [];
  }

  /** Avatars that currently belong to the group (the on-chain wishlist equivalent). */
  getMembersOf(group: string): Set<string> {
    const normalized = normalize(group);
    if (!normalized) return new Set<string>();
    return new Set(this.groupToAvatars.get(normalized) ?? []);
  }

  get lastScannedBlock(): number {
    return this._lastScannedBlock;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  advanceCursor(blockNumber: number): void {
    if (blockNumber > this._lastScannedBlock) {
      this._lastScannedBlock = blockNumber;
      this._dirty = true;
    }
  }

  snapshot(): AffiliateMultiMapSnapshot {
    const entries: Record<string, string[]> = {};
    for (const [avatar, groups] of this.avatarToGroups) {
      entries[avatar] = Array.from(groups).sort();
    }
    return {lastScannedBlock: this._lastScannedBlock, entries};
  }

  async save(stateStore: StateStore, appName: string): Promise<void> {
    if (!this._dirty) return;
    await stateStore.save(appName, this._lastScannedBlock, this.snapshot() as unknown as Record<string, unknown>);
    this._dirty = false;
  }

  static async load(stateStore: StateStore, appName: string): Promise<AffiliateMultiMap | null> {
    const persisted = await stateStore.load(appName);
    if (!persisted) return null;
    const data = persisted.data as Partial<AffiliateMultiMapSnapshot> | undefined;
    const entries = data && typeof data.entries === "object" && data.entries !== null
      ? data.entries as Record<string, string[]>
      : {};
    return AffiliateMultiMap.fromSnapshot({lastScannedBlock: persisted.lastScannedBlock, entries});
  }

  private link(avatar: string, group: string): boolean {
    const a = normalize(avatar);
    const g = normalize(group);
    if (!a || !g) return false;
    let groups = this.avatarToGroups.get(a);
    if (!groups) {
      groups = new Set<string>();
      this.avatarToGroups.set(a, groups);
    }
    if (groups.has(g)) return false;
    groups.add(g);
    let avatars = this.groupToAvatars.get(g);
    if (!avatars) {
      avatars = new Set<string>();
      this.groupToAvatars.set(g, avatars);
    }
    avatars.add(a);
    return true;
  }

  private unlink(avatar: string, group: string): boolean {
    const a = normalize(avatar);
    const g = normalize(group);
    if (!a || !g) return false;
    const groups = this.avatarToGroups.get(a);
    if (!groups || !groups.has(g)) return false;
    groups.delete(g);
    if (groups.size === 0) this.avatarToGroups.delete(a);
    const avatars = this.groupToAvatars.get(g);
    if (avatars) {
      avatars.delete(a);
      if (avatars.size === 0) this.groupToAvatars.delete(g);
    }
    return true;
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
