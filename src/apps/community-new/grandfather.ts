import {getAddress} from "ethers";

/**
 * Cutover grandfather list.
 *
 * At the old→new cutover a handful of avatars are trusted on-chain but absent
 * from the registry that feeds the wishlist (orphans — e.g. members whose old
 * single-slot points elsewhere yet were left trusted by the event-driven
 * predecessor). A strictly authoritative `wishlist` sweep would evict them.
 * Listing them here adds them to the `union` protected set, so an authoritative
 * run spares exactly those addresses while EVERY other member still gets full
 * join / leave / reputation enforcement.
 *
 * The list is frozen by config on purpose. A recomputed "current trustees minus
 * current members" set would re-protect anyone who leaves AFTER cutover (the
 * moment they leave they become an orphan), silently defeating leave handling.
 * A static, reviewable list keeps leave/rep enforcement intact for everyone
 * except the explicitly enumerated carve-outs.
 *
 * Format: a JSON object mapping a managed group address to the avatar addresses
 * grandfathered in that group, e.g.
 *   COMMUNITY_NEW_GRANDFATHER_ADDRESSES={"0x4e25…":["0x154d…","0x1e34…"]}
 * Keys and values are checksum-validated and lowercased. Only consulted in
 * `union` untrust mode.
 */
export const GRANDFATHER_ENV = "COMMUNITY_NEW_GRANDFATHER_ADDRESSES";

function normalizeAddress(value: string): string {
  return getAddress(value).toLowerCase();
}

/** Parses {@link GRANDFATHER_ENV}. Empty/unset → no grandfathering. Throws on malformed input. */
export function parseGrandfatherAddresses(raw: string | undefined): Record<string, Set<string>> {
  const result: Record<string, Set<string>> = {};
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(
      `${GRANDFATHER_ENV} must be a JSON object mapping group address → avatar address[]; got invalid JSON`,
      {cause: cause instanceof Error ? cause : new Error(String(cause))}
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${GRANDFATHER_ENV} must be a JSON object mapping group address → avatar address[]`);
  }

  for (const [rawGroup, rawAddresses] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(rawAddresses)) {
      throw new Error(`${GRANDFATHER_ENV}["${rawGroup}"] must be an array of avatar addresses`);
    }
    let group: string;
    try {
      group = normalizeAddress(rawGroup);
    } catch {
      throw new Error(`${GRANDFATHER_ENV} has an invalid group address "${rawGroup}"`);
    }
    const set = result[group] ?? new Set<string>();
    for (const rawAddress of rawAddresses) {
      if (typeof rawAddress !== "string") {
        throw new Error(`${GRANDFATHER_ENV}["${rawGroup}"] must contain only address strings`);
      }
      try {
        set.add(normalizeAddress(rawAddress));
      } catch {
        throw new Error(`${GRANDFATHER_ENV}["${rawGroup}"] has an invalid avatar address "${rawAddress}"`);
      }
    }
    result[group] = set;
  }
  return result;
}

/** Total grandfathered addresses across all groups (logging / validation). */
export function countGrandfather(byGroup: Record<string, ReadonlySet<string>>): number {
  return Object.values(byGroup).reduce((sum, set) => sum + set.size, 0);
}

/**
 * Folds the frozen grandfather list into a per-group protected set (e.g. the
 * old-registry members `union` already protects), so an authoritative run spares
 * both current members and the grandfathered orphans. Inputs are not mutated.
 */
export function mergeProtectedTrustees(
  base: Record<string, ReadonlySet<string>>,
  grandfather: Record<string, ReadonlySet<string>>
): Record<string, Set<string>> {
  const merged: Record<string, Set<string>> = {};
  const groups = new Set<string>([...Object.keys(base), ...Object.keys(grandfather)]);
  for (const group of groups) {
    const set = new Set<string>();
    for (const address of base[group] ?? []) set.add(address);
    for (const address of grandfather[group] ?? []) set.add(address);
    merged[group] = set;
  }
  return merged;
}
