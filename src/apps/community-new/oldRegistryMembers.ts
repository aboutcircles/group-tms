import {getAddress} from "ethers";

import {AffiliateGroupChanged} from "../../interfaces/IAffiliateGroupEventsService";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {AffiliateGroupEventsService} from "../../services/affiliateGroupEventsService";

/** OLD single-slot affiliate registry (AffiliateGroupChanged). */
export const DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS =
  "0xca8222e780d046707083f51377b5fd85e2866014";
/** First block the old registry is scanned from (matches group-affiliates' start block). */
export const DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK = 46282003;

function normalizeAddress(address: string): string {
  return getAddress(address).toLowerCase();
}

export type OldRegistryMembersOptions = {
  registryAddress?: string;
  fromBlock?: number;
  toBlock?: number;
  logger?: ILoggerService;
};

/**
 * Reads the OLD single-slot affiliate registry and returns, per managed group,
 * the set of avatars whose CURRENT old-registry affiliate group is that group.
 *
 * Single-slot reduction: within the event stream filtered to a group, a human
 * is added on `newGroup == group` and removed on `oldGroup == group`, applied in
 * block order. Any transition that moves a human OUT of the group carries
 * `oldGroup == group` (so it is in the filtered stream), and any transition that
 * moves them elsewhere from a non-group state does not touch the group — so the
 * filtered stream fully captures the group's membership. This mirrors the
 * reduction in `oic/logic.ts` and `group-affiliates/affiliateMap.ts`.
 *
 * Used by `union` untrust mode (migration bridge — do not evict members who
 * joined via the old path) and the pre-cutover eviction-diff tool. Read-only.
 */
export async function fetchOldRegistryMembersByGroup(
  rpcUrl: string,
  groupAddresses: readonly string[],
  options: OldRegistryMembersOptions = {}
): Promise<Record<string, Set<string>>> {
  const registry = normalizeAddress(options.registryAddress ?? DEFAULT_OLD_AFFILIATE_REGISTRY_ADDRESS);
  const fromBlock = options.fromBlock ?? DEFAULT_OLD_AFFILIATE_REGISTRY_START_BLOCK;
  const service = new AffiliateGroupEventsService(rpcUrl, options.logger);

  try {
    const membersByGroup: Record<string, Set<string>> = {};
    for (const rawGroup of groupAddresses) {
      const group = normalizeAddress(rawGroup);
      const events = await service.fetchAffiliateGroupChanged(registry, group, fromBlock, options.toBlock);
      membersByGroup[group] = reduceOldRegistryMembers(events, group);
    }
    return membersByGroup;
  } finally {
    service.destroy();
  }
}

/**
 * Members of one group after applying its AffiliateGroupChanged events in block
 * order (see {@link fetchOldRegistryMembersByGroup}). The removal for
 * `oldGroup == group` is applied before the addition for `newGroup == group`, so
 * an event naming the group the human is already in keeps them: the same result
 * as the AffiliateMap current-group index that OldRegistrySource maintains.
 */
export function reduceOldRegistryMembers(
  events: readonly AffiliateGroupChanged[],
  group: string
): Set<string> {
  const target = normalizeAddress(group);
  const ordered = [...events].sort((left, right) => left.blockNumber - right.blockNumber);
  const members = new Set<string>();
  for (const event of ordered) {
    const human = normalizeAddress(event.human);
    if (normalizeAddress(event.oldGroup) === target) members.delete(human);
    if (normalizeAddress(event.newGroup) === target) members.add(human);
  }
  return members;
}
