import { getAddress } from "ethers";
import { ICirclesRpc } from "../../interfaces/ICirclesRpc";
import { ILoggerService } from "../../interfaces/ILoggerService";
import { IRouter2Service } from "../../interfaces/IRouter2Service";
import {
  DEFAULT_GNOSIS_APP_FETCH_PAGE_SIZE,
  DEFAULT_GNOSIS_APP_FETCH_TIMEOUT_MS,
  DEFAULT_GNOSIS_APP_INDEXER_URL
} from "../../services/gnosisAppUserService";

export const DEFAULT_ROUTER2_ADDRESS = "0xE171a76De6B645A28b3767f84B177a4f6659a3D7";
export const DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS = "0x93eD5A96347927ff6fF6b790F8Cf5258240c321f";
export const DEFAULT_ROUTER2_BATCH_SIZE = 20;
export const DEFAULT_ROUTER2_GNOSIS_APP_INDEXER_URL = DEFAULT_GNOSIS_APP_INDEXER_URL;
export const DEFAULT_ROUTER2_FETCH_PAGE_SIZE = DEFAULT_GNOSIS_APP_FETCH_PAGE_SIZE;
export const DEFAULT_ROUTER2_FETCH_TIMEOUT_MS = DEFAULT_GNOSIS_APP_FETCH_TIMEOUT_MS;

export type GnosisAppRegisterHumanFetcher = (
  indexerUrl: string,
  pageSize: number,
  fromBlock: number | undefined,
  logger: ILoggerService
) => Promise<string[]>;

export type RunConfig = {
  routerAddress: string;
  trustedByAddress: string;
  gnosisAppIndexerUrl?: string;
  gnosisAppFromBlock?: number;
  dryRun?: boolean;
  batchSize?: number;
  fetchPageSize?: number;
  logBatchAddresses?: boolean;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  logger: ILoggerService;
  router2Service?: IRouter2Service;
  fetchGnosisAppRegisterHumanAddresses: GnosisAppRegisterHumanFetcher;
  approvalStore?: Router2ApprovalStore;
};

export type Router2RunOutcome = {
  totalTrustedRows: number;
  uniqueTrustedCount: number;
  totalGnosisAppRegisterHumanRows: number;
  uniqueGnosisAppRegisterHumanCount: number;
  totalApprovalRows: number;
  uniqueApprovalCount: number;
  cachedApprovalCount: number;
  approvalCandidateCount: number;
  approvalTxHashes: string[];
  dryRun: boolean;
};

export interface Router2ApprovalStore {
  isApproved(address: string): boolean;
  markApproved(addresses: string[]): void;
  count(): number;
}

export class InMemoryRouter2ApprovalStore implements Router2ApprovalStore {
  private readonly approved = new Set<string>();

  isApproved(address: string): boolean {
    const normalized = normalizeAddress(address);
    return normalized !== undefined && this.approved.has(normalized);
  }

  markApproved(addresses: string[]): void {
    for (const address of addresses) {
      const normalized = normalizeAddress(address);
      if (normalized) {
        this.approved.add(normalized);
      }
    }
  }

  count(): number {
    return this.approved.size;
  }
}

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<Router2RunOutcome> {
  const routerAddress = normalizeAddress(cfg.routerAddress);
  if (!routerAddress) {
    throw new Error(`Invalid router2 address configured: '${cfg.routerAddress}'`);
  }

  const trustedByAddress = normalizeAddress(cfg.trustedByAddress);
  if (!trustedByAddress) {
    throw new Error(`Invalid router2 trusted-by address configured: '${cfg.trustedByAddress}'`);
  }

  deps.logger.info(`Fetching trustees trusted by ${trustedByAddress}...`);
  const trustedRows = await deps.circlesRpc.fetchAllTrustees(trustedByAddress);
  deps.logger.info(`Fetched ${trustedRows.length} trustee row(s).`);

  const indexerUrl = cfg.gnosisAppIndexerUrl ?? DEFAULT_ROUTER2_GNOSIS_APP_INDEXER_URL;
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_ROUTER2_FETCH_PAGE_SIZE);
  const fromBlock = validateOptionalBlock(cfg.gnosisAppFromBlock, "router2 Gnosis App from-block");
  deps.logger.info(
    `Fetching Gnosis App RegisterHuman users from ${indexerUrl}` +
    `${fromBlock === undefined ? "" : ` after block ${fromBlock}`}...`
  );
  const gnosisAppRegisterHumanRows = await deps.fetchGnosisAppRegisterHumanAddresses(
    indexerUrl,
    fetchPageSize,
    fromBlock,
    deps.logger.child("gnosis-app-users")
  );
  deps.logger.info(`Fetched ${gnosisAppRegisterHumanRows.length} Gnosis App RegisterHuman row(s).`);

  return executeRouter2Plan(deps, cfg, trustedRows, gnosisAppRegisterHumanRows);
}

