import {getAddress} from "ethers";

import {ILoggerService} from "../../interfaces/ILoggerService";
import {StateStore} from "../../services/stateStore";
import {AffiliateMap} from "../group-affiliates/affiliateMap";
import {mergeProtectedTrustees} from "./grandfather";
import {
  AffiliateGroupChangedListenerHandle,
  deriveGroupAffiliatesWsUrl,
  fetchAffiliateGroupChangedEventsBetween,
  fetchCurrentBlockNumber,
  makeHeadCursor,
  startAffiliateGroupChangedListener
} from "../group-affiliates/realtime";

/**
 * Old single-slot affiliate-registry membership source for community-new.
 *
 * This is the exact engine group-affiliates uses — the shared {@link AffiliateMap}
 * (human → current affiliate group, last-writer-wins) hydrated by replaying
 * `AffiliateGroupChanged` events, plus the same getLogs backfill / WSS realtime
 * listener from group-affiliates/realtime. Reusing that code (rather than
 * re-implementing it) guarantees byte-identical old-registry behavior, so
 * community-new in `old`/`hybrid` mode is a faithful replacement.
 *
 * `getMembersOf(group)` returns the current single-slot membership of a group —
 * this is what feeds `wishlistOverrideByGroup` for non-test avatars.
 */
export const OLD_AFFILIATE_MAP_STATE_KEY = "community-new:old-affiliate-map";

export type OldRegistrySourceOptions = {
  chainRpcUrl: string;
  wssUrl?: string;
  registryAddress: string;
  startBlock: number;
  logger: ILoggerService;
  stateStore: StateStore | null;
  enableWss: boolean;
};

export class OldRegistrySource {
  private listener: AffiliateGroupChangedListenerHandle | null = null;
  // Serializes ALL map mutations (poll refresh + WSS onEvents) so they never
  // interleave — AffiliateMap.set is last-writer-wins by CALL order, not block
  // order, so concurrent writers could regress a human to a stale group. Mirrors
  // group-affiliates' enqueueExclusive.
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly map: AffiliateMap,
    private readonly opts: OldRegistrySourceOptions
  ) {}

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Load the persisted map (if any) or start fresh at the registry deploy block. */
  static async create(opts: OldRegistrySourceOptions): Promise<OldRegistrySource> {
    const loaded = opts.stateStore
      ? await AffiliateMap.load(opts.stateStore, OLD_AFFILIATE_MAP_STATE_KEY)
      : null;
    const map = loaded ?? new AffiliateMap(Math.max(0, opts.startBlock - 1));
    return new OldRegistrySource(map, opts);
  }

  /**
   * Full backfill from the persisted cursor to chain head BEFORE the first
   * reconcile (mirrors group-affiliates' ensureAffiliateMapBackfill), so the
   * membership set is complete — a partial map would look like mass departures
   * and, under wishlist untrust, evict real members. Then optionally start the
   * WSS listener for realtime updates.
   */
  async init(): Promise<void> {
    await this.refresh();
    if (this.opts.enableWss) {
      this.startListener();
    }
  }

  /**
   * Incremental getLogs catch-up to chain head + persist. Also the poll backstop.
   * Resolves false when the head block could not be read, so the map was not
   * brought up to date; getLogs failures reject.
   */
  refresh(): Promise<boolean> {
    return this.runExclusive(() => this.refreshInner());
  }

  private async refreshInner(): Promise<boolean> {
    const head = await fetchCurrentBlockNumber(this.opts.chainRpcUrl);
    if (head === null) return false;
    const from = Math.max(this.opts.startBlock, this.map.lastScannedBlock + 1);
    if (from > head) return true;
    const events = await fetchAffiliateGroupChangedEventsBetween(
      this.opts.chainRpcUrl,
      this.opts.registryAddress,
      from,
      head,
      null,
      this.opts.logger
    );
    for (const event of events) {
      this.map.set(event.human, event.newGroup, event.blockNumber);
    }
    this.map.advanceCursor(head);
    await this.persist();
    return true;
  }

  /** Current single-slot members of a group (lowercased). */
  getMembersOf(group: string): Set<string> {
    return new Set(this.map.getAffiliatesOf(group));
  }

  /** Current single-slot members per group, keyed by the lowercased group address. */
  getMembersByGroup(groups: readonly string[]): Record<string, Set<string>> {
    const membersByGroup: Record<string, Set<string>> = {};
    for (const group of groups) {
      membersByGroup[getAddress(group).toLowerCase()] = this.getMembersOf(group);
    }
    return membersByGroup;
  }

  get lastScannedBlock(): number {
    return this.map.lastScannedBlock;
  }

  stop(): void {
    if (this.listener) {
      try {
        this.listener.stop();
      } catch (error) {
        this.opts.logger.warn("Failed to stop old-affiliate listener:", error);
      }
      this.listener = null;
    }
  }

  private startListener(): void {
    const wsUrl = this.opts.wssUrl ?? deriveGroupAffiliatesWsUrl(this.opts.chainRpcUrl);
    this.listener = startAffiliateGroupChangedListener({
      httpRpcUrl: this.opts.chainRpcUrl,
      wsUrl,
      registryAddress: this.opts.registryAddress,
      logger: this.opts.logger.child("wss-old"),
      startCursor: makeHeadCursor(this.map.lastScannedBlock),
      onEvents: (events) => this.runExclusive(async () => {
        for (const event of events) {
          this.map.set(event.human, event.newGroup, event.blockNumber);
        }
        await this.persist();
        return true;
      })
    });
    this.opts.logger.info(`Old-affiliate WSS listener started on ${wsUrl}.`);
  }

  private async persist(): Promise<void> {
    if (!this.opts.stateStore) return;
    try {
      await this.map.save(this.opts.stateStore, OLD_AFFILIATE_MAP_STATE_KEY);
    } catch (error) {
      this.opts.logger.warn("Failed to persist old-affiliate map:", error);
    }
  }
}

