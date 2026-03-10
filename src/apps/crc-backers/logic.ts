import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {IBlacklistingService} from "../../interfaces/IBlacklistingService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IBackingInstanceService, ResetCowSwapOrderResult, CreateLBPResult} from "../../interfaces/IBackingInstanceService";
import {ISlackService} from "../../interfaces/ISlackService";
import {IChainRpc} from "../../interfaces/IChainRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {BackingCompletedEvent, BackingInitiatedEvent} from "../../interfaces/ICirclesRpc";

export type RunConfig = {
  confirmationBlocks: number;
  backingFactoryAddress: string;
  backersGroupAddress: string;
  fromBlock: number;
  expectedTimeTillCompletion: number;
  dryRun?: boolean;
};

export type RunResult = {
  fromBlock: number;
  toBlock: number;
  safeHeadBlock: number;
  nextFromBlock: number;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  chainRpc: IChainRpc;
  blacklistingService: IBlacklistingService;
  groupService?: IGroupService;
  cowSwapService: IBackingInstanceService;
  slackService: ISlackService;
  logger: ILoggerService;
};

export type TrustBackersResult = {
  totalBackingEvents: number;
  validBackingEvents: BackingCompletedEvent[];
  blacklistedAddresses: Set<string>;
  newBackingEvents: BackingCompletedEvent[];
  trustedAddresses: string[];
  untrustedAddresses: string[];
  trustTxHashes: string[];
  untrustTxHashes: string[];
};

const TRUST_BATCH_SIZE = 50;

async function findValidBackingEvents(
  circlesRpc: ICirclesRpc,
  blacklistingService: IBlacklistingService,
  backingFactoryAddress: string,
  fromBlock: number,
  toBlock: number,
  LOG: ILoggerService,
  extraAddressesToCheck: Iterable<string> = []
): Promise<{
  totalBackingEvents: number,
  validBackingEvents: BackingCompletedEvent[],
  blacklistedAddresses: Set<string>
}> {
  const newBackingCompletedEvents = await circlesRpc.fetchBackingCompletedEvents(backingFactoryAddress, fromBlock, toBlock);
  LOG.debug(`Fetched ${newBackingCompletedEvents.length} completed backing events since block ${fromBlock} to block ${toBlock}.`);

  const addressesToCheck = new Set<string>();
  newBackingCompletedEvents.forEach((e) => addressesToCheck.add(e.backer.toLowerCase()));
  for (const addr of extraAddressesToCheck) {
    addressesToCheck.add(addr.toLowerCase());
  }
  const verdicts = await blacklistingService.checkBlacklist(Array.from(addressesToCheck));
  const blacklistedAddresses = new Set(
    verdicts
      .filter(v => v.is_bot || v.category === "blocked" || v.category === "flagged")
      .map(v => v.address.toLowerCase())
  );

  return {
    totalBackingEvents: newBackingCompletedEvents.length,
    validBackingEvents: newBackingCompletedEvents.filter(o => !blacklistedAddresses.has(o.backer.toLowerCase())),
    blacklistedAddresses
  };
}

export function batchEvents(backingEvents: BackingCompletedEvent[]) {
  const batches: BackingCompletedEvent[][] = [];
  for (let i = 0; i < backingEvents.length; i += TRUST_BATCH_SIZE) {
    batches.push(backingEvents.slice(i, i + TRUST_BATCH_SIZE));
  }
  return batches;
}

function batchAddresses(addresses: string[]) {
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += TRUST_BATCH_SIZE) {
    batches.push(addresses.slice(i, i + TRUST_BATCH_SIZE));
  }
  return batches;
}

