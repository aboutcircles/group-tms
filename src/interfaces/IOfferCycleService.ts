import {TransactionSimulationResult} from "./ITransactionSimulation";

export type OfferTrustState = {
  /** Timestamp of the block every other field was read at. */
  blockTimestamp: bigint;
  /** `currentOfferId()` of the cycle; 0 before the first offer starts. */
  offerId: bigint;
  /** Last second of the current offer period: the expiry `syncOfferTrust()` writes. */
  offerEnd: bigint;
  /** First second of the next offer period (`offerEnd + 1`). */
  nextPeriodStart: bigint;
  /** `acceptedCRC[offerId]`: the avatars the cycle must trust for this offer. */
  acceptedCrc: string[];
  /** Hub trust expiry from the cycle to each entry of `acceptedCrc`, same order. */
  trustExpiries: bigint[];
};

export interface IOfferCycleService {
  readState(): Promise<OfferTrustState>;
  syncOfferTrust(): Promise<string>;
  simulateSyncOfferTrust?(): Promise<TransactionSimulationResult>;
}
