import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {IChainRpc} from "../../interfaces/IChainRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IAffiliateGroupEventsService, AffiliateGroupChanged} from "../../interfaces/IAffiliateGroupEventsService";

export const ALWAYS_TRUSTED_ADDRESSES = [
  "0xa63abf03d5c6ef8d56e1432277573c47cbe8a8a6", //Bijan
  "0xf7bd3d83df90b4682725adf668791d4d1499207f", //Armagan
  "0xf48554937f18885c7f15c432c596b5843648231d", //Paul
  "0x597400c5982ad5890e799ff43f081c59695a57bd", //Ann
  // Additional whitelisted addresses
  "0x32fe45a99770add32a5d93f0b4f6b3c15dffd2a4",
  "0x53c9ca06ed68e961b566167c5e8f67c0b7009cb6",
  "0x5b9129e0035c9fabf23ffb7a003055deea618592",
  "0x7bf7b64179b43eb109c6fc30432c076d42015e65",
  "0x7d2ec03a058457053ea77e30a72fc1130e5f5c3c",
  "0x96821a4f2e986729759a146abedceacba690351c",
  "0x98a9750213fa2f19717fad42e9a0879ba7b92546",
  "0xa7b9ff11459ad0d343d12a480f34c4533d2f4432",
  "0xc175a0c71f1eda836ebbf3ab0e32fc8865fdee91",
  "0xc3ccd9455b301d01d69dfb0b9fc38bee39829598",
  "0xc44d775f4818e0a06d3558c91c86ad0743d3c12a",
  "0xc7d3df890952a327af94d5ba6fdc1bf145188a1b",
  "0xcf6dc192dc292d5f2789da2db02d6dd4f41f4214",
  "0xd447bdea939313c2e83654be3220e87fd0d7bdf6",
  "0xd7897c4d23761708583affd9a9f31f127215088d",
  "0xdcc6f30bc1b06b7523c364beffbf879475d140b6",
  "0xed3e137b23fb9e01dc9e8dd8c40f633877636f75",
  "0xee7e9d56875c3b5a12579433f3b24fa859cffce8",
] as const;

const ALWAYS_TRUSTED_SET = new Set<string>(
  ALWAYS_TRUSTED_ADDRESSES.map(addr => addr.toLowerCase()),
);