async function executeRouter2Plan(
  deps: Deps,
  cfg: RunConfig,
  trustedRows: string[],
  gnosisAppRegisterHumanRows: string[]
): Promise<Router2RunOutcome> {
  const { logger, router2Service } = deps;
  const dryRun = !!cfg.dryRun;

  const routerAddress = normalizeAddress(cfg.routerAddress);
  if (!routerAddress) {
    throw new Error(`Invalid router2 address configured: '${cfg.routerAddress}'`);
  }

  const trustedByAddress = normalizeAddress(cfg.trustedByAddress);
  if (!trustedByAddress) {
    throw new Error(`Invalid router2 trusted-by address configured: '${cfg.trustedByAddress}'`);
  }

  if (!dryRun && !router2Service) {
    throw new Error("Router2 service dependency is required when router2 is not running in dry-run mode.");
  }

  const batchSize = Math.max(1, cfg.batchSize ?? DEFAULT_ROUTER2_BATCH_SIZE);
  const trustedCandidates = uniqueNormalizedAddresses(trustedRows, logger);
  const gnosisAppRegisterHumanCandidates = uniqueNormalizedAddresses(gnosisAppRegisterHumanRows, logger);
  const approvalCandidates = uniqueNormalizedAddresses([
    ...trustedCandidates,
    ...gnosisAppRegisterHumanCandidates
  ], logger);
  const cachedApprovalCount = deps.approvalStore
    ? approvalCandidates.filter((address) => deps.approvalStore!.isApproved(address)).length
    : 0;
  const approvalCandidatesToProcess = deps.approvalStore
    ? approvalCandidates.filter((address) => !deps.approvalStore!.isApproved(address))
    : approvalCandidates;

  logger.info(
    `router2 plan: approval=${approvalCandidatesToProcess.length}/${approvalCandidates.length} address(es) to process ` +
    `(${trustedCandidates.length} trusted, ${gnosisAppRegisterHumanCandidates.length} Gnosis App RegisterHuman), ` +
    `cached=${cachedApprovalCount}, ` +
    `batchSize=${batchSize}, dryRun=${dryRun}.`
  );

  const approvalTxHashes = await executeBatches({
    label: "setApprovalForCRC",
    addresses: approvalCandidatesToProcess,
    batchSize,
    dryRun,
    logBatchAddresses: !!cfg.logBatchAddresses,
    logger,
    execute: (batch) => router2Service!.setApprovalForCRC(batch),
    simulate: router2Service?.simulateSetApprovalForCRC
      ? (batch) => router2Service.simulateSetApprovalForCRC!(batch)
      : undefined,
    onBatchSuccess: deps.approvalStore
      ? (batch) => deps.approvalStore!.markApproved(batch)
      : undefined
  });

  return {
    totalTrustedRows: trustedRows.length,
    uniqueTrustedCount: trustedCandidates.length,
    totalGnosisAppRegisterHumanRows: gnosisAppRegisterHumanRows.length,
    uniqueGnosisAppRegisterHumanCount: gnosisAppRegisterHumanCandidates.length,
    totalApprovalRows: trustedRows.length + gnosisAppRegisterHumanRows.length,
    uniqueApprovalCount: approvalCandidates.length,
    cachedApprovalCount,
    approvalCandidateCount: approvalCandidatesToProcess.length,
    approvalTxHashes,
    dryRun
  };
}

type ExecuteBatchesArgs = {
  label: string;
  addresses: string[];
  batchSize: number;
  dryRun: boolean;
  logBatchAddresses: boolean;
  logger: ILoggerService;
  execute: (batch: string[]) => Promise<string>;
  simulate?: (batch: string[]) => Promise<{ gasEstimate: bigint }>;
  onBatchSuccess?: (batch: string[]) => void;
};

async function executeBatches(args: ExecuteBatchesArgs): Promise<string[]> {
  const { label, addresses, batchSize, dryRun, logBatchAddresses, logger, execute, simulate, onBatchSuccess } = args;
  const batches = chunkArray(addresses, batchSize);
  const txHashes: string[] = [];

  if (addresses.length === 0) {
    logger.info(`router2 ${label}: no addresses to process.`);
    return txHashes;
  }

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchLabel = `${index + 1}/${batches.length}`;

    if (dryRun) {
      logger.info(
        `[DRY-RUN] router2 ${label} batch ${batchLabel}: ` +
        formatBatchAddresses(batch, logBatchAddresses)
      );
      if (simulate) {
        const simulation = await simulate(batch);
        logger.info(
          `[DRY-RUN] router2 ${label} simulation ${batchLabel}: ` +
          `ok, gasEstimate=${simulation.gasEstimate.toString()}.`
        );
      } else {
        logger.info(`[DRY-RUN] router2 ${label} simulation ${batchLabel}: skipped (no signer-backed simulator configured).`);
      }
      continue;
    }

    logger.info(`router2 ${label} batch ${batchLabel}: processing ${batch.length} address(es).`);
    const txHash = await execute(batch);
    txHashes.push(txHash);
    onBatchSuccess?.(batch);
    logger.info(`router2 ${label} tx=${txHash} batch ${batchLabel}.`);
  }

  return txHashes;
}

function formatBatchAddresses(batch: string[], includeAddresses: boolean): string {
  if (includeAddresses) {
    return `${batch.length} address(es) -> ${batch.join(", ")}.`;
  }

  const first = batch[0];
  const last = batch[batch.length - 1];
  if (!first || !last) {
    return "0 address(es).";
  }

  return `${batch.length} address(es) (${first} ... ${last}).`;
}

function uniqueNormalizedAddresses(addresses: string[], logger: ILoggerService): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  if (skipped > 0) {
    logger.warn(`Skipped ${skipped} invalid router2 address(es).`);
  }

  return result;
}

function normalizeAddress(address: string | undefined | null): string | undefined {
  if (!address) {
    return undefined;
  }

  try {
    return getAddress(address).toLowerCase();
  } catch {
    return undefined;
  }
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function validateOptionalBlock(blockNumber: number | undefined, label: string): number | undefined {
  if (blockNumber === undefined) {
    return undefined;
  }

  if (!Number.isInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`Invalid ${label} configured: '${blockNumber}'`);
  }

  return blockNumber;
}

export const __testables = {
  chunkArray,
  formatBatchAddresses,
  normalizeAddress,
  validateOptionalBlock,
  uniqueNormalizedAddresses
};
