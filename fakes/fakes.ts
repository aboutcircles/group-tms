import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";
import {CrcV2_Trust} from "@circles-sdk/data";
import {getAddress} from "ethers";
import {ICirclesRpc} from "../src/interfaces/ICirclesRpc";
import {IChainRpc} from "../src/interfaces/IChainRpc";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../src/interfaces/IBlacklistingService";
import {IGroupService} from "../src/interfaces/IGroupService";
import {
  CreateLBPResult,
  IBackingInstanceService,
  ResetCowSwapOrderResult
} from "../src/interfaces/IBackingInstanceService";
import {ISlackService} from "../src/interfaces/ISlackService";
import {ILoggerService} from "../src/interfaces/ILoggerService";
import {AffiliateGroupChanged, IAffiliateGroupEventsService} from "../src/interfaces/IAffiliateGroupEventsService";
import {
  type AvatarSafeResult,
  IAvatarSafeService,
  SafeOwnerSelection
} from "../src/interfaces/IAvatarSafeService";
import {IRouterService} from "../src/interfaces/IRouterService";
import {IRouterEnablementStore} from "../src/interfaces/IRouterEnablementStore";
import {IAvatarSafeMappingStore, SafeTrustState} from "../src/interfaces/IAvatarSafeMappingStore";

export class FakeLogger implements ILoggerService {
  logs: { level: "info" | "warn" | "error" | "debug" | "table"; args: unknown[] }[] = [];

  constructor(private readonly verbose: boolean = true) {
  }

  private push(level: any, ...args: unknown[]) {
    if (level === "debug" || level === "table") {
      if (!this.verbose) {
        return;
      }
    }
    this.logs.push({level, args});
  }

  info(...args: unknown[]): void {
    this.push("info", ...args);
  }

  warn(...args: unknown[]): void {
    this.push("warn", ...args);
  }

  error(...args: unknown[]): void {
    this.push("error", ...args);
  }

  debug(...args: unknown[]): void {
    this.push("debug", ...args);
  }

  table(data: any, columns?: readonly (string | number)[]): void {
    this.push("table", data, columns);
  }

  child(prefix: string): ILoggerService {
    return this;
  }
}

export class FakeCirclesRpc implements ICirclesRpc {
  initiated: CrcV2_CirclesBackingInitiated[] = [];
  completed: CrcV2_CirclesBackingCompleted[] = [];
  trusts: CrcV2_Trust[] = [];
  trusteesByTruster: Record<string, string[]> = {};
  baseGroups: string[] = [];
  humanityOverrides = new Map<string, boolean>();

  async fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    return this.initiated.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= upper);
  }

  async fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    return this.completed.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= upper);
  }

  async fetchAllTrustees(truster: string): Promise<string[]> {
    return this.trusteesByTruster[truster.toLowerCase()] ?? [];
  }

  async fetchAllBaseGroups(_pageSize?: number): Promise<string[]> {
    return this.baseGroups;
  }

  async isHuman(address: string): Promise<boolean> {
    const normalized = address.toLowerCase();
    const override = this.humanityOverrides.get(normalized);
    if (override !== undefined) {
      return override;
    }

    if (this.baseGroups.some((group) => group.toLowerCase() === normalized)) {
      return false;
    }

    return true;
  }
}

export class FakeChainRpc implements IChainRpc {
  constructor(private readonly head: { blockNumber: number; timestamp: number }) {
  }

  async getHeadBlock(): Promise<{ blockNumber: number; timestamp: number }> {
    return this.head;
  }

  async getTransactionReceipt(txHash: string): Promise<any> {
    throw new Error("Not used in these tests");
  }
}

export class FakeBlacklist implements IBlacklistingService {
  private loaded: boolean = false;

  constructor(private readonly blocked: Set<string> = new Set(), private readonly flagged: Set<string> = new Set()) {
  }

  async loadBlacklist(): Promise<void> {
    this.loaded = true;
  }

  getBlacklistCount(): number {
    return this.blocked.size + this.flagged.size;
  }

  async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
    return addresses.map(a => {
      const lc = a.toLowerCase();
      if (this.blocked.has(lc)) {
        return {address: lc, is_bot: true, category: "blocked"};
      }
      if (this.flagged.has(lc)) {
        return {address: lc, is_bot: false, category: "flagged"};
      }
      return {address: lc, is_bot: false};
    });
  }
}