/**
 * Hybrid membership merge, per group. Non-test avatars are governed by the OLD
 * single-slot registry (prod behavior, unchanged); test-dev avatars in the
 * allowlist are governed entirely by the NEW multi-registry (so they can exercise
 * add/remove-multiple-groups). Per-address the source switches — not a union.
 * All inputs are lowercased.
 */
export function mergeHybridMembers(
  oldMembers: ReadonlySet<string>,
  newMembers: ReadonlySet<string>,
  testAddresses: ReadonlySet<string>
): Set<string> {
  const merged = new Set<string>();
  for (const avatar of oldMembers) {
    if (!testAddresses.has(avatar)) merged.add(avatar);
  }
  for (const avatar of newMembers) {
    if (testAddresses.has(avatar)) merged.add(avatar);
  }
  return merged;
}

/**
 * Protected trustees for `union` untrust: every avatar whose current OLD-registry
 * affiliate group is a managed group, plus the grandfathered addresses.
 *
 * Reads the incremental map instead of rescanning the registry from its start
 * block on every poll (that rescan was 24 eth_getLogs calls of 100k blocks each
 * per pass by October 2026, and grows with the chain). Throws when the map could
 * not be brought to the chain head: a stale list could untrust a member who
 * joined through the old registry since the last refresh, so the caller must
 * skip the reconcile, as it did when the rescan failed.
 */
export async function refreshUnionProtectedTrustees(
  source: OldRegistrySource,
  groups: readonly string[],
  grandfatherByGroup: Record<string, ReadonlySet<string>>
): Promise<Record<string, Set<string>>> {
  const reachedHead = await source.refresh();
  if (!reachedHead) {
    throw new Error(
      `Old-registry map could not reach the chain head (lastScannedBlock=${source.lastScannedBlock}); ` +
      "skipping this reconcile so union protection is not read from a stale map."
    );
  }
  return mergeProtectedTrustees(source.getMembersByGroup(groups), grandfatherByGroup);
}
