import {Interface, getAddress, toBeHex, zeroPadValue} from "ethers";
import {createProvider} from "../../services/rpcProvider";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";

const REGISTER_HUMAN_ABI = [
  "event RegisterHuman(address indexed human, address indexed originInviter, address indexed proxyInviter)"
] as const;

const REGISTER_HUMAN_IFACE = new Interface(REGISTER_HUMAN_ABI);
const REGISTER_HUMAN_TOPIC0 = REGISTER_HUMAN_IFACE.getEvent("RegisterHuman")!.topicHash;

export const DEFAULT_CHUNK_SIZE = 2_000n;
export const DEFAULT_GROUP_BATCH_SIZE = 50;
export const DEFAULT_CONFIRMATION_BLOCKS = 10n;

export type RunConfig = {
  rpcUrl: string;
  invitationModuleAddress: string;
  targetGroupAddress: string;
  originInviters: string[];
  fromBlock: bigint;
  toBlock?: bigint;
  chunkSize?: bigint;
  groupBatchSize?: number;
  confirmationBlocks?: bigint;
  dryRun?: boolean;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  logger: ILoggerService;
  groupService?: IGroupService;
};

export type RunOutcome = {
  latestBlock: bigint;
  safeHeadBlock: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  scannedChunks: number;
  matchedEventCount: number;
  uniqueHumanCount: number;
  humansFromEvents: string[];
  alreadyTrustedHumans: string[];
  humansQueuedForTrust: string[];
  originInviterCounts: Record<string, number>;
  trustTxHashes: string[];
  dryRun: boolean;
  nextFromBlock: bigint;
};

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunOutcome> {
  const {circlesRpc, logger, groupService} = deps;

  const dryRun = !!cfg.dryRun;
  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when dublin-tms is not running in dry-run mode");
  }

  const invitationModuleAddress = cfg.invitationModuleAddress;
  const targetGroupAddress = cfg.targetGroupAddress;
  const originInviters = cfg.originInviters;
  if (originInviters.length === 0) {
    throw new Error("At least one origin inviter address is required");
  }

  if (cfg.fromBlock < 0n) {
    throw new Error(`fromBlock must be >= 0, received ${cfg.fromBlock}`);
  }

  const chunkSize = cfg.chunkSize && cfg.chunkSize > 0n ? cfg.chunkSize : DEFAULT_CHUNK_SIZE;
  const groupBatchSize = Math.max(1, cfg.groupBatchSize ?? DEFAULT_GROUP_BATCH_SIZE);
  const confirmationBlocks = cfg.confirmationBlocks && cfg.confirmationBlocks >= 0n
    ? cfg.confirmationBlocks
    : DEFAULT_CONFIRMATION_BLOCKS;

  const provider = createProvider(cfg.rpcUrl);
  const latestBlock = BigInt(await provider.getBlockNumber());
  const safeHeadBlock = latestBlock >= confirmationBlocks
    ? latestBlock - confirmationBlocks
    : 0n;

  const configuredToBlock = cfg.toBlock ?? safeHeadBlock;
  const toBlock = configuredToBlock > safeHeadBlock ? safeHeadBlock : configuredToBlock;

  if (cfg.fromBlock > toBlock) {
    logger.info(
      `No scan needed for this run: fromBlock=${cfg.fromBlock} toBlock=${toBlock} ` +
      `(latest=${latestBlock}, confirmations=${confirmationBlocks}).`
    );

    return {
      latestBlock,
      safeHeadBlock,
      fromBlock: cfg.fromBlock,
      toBlock,
      scannedChunks: 0,
      matchedEventCount: 0,
      uniqueHumanCount: 0,
      humansFromEvents: [],
      alreadyTrustedHumans: [],
      humansQueuedForTrust: [],
      originInviterCounts: {},
      trustTxHashes: [],
      dryRun,
      nextFromBlock: cfg.fromBlock
    };
  }

  const currentTrustees = uniqueNormalizedAddresses(await circlesRpc.fetchAllTrustees(targetGroupAddress));
  const currentTrusteesLowerSet = new Set(currentTrustees.map((address) => address.toLowerCase()));

  const inviterTopics = originInviters.map((inviter) => zeroPadValue(inviter, 32).toLowerCase());

  const humansSet = new Set<string>();
  const originInviterCounts = new Map<string, number>();
  let matchedEventCount = 0;
  let scannedChunks = 0;

  let from = cfg.fromBlock;
  while (from <= toBlock) {
    const end = from + chunkSize - 1n <= toBlock ? from + chunkSize - 1n : toBlock;
    scannedChunks += 1;

    const logs = await provider.getLogs({
      address: invitationModuleAddress,
      fromBlock: toBeHex(from),
      toBlock: toBeHex(end),
      topics: [REGISTER_HUMAN_TOPIC0, null, inviterTopics]
    });

    for (const log of logs) {
      let parsed;
      try {
        parsed = REGISTER_HUMAN_IFACE.parseLog({
          topics: Array.from(log.topics),
          data: log.data
        });
      } catch {
        logger.warn(`Failed to parse RegisterHuman log at block ${log.blockNumber}; skipping.`);
        continue;
      }

      if (!parsed || parsed.name !== "RegisterHuman") {
        continue;
      }

      const human = normalizeAddress(String(parsed.args[0]));
      const originInviter = normalizeAddress(String(parsed.args[1]));

      if (!human || !originInviter) {
        logger.warn(`Skipping RegisterHuman log with invalid addresses at block ${log.blockNumber}.`);
        continue;
      }

      matchedEventCount += 1;
      humansSet.add(human);
      originInviterCounts.set(originInviter, (originInviterCounts.get(originInviter) ?? 0) + 1);

      logger.debug(
        `RegisterHuman match: human=${human} originInviter=${originInviter} ` +
        `block=${log.blockNumber} tx=${shortHex(log.transactionHash)}`
      );
    }

    from = end + 1n;
  }

  const humansFromEvents = Array.from(humansSet);
  const alreadyTrustedHumans = humansFromEvents.filter((human) => currentTrusteesLowerSet.has(human.toLowerCase()));
  const humansQueuedForTrust = humansFromEvents.filter((human) => !currentTrusteesLowerSet.has(human.toLowerCase()));

  const trustTxHashes: string[] = [];

  if (humansQueuedForTrust.length === 0) {
    logger.info("No new humans to trust for this run.");
  } else if (dryRun || !groupService) {
    const batches = chunkArray(humansQueuedForTrust, groupBatchSize);
    logger.info(
      `Dry-run mode enabled; would trust ${humansQueuedForTrust.length} human avatar(s) in ` +
      `${batches.length} batch(es) for group ${targetGroupAddress}.`
    );
    batches.forEach((batch, index) => {
      logger.info(
        `DRY RUN trust batch ${index + 1}/${batches.length}: ${batch.length} avatar(s) -> ${batch.join(", ")}`
      );
    });
  } else {
    const batches = chunkArray(humansQueuedForTrust, groupBatchSize);
    logger.info(
      `Trusting ${humansQueuedForTrust.length} human avatar(s) in ${batches.length} batch(es) ` +
      `for group ${targetGroupAddress}.`
    );

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      logger.info(`Trusting batch ${index + 1}/${batches.length} (${batch.length} avatar(s))...`);
      const txHash = await groupService.trustBatchWithConditions(targetGroupAddress, batch);
      trustTxHashes.push(txHash);
      logger.info(`Trust tx: ${txHash}`);
    }
  }

  const inviterCountsObject: Record<string, number> = {};
  for (const [inviter, count] of originInviterCounts.entries()) {
    inviterCountsObject[inviter] = count;
  }

  return {
    latestBlock,
    safeHeadBlock,
    fromBlock: cfg.fromBlock,
    toBlock,
    scannedChunks,
    matchedEventCount,
    uniqueHumanCount: humansFromEvents.length,
    humansFromEvents,
    alreadyTrustedHumans,
    humansQueuedForTrust,
    originInviterCounts: inviterCountsObject,
    trustTxHashes,
    dryRun,
    nextFromBlock: toBlock + 1n
  };
}

function normalizeAddress(value: string | undefined | null): string | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function uniqueNormalizedAddresses(addresses: string[]): string[] {
  const unique = new Map<string, string>();

  for (const value of addresses) {
    const normalized = normalizeAddress(value);
    if (!normalized) {
      continue;
    }

    const lower = normalized.toLowerCase();
    if (!unique.has(lower)) {
      unique.set(lower, normalized);
    }
  }

  return Array.from(unique.values());
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function shortHex(value: string): string {
  if (value.length <= 20) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
