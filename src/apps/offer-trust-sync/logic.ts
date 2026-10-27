import {IOfferCycleService} from "../../interfaces/IOfferCycleService";
import {ILoggerService} from "../../interfaces/ILoggerService";

// CRC-GNO offer cycle used by the Gnosis app.
export const DEFAULT_OFFER_CYCLE_ADDRESS = "0x68e2C29fEED2A4D0F22Cc6d271e2b25124D99892";

export type Deps = {
  offerCycle: IOfferCycleService;
  logger: ILoggerService;
};

export type RunConfig = {
  dryRun: boolean;
};

export type RunOutcome = {
  offerId: bigint;
  acceptedCrcCount: number;
  /** Accepted CRC whose Hub trust expiry did not equal the offer end before this run. */
  outOfSync: string[];
  /** Set when this run sent `syncOfferTrust()`. */
  txHash?: string;
  /** Chain time of the last read and the first second of the next offer period, for scheduling the next run. */
  blockTimestamp: bigint;
  nextPeriodStart: bigint;
};

/**
 * Sends `syncOfferTrust()` when the cycle's Hub trust to the current offer's
 * accepted CRC does not end at the offer end. A period with no offer has no
 * accepted CRC, so nothing is sent.
 */
export async function runOnce(deps: Deps, config: RunConfig): Promise<RunOutcome> {
  const {offerCycle, logger} = deps;
  const state = await offerCycle.readState();
  const outOfSync = state.acceptedCrc.filter((_, i) => state.trustExpiries[i] !== state.offerEnd);
  const outcome: RunOutcome = {
    offerId: state.offerId,
    acceptedCrcCount: state.acceptedCrc.length,
    outOfSync,
    blockTimestamp: state.blockTimestamp,
    nextPeriodStart: state.nextPeriodStart
  };

  if (state.acceptedCrc.length === 0) {
    logger.debug(`Offer ${state.offerId} has no accepted CRC; nothing to sync.`);
    return outcome;
  }
  if (outOfSync.length === 0) {
    logger.debug(`Offer ${state.offerId}: trust to all ${state.acceptedCrc.length} accepted CRC ends at ${state.offerEnd}.`);
    return outcome;
  }

  logger.info(
    `Offer ${state.offerId}: trust to ${outOfSync.length} of ${state.acceptedCrc.length} accepted CRC ` +
    `does not end at ${state.offerEnd} (${outOfSync.join(", ")}).`
  );

  if (config.dryRun) {
    if (offerCycle.simulateSyncOfferTrust) {
      const simulation = await offerCycle.simulateSyncOfferTrust();
      logger.info(`Dry run: syncOfferTrust() simulated, gas estimate ${simulation.gasEstimate}.`);
    } else {
      logger.info("Dry run: would call syncOfferTrust().");
    }
    return outcome;
  }

  outcome.txHash = await offerCycle.syncOfferTrust();
  logger.info(`syncOfferTrust() sent for offer ${state.offerId}: ${outcome.txHash}`);

  const after = await offerCycle.readState();
  const stillOutOfSync = after.acceptedCrc.filter((_, i) => after.trustExpiries[i] !== after.offerEnd);
  if (after.offerId === state.offerId && stillOutOfSync.length > 0) {
    throw new Error(
      `syncOfferTrust() tx ${outcome.txHash} confirmed but trust to ${stillOutOfSync.join(", ")} ` +
      `still does not end at ${after.offerEnd}`
    );
  }

  return outcome;
}

/**
 * Delay before the next run: the poll interval, or less when a new offer period
 * starts sooner, so its trust is set within `boundaryMarginMs` of the start.
 * Measured in chain time, so a node that lags behind the wall clock does not
 * cause a run every `boundaryMarginMs`.
 */
export function computeNextDelayMs(
  chainNowSec: bigint,
  nextPeriodStartSec: bigint,
  pollIntervalMs: number,
  boundaryMarginMs: number
): number {
  const untilBoundaryMs = Number(nextPeriodStartSec - chainNowSec) * 1000;
  return Math.min(pollIntervalMs, Math.max(0, untilBoundaryMs) + boundaryMarginMs);
}
