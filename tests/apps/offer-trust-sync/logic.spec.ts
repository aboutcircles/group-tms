import {computeNextDelayMs, runOnce, type RunConfig} from "../../../src/apps/offer-trust-sync/logic";
import {IOfferCycleService, OfferTrustState} from "../../../src/interfaces/IOfferCycleService";
import {TransactionSimulationResult} from "../../../src/interfaces/ITransactionSimulation";
import {FakeLogger} from "../../../fakes/fakes";

const CRC_A = "0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c";
const CRC_B = "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const OFFER_END = 1_793_305_799n;

function makeState(overrides?: Partial<OfferTrustState>): OfferTrustState {
  return {
    blockTimestamp: OFFER_END - 3_600n,
    offerId: 47n,
    offerEnd: OFFER_END,
    nextPeriodStart: OFFER_END + 1n,
    acceptedCrc: [],
    trustExpiries: [],
    ...overrides
  };
}

class FakeOfferCycleService implements IOfferCycleService {
  readCalls = 0;
  syncCalls = 0;
  simulateCalls = 0;

  // readState returns the states in order and repeats the last one.
  constructor(private readonly states: OfferTrustState[], private readonly withSimulation = true) {
    if (!withSimulation) {
      this.simulateSyncOfferTrust = undefined;
    }
  }

  async readState(): Promise<OfferTrustState> {
    const state = this.states[Math.min(this.readCalls, this.states.length - 1)];
    this.readCalls++;
    return state;
  }

  async syncOfferTrust(): Promise<string> {
    this.syncCalls++;
    return `0xsync_${this.syncCalls}`;
  }

  simulateSyncOfferTrust?: () => Promise<TransactionSimulationResult> = async () => {
    this.simulateCalls++;
    return {gasEstimate: 80_000n};
  };
}

const wet: RunConfig = {dryRun: false};
const dry: RunConfig = {dryRun: true};

describe("offer-trust-sync runOnce", () => {
  it("sends nothing when the current period has no offer", async () => {
    const cycle = new FakeOfferCycleService([makeState()]);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet);

    expect(cycle.syncCalls).toBe(0);
    expect(outcome.acceptedCrcCount).toBe(0);
    expect(outcome.outOfSync).toEqual([]);
    expect(outcome.txHash).toBeUndefined();
  });

  it("sends nothing when every accepted CRC is trusted until the offer end", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A, CRC_B], trustExpiries: [OFFER_END, OFFER_END]})
    ]);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet);

    expect(cycle.syncCalls).toBe(0);
    expect(outcome.acceptedCrcCount).toBe(2);
    expect(outcome.outOfSync).toEqual([]);
  });

  it("calls syncOfferTrust once when trust still ends at the previous offer end", async () => {
    const previousEnd = OFFER_END - 604_800n;
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A, CRC_B], trustExpiries: [previousEnd, OFFER_END]}),
      makeState({acceptedCrc: [CRC_A, CRC_B], trustExpiries: [OFFER_END, OFFER_END]})
    ]);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet);

    expect(cycle.syncCalls).toBe(1);
    expect(outcome.outOfSync).toEqual([CRC_A]);
    expect(outcome.txHash).toBe("0xsync_1");
    expect(outcome.nextPeriodStart).toBe(OFFER_END + 1n);
  });

  it("treats an untrusted accepted CRC (expiry 0) as out of sync", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A], trustExpiries: [0n]}),
      makeState({acceptedCrc: [CRC_A], trustExpiries: [OFFER_END]})
    ]);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet);

    expect(cycle.syncCalls).toBe(1);
    expect(outcome.outOfSync).toEqual([CRC_A]);
  });

  it("fails the run when trust is still out of sync after the tx", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A], trustExpiries: [0n]})
    ]);

    await expect(runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet))
      .rejects.toThrow(/0xsync_1 confirmed but trust to .* still does not end at/);
    expect(cycle.syncCalls).toBe(1);
  });

  it("does not fail when the offer period rolled over between the tx and the re-read", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A], trustExpiries: [0n]}),
      makeState({
        offerId: 48n,
        offerEnd: OFFER_END + 604_800n,
        nextPeriodStart: OFFER_END + 604_801n,
        acceptedCrc: [CRC_A],
        trustExpiries: [OFFER_END]
      })
    ]);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, wet);

    expect(outcome.txHash).toBe("0xsync_1");
  });

  it("simulates and sends nothing in dry run", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A], trustExpiries: [0n]})
    ]);
    const logger = new FakeLogger();

    const outcome = await runOnce({offerCycle: cycle, logger}, dry);

    expect(cycle.syncCalls).toBe(0);
    expect(cycle.simulateCalls).toBe(1);
    expect(outcome.txHash).toBeUndefined();
    expect(logger.logs.some((l) => String(l.args[0]).includes("gas estimate 80000"))).toBe(true);
  });

  it("sends nothing in dry run without a signer to simulate with", async () => {
    const cycle = new FakeOfferCycleService([
      makeState({acceptedCrc: [CRC_A], trustExpiries: [0n]})
    ], false);

    const outcome = await runOnce({offerCycle: cycle, logger: new FakeLogger()}, dry);

    expect(cycle.syncCalls).toBe(0);
    expect(outcome.outOfSync).toEqual([CRC_A]);
  });
});

describe("offer-trust-sync computeNextDelayMs", () => {
  const poll = 300_000;
  const margin = 30_000;

  it("waits the poll interval when the next period starts later", () => {
    expect(computeNextDelayMs(OFFER_END - 3_600n, OFFER_END + 1n, poll, margin)).toBe(poll);
  });

  it("runs just after the period start when it comes before the next poll", () => {
    expect(computeNextDelayMs(OFFER_END + 1n - 60n, OFFER_END + 1n, poll, margin)).toBe(60_000 + margin);
  });

  it("waits only the margin when the period start has passed but the offer id has not moved", () => {
    expect(computeNextDelayMs(OFFER_END + 1n, OFFER_END + 1n, poll, margin)).toBe(margin);
  });
});