export class FakeGroupService implements IGroupService {
  calls: { type: "trust" | "untrust"; groupAddress: string; trusteeAddresses: string[] }[] = [];
  trustCalls = 0;
  untrustCalls = 0;

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.trustCalls += 1;
    this.calls.push({type: "trust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xtrust_${this.trustCalls}`;
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.untrustCalls += 1;
    this.calls.push({type: "untrust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xuntrust_${this.untrustCalls}`;
  }

  async fetchGroupOwnerAndService(): Promise<any> {
    throw new Error("Not under test");
  }
}

export class FakeAvatarSafeService implements IAvatarSafeService {
  private readonly safeByAvatar: Map<string, { safe: string; timestamp: string }> | null;

  constructor(
    mapping: Record<string, string | { safe: string; timestamp: string | number }> | null = null
  ) {
    if (mapping === null) {
      this.safeByAvatar = null;
      return;
    }

    this.safeByAvatar = new Map<string, { safe: string; timestamp: string }>();
    for (const [rawAvatar, value] of Object.entries(mapping)) {
      try {
        const normalized = getAddress(rawAvatar);
        if (typeof value === "string") {
          this.safeByAvatar.set(normalized, {safe: value, timestamp: "0"});
        } else {
          this.safeByAvatar.set(normalized, {safe: value.safe, timestamp: String(value.timestamp)});
        }
      } catch {
        // ignore invalid addresses provided in tests
      }
    }
  }

  async findAvatarsWithSafes(avatars: string[]): Promise<AvatarSafeResult> {
    const candidates: Array<{ avatar: string; safe: string; timestamp: string }> = [];
    for (const avatar of avatars) {
      try {
        const normalized = getAddress(avatar);
        if (this.safeByAvatar === null) {
          candidates.push({
            avatar: normalized,
            safe: `0xsafe_${normalized.slice(2, 8).toLowerCase()}`,
            timestamp: "0"
          });
          continue;
        }

        const configured = this.safeByAvatar.get(normalized);
        if (configured) {
          candidates.push({
            avatar: normalized,
            safe: configured.safe,
            timestamp: configured.timestamp
          });
        }
      } catch {
        // ignore invalid avatar addresses passed in tests
      }
    }

    const selectedOwnersBySafe = new Map<string, SafeOwnerSelection>();
    for (const candidate of candidates) {
      const existing = selectedOwnersBySafe.get(candidate.safe);
      if (!existing || compareTimestamp(candidate.timestamp, existing.timestamp) > 0) {
        selectedOwnersBySafe.set(candidate.safe, {
          avatar: candidate.avatar,
          timestamp: candidate.timestamp
        });
      }
    }

    const mappings = new Map<string, string>();
    for (const [safe, selected] of selectedOwnersBySafe.entries()) {
      mappings.set(selected.avatar, safe);
    }

    return {mappings, selectedOwnersBySafe};
  }
}

export class FakeBackingInstanceService implements IBackingInstanceService {
  simulateReset: Record<string, ResetCowSwapOrderResult> = {};
  simulateCreate: Record<string, CreateLBPResult> = {};
  resetCalls: string[] = [];
  createCalls: string[] = [];

  async simulateResetCowSwapOrder(addr: string): Promise<ResetCowSwapOrderResult> {
    return this.simulateReset[addr.toLowerCase()];
  }

  async simulateCreateLbp(addr: string): Promise<CreateLBPResult> {
    return this.simulateCreate[addr.toLowerCase()];
  }

  async resetCowSwapOrder(addr: string): Promise<string> {
    this.resetCalls.push(addr.toLowerCase());
    return `0xreset_${addr.toLowerCase()}`;
  }

  async createLbp(addr: string): Promise<string> {
    this.createCalls.push(addr.toLowerCase());
    return `0xcreate_${addr.toLowerCase()}`;
  }
}

export class FakeSlack implements ISlackService {
  notifications: { event: CrcV2_CirclesBackingInitiated; reason: string }[] = [];
  generalNotifications: string[] = [];

  async notifyBackingNotCompleted(backingInitiatedEvent: CrcV2_CirclesBackingInitiated, reason: string): Promise<void> {
    this.notifications.push({event: backingInitiatedEvent, reason});
  }

  async notifySlackStartOrCrash(message: string): Promise<void> {
    this.generalNotifications.push(message);
  }
}

export class FakeAffiliateGroupEvents implements IAffiliateGroupEventsService {
  events: AffiliateGroupChanged[] = [];

  async fetchAffiliateGroupChanged(
    registryAddress: string,
    targetGroup: string,
    fromBlock: number,
    toBlock?: number
  ): Promise<AffiliateGroupChanged[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    const g = targetGroup.toLowerCase();
    return this.events.filter(
      (e) => e.blockNumber >= fromBlock && e.blockNumber <= upper &&
        (e.oldGroup.toLowerCase() === g || e.newGroup.toLowerCase() === g)
    );
  }
}

export class FakeRouterService implements IRouterService {
  calls: { baseGroup: string; crcAddresses: string[] }[] = [];
  txHashes: string[] = [];
  private readonly responseQueue: string[];
  failWith?: Error;

  constructor(txHashResponses: string[] = []) {
    this.responseQueue = [...txHashResponses];
  }

  async enableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<string> {
    this.calls.push({baseGroup, crcAddresses: [...crcAddresses]});
    if (this.failWith) {
      throw this.failWith;
    }

    const txHash = this.responseQueue.length > 0
      ? this.responseQueue.shift()!
      : `0xtx_${this.calls.length}`;
    this.txHashes.push(txHash);
    return txHash;
  }
}

export class FakeRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Set<string>();

  constructor(initial?: string[]) {
    if (initial) {
      initial.forEach((address) => this.enabled.add(address.toLowerCase()));
    }
  }

  async loadEnabledAddresses(): Promise<string[]> {
    return Array.from(this.enabled);
  }

  async markEnabled(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      this.enabled.add(address.toLowerCase());
    }
  }
}

export class FakeAvatarSafeMappingStore implements IAvatarSafeMappingStore {
  private mapping: Map<string, string>;
  private safeTrustState: Map<string, SafeTrustState>;
  saveCalls = 0;