export async function trustAllNewBackers(
  circlesRpc: ICirclesRpc,
  blacklistingService: IBlacklistingService,
  groupService: IGroupService | undefined,
  groupAddress: string,
  backingFactoryAddress: string,
  fromBlock: number,
  toBlock: number,
  dryRun: boolean,
  LOG: ILoggerService
): Promise<TrustBackersResult> {
  const trustees = new Set((await circlesRpc.fetchAllTrustees(groupAddress)).map((x) => x.toLowerCase()));
  const backingEvents = await findValidBackingEvents(
    circlesRpc,
    blacklistingService,
    backingFactoryAddress,
    fromBlock,
    toBlock,
    LOG,
    trustees
  );

  const haveAnyCompletedEvents = backingEvents.totalBackingEvents > 0;
  const haveBlacklisted = backingEvents.blacklistedAddresses.size > 0;
  if (haveAnyCompletedEvents) {
    LOG.info(`Found ${backingEvents.totalBackingEvents} completed backing events since block ${fromBlock} to block ${toBlock}.`);
    LOG.info(`  - Valid (non-blacklisted): ${backingEvents.validBackingEvents.length}`);
  }
  if (haveBlacklisted) {
    LOG.info(`  - Blacklisted addresses present (hidden; enable verbose to see list).`);
    LOG.table(Array.from(backingEvents.blacklistedAddresses).map((address) => ({address})));
  }

  const validBackerEventsByAddress = new Map<string, BackingCompletedEvent>();
  for (const event of backingEvents.validBackingEvents) {
    const backer = event.backer.toLowerCase();
    if (!validBackerEventsByAddress.has(backer)) {
      validBackerEventsByAddress.set(backer, event);
    }
  }
  const validBackers = new Set(validBackerEventsByAddress.keys());

  const blacklistedTrusted = Array.from(trustees).filter((addr) => backingEvents.blacklistedAddresses.has(addr));
  const missingTrusted = Array.from(validBackers).filter((addr) => !trustees.has(addr));
  const notAlreadyTrusted = missingTrusted.map((addr) => validBackerEventsByAddress.get(addr)!);
  const toUntrust = Array.from(new Set(blacklistedTrusted));

  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when crc-backers is not running in dry-run mode");
  }

  const willAddAny = notAlreadyTrusted.length > 0;
  const willUntrustAny = toUntrust.length > 0;

  if (haveAnyCompletedEvents || willAddAny || willUntrustAny) {
    LOG.info(`  - Already trusted: ${trustees.size}. Expected (valid backers): ${validBackers.size}. To add now: ${notAlreadyTrusted.length}. To untrust now: ${toUntrust.length}.`);
  }

  if (willUntrustAny) {
    if (blacklistedTrusted.length > 0) {
      LOG.info(`  - Blacklisted trusted backers to untrust (${blacklistedTrusted.length}):`);
      for (const addr of blacklistedTrusted) {
        LOG.info(`    - backer=${addr}`);
      }
    }

  }

  if (willAddAny) {
    LOG.info(`  - New backers to trust (${notAlreadyTrusted.length}):`);
    for (const e of notAlreadyTrusted) {
      LOG.info(`    - backer=${e.backer}, instance=${e.circlesBackingInstance}`);
    }

    LOG.debug(`Detailed list of new backers to trust (verbose):`);
    LOG.table(
      notAlreadyTrusted.map((e) => ({
        backer: e.backer,
        instance: e.circlesBackingInstance,
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        timestamp: e.timestamp
      })),
      ["backer", "instance", "blockNumber", "transactionHash", "timestamp"]
    );

  }

  const trustBatches = willAddAny ? batchEvents(notAlreadyTrusted) : [];
  const untrustBatches = willUntrustAny ? batchAddresses(toUntrust) : [];
  const trustTxHashes: string[] = [];
  const untrustTxHashes: string[] = [];

  if (dryRun || !groupService) {
    if (willUntrustAny) {
      LOG.info(`  - Dry-run enabled; would untrust ${toUntrust.length} backers in ${untrustBatches.length} batch(es).`);
      untrustBatches.forEach((batch, index) => {
        LOG.info(`    DRY RUN untrust batch ${index + 1}/${untrustBatches.length}: ${batch.length} backers -> ${batch.join(", ")}`);
      });
    }
    if (willAddAny) {
      LOG.info(`  - Dry-run enabled; would trust ${notAlreadyTrusted.length} backers in ${trustBatches.length} batch(es).`);
      trustBatches.forEach((batch, index) => {
        const backersToTrust = batch.map((e) => e.backer);
        LOG.info(`    DRY RUN trust batch ${index + 1}/${trustBatches.length}: ${batch.length} backers -> ${backersToTrust.join(", ")}`);
      });
    }
  } else {
    if (willUntrustAny) {
      for (let i = 0; i < untrustBatches.length; i++) {
        const batch = untrustBatches[i];
        LOG.info(`  - Untrusting batch ${i + 1}/${untrustBatches.length} (${batch.length} backers)...`);
        const txHash = await groupService.untrustBatch(groupAddress, batch);
        untrustTxHashes.push(txHash);
        LOG.info(`  - Untrust batch ${i + 1}/${untrustBatches.length} succeeded.`);
      }
    }

    if (willAddAny) {
      for (let i = 0; i < trustBatches.length; i++) {
        const batch = trustBatches[i];
        const backersToTrust = batch.map((e) => e.backer);

        LOG.debug(`  - Batch ${i + 1}/${trustBatches.length} addresses:`, backersToTrust);
        LOG.info(`  - Trusting batch ${i + 1}/${trustBatches.length} (${batch.length} backers)...`);

        // NOTE: call kept here to reflect real behavior. Your current main.ts had it commented.
        const txHash = await groupService.trustBatchWithConditions(groupAddress, backersToTrust);
        trustTxHashes.push(txHash);

        LOG.info(`  - Batch ${i + 1}/${trustBatches.length} succeeded.`);
      }
    }
  }

  if (willAddAny || willUntrustAny) {
    const summary: string[] = [];
    if (willUntrustAny) {
      summary.push(`${dryRun ? "Would untrust" : "Untrusted"} ${toUntrust.length} backers in ${untrustBatches.length} batch(es)`);
    }
    if (willAddAny) {
      summary.push(`${dryRun ? "Would trust" : "Trusted"} ${notAlreadyTrusted.length} new backers in ${trustBatches.length} batch(es)`);
    }
    LOG.info(`[${fromBlock}->${toBlock}] ${summary.join("; ")}.`);
  }

  return {
    ...backingEvents,
    newBackingEvents: notAlreadyTrusted,
    trustedAddresses: notAlreadyTrusted.map((e) => e.backer),
    untrustedAddresses: toUntrust,
    trustTxHashes,
    untrustTxHashes
  };
}