export type RunConfig = {
  confirmationBlocks: number;
  groupAddress: string;
  metaOrgAddress: string;
  affiliateRegistryAddress: string;
  outputBatchSize: number;
  deployedAtBlock: number;
  dryRun?: boolean;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  chainRpc: IChainRpc;
  groupService: IGroupService;
  affiliateRegistry: IAffiliateGroupEventsService;
  logger: ILoggerService;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Helper function to fetch trustees for an address
async function fetchTrustees(
  circlesRpc: ICirclesRpc,
  address: string,
): Promise<Set<string>> {
  const trustees = await circlesRpc.fetchAllTrustees(address);
  return new Set(trustees.map(addr => addr.toLowerCase()));
}

// Helper function to calculate desired trustees efficiently
// Returns both the desired set and the union of addresses trusted by any MetaOrg trustee
async function calculateDesiredTrustees(
  circlesRpc: ICirclesRpc,
  metaOrgTrustees: Set<string>,
  affiliates: Set<string>,
): Promise<{ desired: Set<string>; trustedByAnyMetaOrgTrustee: Set<string> }> {
  // Fetch trustees for all MetaOrg trustees in parallel
  const trusteePromises = Array.from(metaOrgTrustees).map(trustee =>
    fetchTrustees(circlesRpc, trustee)
  );
  
  const secondDegreeTrusteeSets = await Promise.all(trusteePromises);
  
  // Union all second-degree trustees efficiently
  const trustedByAnyMetaOrgTrustee = new Set<string>();
  for (const trusteeSet of secondDegreeTrusteeSets) {
    for (const addr of trusteeSet) {
      trustedByAnyMetaOrgTrustee.add(addr);
    }
  }
  
  // Intersection with affiliates
  const desired = new Set<string>();
  for (const addr of trustedByAnyMetaOrgTrustee) {
    if (affiliates.has(addr)) {
      desired.add(addr);
    }
  }
  
  return { desired, trustedByAnyMetaOrgTrustee };
}

// Helper function to process trust/untrust operations sequentially to avoid nonce issues
async function processTrustOperations(
  groupService: IGroupService,
  group: string,
  shouldTrust: string[],
  shouldUntrust: string[],
  outputBatchSize: number,
  logger: ILoggerService
): Promise<void> {
  const trustBatches = chunk(shouldTrust, outputBatchSize);
  const untrustBatches = chunk(shouldUntrust, outputBatchSize);

  // Process untrust operations first, sequentially
  for (let i = 0; i < untrustBatches.length; i++) {
    const batch = untrustBatches[i];
    logger.info(`Untrusting batch ${i + 1}/${untrustBatches.length} (${batch.length})...`);
    await groupService.untrustBatch(group, batch);
    logger.info(`  - Untrust batch ${i + 1}/${untrustBatches.length} done.`);
  }

  // Then process trust operations, sequentially
  for (let i = 0; i < trustBatches.length; i++) {
    const batch = trustBatches[i];
    logger.info(`Trusting batch ${i + 1}/${trustBatches.length} (${batch.length})...`);
    await groupService.trustBatchWithConditions(group, batch);
    logger.info(`  - Trust batch ${i + 1}/${trustBatches.length} done.`);
  }
}

async function simulateTrustOperations(
  groupService: IGroupService,
  group: string,
  shouldTrust: string[],
  shouldUntrust: string[],
  outputBatchSize: number,
  logger: ILoggerService
): Promise<void> {
  const trustBatches = chunk(shouldTrust, outputBatchSize);
  const untrustBatches = chunk(shouldUntrust, outputBatchSize);

  for (let i = 0; i < untrustBatches.length; i++) {
    const batch = untrustBatches[i];
    if (groupService.simulateUntrustBatch) {
      const simulation = await groupService.simulateUntrustBatch(group, batch);
      logger.info(
        `DRY RUN untrust simulation batch ${i + 1}/${untrustBatches.length}: ok, gasEstimate=${simulation.gasEstimate.toString()}.`
      );
    } else {
      logger.info(
        `DRY RUN untrust simulation batch ${i + 1}/${untrustBatches.length}: skipped (no signer-backed simulator configured).`
      );
    }
  }

  for (let i = 0; i < trustBatches.length; i++) {
    const batch = trustBatches[i];
    if (groupService.simulateTrustBatchWithConditions) {
      const simulation = await groupService.simulateTrustBatchWithConditions(group, batch);
      logger.info(
        `DRY RUN trust simulation batch ${i + 1}/${trustBatches.length}: ok, gasEstimate=${simulation.gasEstimate.toString()}.`
      );
    } else {
      logger.info(
        `DRY RUN trust simulation batch ${i + 1}/${trustBatches.length}: skipped (no signer-backed simulator configured).`
      );
    }
  }
}

// Core logic shared between runOnce and runIncremental
async function executeCoreLogic(
  deps: Deps,
  cfg: RunConfig,
  affiliates: Set<string>,
): Promise<void> {
  const { circlesRpc, groupService, logger: LOG } = deps;
  
  const group = cfg.groupAddress.toLowerCase();
  const metaOrg = cfg.metaOrgAddress.toLowerCase();

  // Current trustees snapshots
  const metaOrgTrusteesArr = await circlesRpc.fetchAllTrustees(metaOrg);
  const groupTrusteesArr = await circlesRpc.fetchAllTrustees(group);
  const metaOrgTrustees = new Set(metaOrgTrusteesArr.map((x) => x.toLowerCase()));
  const groupTrustees = new Set(groupTrusteesArr.map((x) => x.toLowerCase()));

  // Calculate desired trustees efficiently
  const { desired, trustedByAnyMetaOrgTrustee } = await calculateDesiredTrustees(
    circlesRpc,
    metaOrgTrustees,
    affiliates,
  );

  // Force whitelist addresses to remain trusted regardless of other conditions
  for (const addr of ALWAYS_TRUSTED_SET) {
    desired.add(addr);
  }

  // Summary stats requested for each run
  LOG.info(
    `Run stats: trustedByMetaOrgTrustees=${trustedByAnyMetaOrgTrustee.size} currentAffiliates=${affiliates.size}`
  );

  // Calculate changes needed efficiently using set operations
  const shouldTrust = Array.from(desired).filter(h => !groupTrustees.has(h));
  const shouldUntrust = Array.from(groupTrustees).filter(h => !desired.has(h));

  LOG.info(`Decision summary:`);
  LOG.info(`  - To trust now: ${shouldTrust.length}`);
  LOG.info(`  - To untrust now: ${shouldUntrust.length}`);

  if (cfg.dryRun) {
    const detailFor = (h: string, decision: "trust" | "untrust") => ({
      address: h,
      trustedByMetaOrgTrustee: trustedByAnyMetaOrgTrustee.has(h),
      hasOicAsAffiliate: affiliates.has(h),
      decision,
    });
    const fmt = (d: ReturnType<typeof detailFor>) =>
      `address=${d.address} trustedByMetaOrgTrustee=${d.trustedByMetaOrgTrustee} hasOicAsAffiliate=${d.hasOicAsAffiliate} decision=${d.decision}`;
    if (shouldTrust.length) {
      for (const h of shouldTrust) {
        const d = detailFor(h, "trust");
        LOG.info(`DRY RUN trust: ${fmt(d)}`);
      }
    }
    if (shouldUntrust.length) {
      for (const h of shouldUntrust) {
        const d = detailFor(h, "untrust");
        LOG.info(`DRY RUN untrust: ${fmt(d)}`);
      }
    }
    await simulateTrustOperations(
      groupService,
      group,
      shouldTrust,
      shouldUntrust,
      cfg.outputBatchSize,
      LOG
    );
    return;
  }

  await processTrustOperations(
    groupService,
    group,
    shouldTrust,
    shouldUntrust,
    cfg.outputBatchSize,
    LOG
  );
}

export type IncrementalState = {
  initialized: boolean;
  lastSafeHeadScanned: number; 
  affiliates: Set<string>;
};

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<void> {
  const { chainRpc, affiliateRegistry, logger: LOG } = deps;

  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks);

  const group = cfg.groupAddress.toLowerCase();
  const registry = cfg.affiliateRegistryAddress.toLowerCase();

  const startBlock = Math.max(0, cfg.deployedAtBlock);
  const affiliates = new Set<string>();

  LOG.info(`Scan range: ${startBlock} -> ${safeHeadBlock}`);
  let affEvents: AffiliateGroupChanged[] = [];
  if (startBlock <= safeHeadBlock) {
    affEvents = await affiliateRegistry.fetchAffiliateGroupChanged(registry, group, startBlock, safeHeadBlock);
  }
  // Log affiliate group change events affecting the group
  if (affEvents.length > 0) {
    const added = affEvents.filter(e => e.newGroup.toLowerCase() === group).length;
    const removed = affEvents.filter(e => e.oldGroup.toLowerCase() === group).length;
    LOG.info(
      `AffiliateGroupChanged affecting group: total=${affEvents.length} added=${added} removed=${removed}`
    );
  } else {
    LOG.info(`AffiliateGroupChanged affecting group: total=0 added=0 removed=0`);
  }

  // Apply events to maintain current affiliate set for this group
  processAffiliateEvents(affEvents, group, affiliates, false);

  // Execute the core logic
  await executeCoreLogic(deps, cfg, affiliates);
}