  constructor(initial?: Record<string, string>, initialSafeTrustState?: Record<string, SafeTrustState>) {
    this.mapping = new Map<string, string>();
    if (initial) {
      for (const [avatar, safe] of Object.entries(initial)) {
        try {
          this.mapping.set(getAddress(avatar), safe);
        } catch {
          // ignore invalid addresses in tests
        }
      }
    }
    this.safeTrustState = new Map<string, SafeTrustState>();
    if (initialSafeTrustState) {
      for (const [safe, state] of Object.entries(initialSafeTrustState)) {
        this.safeTrustState.set(safe, {...state});
      }
    }
  }

  async load(): Promise<Map<string, string>> {
    return new Map(this.mapping);
  }

  async save(mapping: Map<string, string>): Promise<void> {
    this.saveCalls += 1;
    this.mapping = new Map(mapping);
  }

  async loadSafeTrustState(): Promise<Map<string, SafeTrustState>> {
    return new Map(
      Array.from(this.safeTrustState.entries()).map(([safe, state]) => [safe, {...state}])
    );
  }

  async saveSafeTrustState(state: Map<string, SafeTrustState>): Promise<void> {
    this.safeTrustState = new Map(
      Array.from(state.entries()).map(([safe, value]) => [safe, {...value}])
    );
  }

  getSavedMapping(): Map<string, string> {
    return new Map(this.mapping);
  }

  getSavedSafeTrustState(): Map<string, SafeTrustState> {
    return new Map(
      Array.from(this.safeTrustState.entries()).map(([safe, state]) => [safe, {...state}])
    );
  }
}

function compareTimestamp(left: string, right: string): number {
  const leftBigInt = toComparableBigInt(left);
  const rightBigInt = toComparableBigInt(right);

  if (leftBigInt === null || rightBigInt === null) {
    return left.localeCompare(right);
  }

  if (leftBigInt > rightBigInt) return 1;
  if (leftBigInt < rightBigInt) return -1;
  return 0;
}

function toComparableBigInt(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return BigInt(parsedDate);
  }

  return null;
}