/**
 * Finds all pending backing processes that have been initiated but not yet completed in the given range.
 */
export async function findPendingBackingProcesses(
  circlesRpc: ICirclesRpc,
  backingFactoryAddress: string,
  fromBlock: number,
  toBlock: number,
  completedBackingProcesses: Pick<TrustBackersResult, "totalBackingEvents" | "validBackingEvents" | "blacklistedAddresses" | "newBackingEvents">,
  LOG: ILoggerService
) {
  const key = (event: BackingInitiatedEvent | BackingCompletedEvent) =>
    `${event.backer.toLowerCase()}-${event.circlesBackingInstance.toLowerCase()}`;

  const initiatedBackingProcesses = await circlesRpc.fetchBackingInitiatedEvents(backingFactoryAddress, fromBlock, toBlock);
  LOG.debug(`Fetched ${initiatedBackingProcesses.length} initiated backing processes.`);

  const completedKeys = new Set(completedBackingProcesses.validBackingEvents.map(key));
  const notBlacklisted = initiatedBackingProcesses.filter(
    (e) => !completedBackingProcesses.blacklistedAddresses.has(e.backer.toLowerCase())
  );

  const pending = notBlacklisted.filter((event) => !completedKeys.has(key(event)));
  LOG.debug(`After filtering, pending initiated-but-not-completed: ${pending.length}`);
  return pending;
}

/**
 * Computes the exact deadline of a CirclesBacking instance.
 */
export function computeOrderDeadlineSeconds(initiated: BackingInitiatedEvent): number {
  const hasTimestamp = typeof initiated.timestamp === "number" && initiated.timestamp > 0;
  if (!hasTimestamp) {
    throw new Error(`Initiated event at block ${initiated.blockNumber} has no timestamp.`);
  }
  const oneDaySeconds = 24 * 60 * 60;
  return initiated.timestamp! + oneDaySeconds;
}