export async function runIncremental(
  deps: Deps,
  cfg: RunConfig,
  state: IncrementalState,
): Promise<void> {
  const { chainRpc, affiliateRegistry, logger: LOG } = deps;

  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks);

  const group = cfg.groupAddress.toLowerCase();
  const registry = cfg.affiliateRegistryAddress.toLowerCase();

  const fromBlock = state.initialized
    ? state.lastSafeHeadScanned + 1
    : Math.max(0, cfg.deployedAtBlock);

  let affEvents: AffiliateGroupChanged[] = [];
  if (fromBlock <= safeHeadBlock) {
    LOG.info(`Scan range: ${fromBlock} -> ${safeHeadBlock}`);
    affEvents = await affiliateRegistry.fetchAffiliateGroupChanged(registry, group, fromBlock, safeHeadBlock);
    // Log affiliate group change events affecting the group
    if (affEvents.length > 0) {
      const added = affEvents.filter(e => e.newGroup.toLowerCase() === group).length;
      const removed = affEvents.filter(e => e.oldGroup.toLowerCase() === group).length;
      LOG.info(
        `AffiliateGroupChanged affecting group: total=${affEvents.length} added=${added} removed=${removed}`
      );
    } else {
      LOG.info(`AffiliateGroupChanged affecting group: total=0 added=0 removed=0`);
    }

    // Apply events to maintain current affiliate set for this group
    processAffiliateEvents(affEvents, group, state.affiliates, state.initialized);
  }

  // Execute the core logic
  await executeCoreLogic(deps, cfg, state.affiliates);

  // Only mark the scan range done after a successful run
  if (fromBlock <= safeHeadBlock) {
    state.lastSafeHeadScanned = safeHeadBlock;
    state.initialized = true;
  }
}

// Helper function to create initial incremental state
export function createInitialIncrementalState(): IncrementalState {
  return {
    initialized: false,
    lastSafeHeadScanned: 0,
    affiliates: new Set<string>(),
  };
}

// Helper function to process affiliate events efficiently
function processAffiliateEvents(
  events: AffiliateGroupChanged[],
  targetGroup: string,
  currentAffiliates: Set<string>,
  isInitialized: boolean
): void {
  if (!isInitialized) {
    currentAffiliates.clear();
  }
  
  // Sort events by block number to ensure correct order
  events.sort((a, b) => a.blockNumber - b.blockNumber);
  
  for (const e of events) {
    const human = e.human.toLowerCase();
    const newGroup = e.newGroup.toLowerCase();
    const oldGroup = e.oldGroup.toLowerCase();
    
    if (newGroup === targetGroup) {
      currentAffiliates.add(human);
    }
    if (oldGroup === targetGroup) {
      currentAffiliates.delete(human);
    }
  }
}