function formatAddressBullet(label: string, addresses: string[], limit: number): string {
  if (addresses.length === 0) {
    return "";
  }

  const shown = addresses.slice(0, limit);
  const remaining = addresses.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${remaining} more)` : "";
  return `- ${label} (${addresses.length}): ${shown.join(", ")}${suffix}`;
}

function formatTxBullet(label: string, txHashes: string[], limit: number): string {
  if (txHashes.length === 0) {
    return "";
  }

  const shown = txHashes.slice(0, limit);
  const remaining = txHashes.length - shown.length;
  const suffix = remaining > 0 ? `, … (+${remaining} more)` : "";
  return `- ${label}: ${shown.join(", ")}${suffix}`;
}

async function notifySlackTrustSummary(
  slackService: ISlackService,
  outcome: TrustBackersResult,
  cfg: RunConfig,
  range: {fromBlock: number; toBlock: number},
  dryRun: boolean,
  LOG: ILoggerService
): Promise<void> {
  const hasChanges = outcome.trustedAddresses.length > 0 || outcome.untrustedAddresses.length > 0;
  if (!hasChanges) {
    return;
  }

  const header = dryRun
    ? "🧪 *CRC Backers Dry-Run Summary*"
    : "✅ *CRC Backers Run Summary*";

  const lines: string[] = [
    header,
    "",
    `- Backers Group: ${cfg.backersGroupAddress}`,
    `- Factory: ${cfg.backingFactoryAddress}`,
    `- Mode: ${dryRun ? "Dry Run" : "Live"}`,
    `- Blocks scanned: ${range.fromBlock}->${range.toBlock}`,
    `- Valid completed backers: ${outcome.validBackingEvents.length}`
  ];

  if (outcome.blacklistedAddresses.size > 0) {
    lines.push(`- Blacklisted this run: ${outcome.blacklistedAddresses.size}`);
  }

  const trustBullet = formatAddressBullet(dryRun ? "Would trust" : "Trusted", outcome.trustedAddresses, 10);
  if (trustBullet) {
    lines.push(trustBullet);
  }

  if (!dryRun && outcome.trustTxHashes.length > 0) {
    lines.push(formatTxBullet("Trust tx hash(es)", outcome.trustTxHashes, 5));
  }

  const untrustBullet = formatAddressBullet(dryRun ? "Would untrust" : "Untrusted", outcome.untrustedAddresses, 10);
  if (untrustBullet) {
    lines.push(untrustBullet);
  }

  if (!dryRun && outcome.untrustTxHashes.length > 0) {
    lines.push(formatTxBullet("Untrust tx hash(es)", outcome.untrustTxHashes, 5));
  }

  try {
    await slackService.notifySlackStartOrCrash(lines.join("\n"));
  } catch (error) {
    LOG.warn("Failed to send Slack trust/untrust summary:", error);
  }
}

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunResult> {
  const {
    circlesRpc, chainRpc, blacklistingService, groupService,
    cowSwapService, slackService, logger: LOG
  } = deps;
  const dryRun = !!cfg.dryRun;

  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when crc-backers is not running in dry-run mode");
  }

  // 0. Head with a small reorg buffer
  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks /* confirmations */);
  LOG.debug(`Head=${currentHead.blockNumber}, safeHead=${safeHeadBlock}, headTs=${currentHead.timestamp}`);

  // 1. Determine range to scan
  const fromBlock = cfg.fromBlock;
  if (safeHeadBlock < fromBlock) {
    LOG.info(`No new safe blocks to scan (fromBlock=${fromBlock}, safeHead=${safeHeadBlock}).`);
    return {
      fromBlock,
      toBlock: safeHeadBlock,
      safeHeadBlock,
      nextFromBlock: fromBlock
    };
  }

  // 2–3–4. Trust all newly completed backers (skipping blacklisted & already trusted).
  const completedBackingProcesses = await trustAllNewBackers(
    circlesRpc,
    blacklistingService,
    groupService,
    cfg.backersGroupAddress,
    cfg.backingFactoryAddress,
    fromBlock,
    safeHeadBlock,
    dryRun,
    LOG
  );

  // 5. Initiated-but-not-completed
  const pendingBackingProcesses = await findPendingBackingProcesses(
    circlesRpc,
    cfg.backingFactoryAddress,
    fromBlock,
    safeHeadBlock,
    completedBackingProcesses,
    LOG
  );

  const havePending = pendingBackingProcesses.length > 0;
  if (havePending) {
    LOG.info(`Found ${pendingBackingProcesses.length} pending backing processes since block ${fromBlock} to block ${safeHeadBlock}`);
    LOG.table(pendingBackingProcesses, ["blockNumber", "transactionHash", "backer", "circlesBackingInstance"]);
  }

  // 6. Reconcile overdue pending processes.
  const pendingProcessesToReconcile = pendingBackingProcesses.filter(event => {
    if (!event.timestamp) {
      throw new Error(`Event ${event.$event} at block ${event.blockNumber} has no timestamp.`);
    }
    return currentHead.timestamp - event.timestamp > cfg.expectedTimeTillCompletion;
  });

  const haveOverdue = pendingProcessesToReconcile.length > 0;
  if (haveOverdue) {
    LOG.info(`Found ${pendingProcessesToReconcile.length} pending processes older than ${cfg.expectedTimeTillCompletion}s.`);
    LOG.table(pendingProcessesToReconcile, ["blockNumber", "transactionHash", "backer", "circlesBackingInstance"]);
  }

  for (const event of pendingProcessesToReconcile) {
    if (!event.timestamp) {
      throw new Error(`Event ${event.$event} at block ${event.blockNumber} has no timestamp.`);
    }

    const deadline = computeOrderDeadlineSeconds(event);
    const pastDeadline = currentHead.timestamp >= deadline;

    if (pastDeadline) {
      const lbpState: CreateLBPResult = await cowSwapService.simulateCreateLbp(event.circlesBackingInstance);
      switch (lbpState) {
        case "Success": {
          if (dryRun) {
            LOG.info(`[DRY RUN] Would create LBP for ${event.backer} at ${event.circlesBackingInstance}.`);
          } else {
            LOG.info(`Creating LBP for ${event.backer} at ${event.circlesBackingInstance}...`);
            const txHash = await cowSwapService.createLbp(event.circlesBackingInstance);
            LOG.info(`Creating LBP for ${event.backer} at ${event.circlesBackingInstance} succeeded: ${txHash}`);
          }
          continue;
        }
        case "LBPAlreadyCreated": {
          continue;
        }
        case "OrderNotYetFilled": {
          const reason = `OrderNotYetFilled for ${event.circlesBackingInstance} after our deadline calc; will re-check later.`;
          LOG.info(reason);
          await slackService.notifyBackingNotCompleted(event, reason);
          break; // fall through to reset below
        }
        case "BackingAssetBalanceInsufficient": {
          const reason = "BackingAssetBalanceInsufficient - backing asset balance insufficient after filled order";
          LOG.info(`LBP create reported balance shortfall for ${event.circlesBackingInstance}; notifying Slack.`);
          await slackService.notifyBackingNotCompleted(event, reason);
          continue;
        }
        default:
          throw new Error(`Unknown LBP state ${lbpState}`);
      }
    }

    // Before-deadline path
    const orderState: ResetCowSwapOrderResult = await cowSwapService.simulateResetCowSwapOrder(event.circlesBackingInstance);
    switch (orderState) {
      case "OrderValid": {
        if (dryRun) {
          LOG.info(`[DRY RUN] Would reset order for ${event.backer} at ${event.circlesBackingInstance}.`);
        } else {
          LOG.info(`Resetting order for ${event.backer} at ${event.circlesBackingInstance}...`);
          const txHash = await cowSwapService.resetCowSwapOrder(event.circlesBackingInstance);
          LOG.info(`Resetting order for ${event.backer} at ${event.circlesBackingInstance} succeeded: ${txHash}`);
        }
        break;
      }
      case "OrderAlreadySettled": {
        const lbpState = await cowSwapService.simulateCreateLbp(event.circlesBackingInstance);
        if (lbpState === "Success") {
          if (dryRun) {
            LOG.info(`[DRY RUN] Would create LBP for ${event.circlesBackingInstance} after settled order.`);
          } else {
            LOG.info(`LBP posthook likely missed; creating LBP for ${event.circlesBackingInstance}...`);
            const txHash = await cowSwapService.createLbp(event.circlesBackingInstance);
            LOG.info(`LBP created for ${event.circlesBackingInstance}: ${txHash}`);
          }
          continue;
        }
        if (lbpState === "LBPAlreadyCreated") {
          continue;
        }
        if (lbpState === "BackingAssetBalanceInsufficient") {
          const text = `BackingAssetBalanceInsufficient after filled order for ${event.circlesBackingInstance}`;
          LOG.warn(text);
          await slackService.notifyBackingNotCompleted(event, text);
          continue;
        }
        if (lbpState === "OrderNotYetFilled") {
          const text = `OrderNotYetFilled inconsistency (settled vs not-filled) for ${event.circlesBackingInstance}; will re-check later.`;
          LOG.warn(text);
          await slackService.notifyBackingNotCompleted(event, text);
          continue;
        }
        throw new Error(`Unknown LBP state ${lbpState}`);
      }
      case "OrderUidIsTheSame": {
        break;
      }
      default:
        throw new Error(`Unknown order state ${orderState}`);
    }
  }

  await notifySlackTrustSummary(
    slackService,
    completedBackingProcesses,
    cfg,
    {fromBlock, toBlock: safeHeadBlock},
    dryRun,
    LOG
  );

  return {
    fromBlock,
    toBlock: safeHeadBlock,
    safeHeadBlock,
    nextFromBlock: safeHeadBlock + 1
  };
}
