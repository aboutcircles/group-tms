import {getAddress} from "ethers";
import {
  DEFAULT_ROUTER2_ADDRESS,
  DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS,
  InMemoryRouter2ApprovalStore,
  runOnce,
  type Deps,
  type Router2ApprovalStore,
  type RunConfig
} from "../../../src/apps/router2/logic";
import {IRouter2Service} from "../../../src/interfaces/IRouter2Service";
import {TransactionSimulationResult} from "../../../src/interfaces/ITransactionSimulation";
import {FakeCirclesRpc, FakeLogger} from "../../../fakes/fakes";

class FakeRouter2Service implements IRouter2Service {
  enableCalls: string[][] = [];
  approvalCalls: string[][] = [];
  enableSimulations: string[][] = [];
  approvalSimulations: string[][] = [];

  async enableCRCForRouting(crcAddresses: string[]): Promise<string> {
    this.enableCalls.push([...crcAddresses]);
    return `0xenable_${this.enableCalls.length}`;
  }

  async setApprovalForCRC(crcAddresses: string[]): Promise<string> {
    this.approvalCalls.push([...crcAddresses]);
    return `0xapproval_${this.approvalCalls.length}`;
  }

  async simulateEnableCRCForRouting(crcAddresses: string[]): Promise<TransactionSimulationResult> {
    this.enableSimulations.push([...crcAddresses]);
    return {gasEstimate: BigInt(100_000 + this.enableSimulations.length)};
  }

  async simulateSetApprovalForCRC(crcAddresses: string[]): Promise<TransactionSimulationResult> {
    this.approvalSimulations.push([...crcAddresses]);
    return {gasEstimate: BigInt(200_000 + this.approvalSimulations.length)};
  }
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    routerAddress: DEFAULT_ROUTER2_ADDRESS,
    trustedByAddress: DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS,
    dryRun: false,
    batchSize: 2,
    ...overrides
  };
}

function makeDeps(
  circlesRpc: FakeCirclesRpc,
  router2Service?: IRouter2Service,
  gnosisAppRegisterHumanRows: string[] = [],
  approvalStore?: Router2ApprovalStore
): Deps {
  return {
    circlesRpc,
    logger: new FakeLogger(true),
    router2Service,
    approvalStore,
    fetchGnosisAppRegisterHumanAddresses: async () => [...gnosisAppRegisterHumanRows]
  };
}

function makeDepsWithBlockCapture(
  circlesRpc: FakeCirclesRpc,
  seenBlocks: Array<number | undefined>,
  router2Service?: IRouter2Service
): Deps {
  return {
    circlesRpc,
    logger: new FakeLogger(true),
    router2Service,
    fetchGnosisAppRegisterHumanAddresses: async (_indexerUrl, _pageSize, fromBlock) => {
      seenBlocks.push(fromBlock);
      return [];
    }
  };
}

describe("router2 logic", () => {
  it("approves addresses trusted by the configured truster and Gnosis App RegisterHuman users", async () => {
    const trustedA = getAddress("0x1000000000000000000000000000000000000001");
    const trustedB = getAddress("0x1000000000000000000000000000000000000002");
    const registerHumanA = getAddress("0x2000000000000000000000000000000000000001");
    const registerHumanB = getAddress("0x2000000000000000000000000000000000000002");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      trustedA,
      trustedB,
      trustedA
    ];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service, [registerHumanA, registerHumanB, trustedA]),
      makeConfig()
    );

    expect(outcome.totalTrustedRows).toBe(3);
    expect(outcome.uniqueTrustedCount).toBe(2);
    expect(outcome.totalGnosisAppRegisterHumanRows).toBe(3);
    expect(outcome.uniqueGnosisAppRegisterHumanCount).toBe(3);
    expect(outcome.totalApprovalRows).toBe(6);
    expect(outcome.uniqueApprovalCount).toBe(4);
    expect(outcome.approvalTxHashes).toEqual(["0xapproval_1", "0xapproval_2"]);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([
      [trustedA.toLowerCase(), trustedB.toLowerCase()],
      [registerHumanA.toLowerCase(), registerHumanB.toLowerCase()]
    ]);
  });

  it("simulates batches without executing in dry-run mode", async () => {
    const trustedA = getAddress("0x1000000000000000000000000000000000000011");
    const registerHumanA = getAddress("0x2000000000000000000000000000000000000011");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [trustedA];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service, [registerHumanA]),
      makeConfig({dryRun: true})
    );

    expect(outcome.approvalTxHashes).toEqual([]);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([]);
    expect(router2Service.enableSimulations).toEqual([]);
    expect(router2Service.approvalSimulations).toEqual([
      [trustedA.toLowerCase(), registerHumanA.toLowerCase()]
    ]);
  });

  it("approves trusted addresses without calling enableCRCForRouting", async () => {
    const alreadyEnabled = getAddress("0x1000000000000000000000000000000000000021");
    const missing = getAddress("0x1000000000000000000000000000000000000022");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      alreadyEnabled,
      missing
    ];
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_ADDRESS.toLowerCase()] = [
      alreadyEnabled
    ];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(makeDeps(circlesRpc, router2Service), makeConfig());

    expect(outcome.uniqueTrustedCount).toBe(2);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([
      [alreadyEnabled.toLowerCase(), missing.toLowerCase()]
    ]);
  });

  it("only uses RegisterHuman rows returned by the Gnosis App fetcher", async () => {
    const scoreGroupTrusted = getAddress("0x1000000000000000000000000000000000000031");
    const registerHuman = getAddress("0x2000000000000000000000000000000000000031");
    const unclaimed = getAddress("0x2000000000000000000000000000000000000032");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      scoreGroupTrusted
    ];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service, [registerHuman]),
      makeConfig()
    );

    expect(outcome.approvalCandidateCount).toBe(2);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([
      [scoreGroupTrusted.toLowerCase(), registerHuman.toLowerCase()]
    ]);
    expect(router2Service.approvalCalls.flat()).not.toContain(unclaimed.toLowerCase());
  });

  it("requires a router2 service outside dry-run mode", async () => {
    const circlesRpc = new FakeCirclesRpc();

    await expect(runOnce(makeDeps(circlesRpc), makeConfig({dryRun: false})))
      .rejects
      .toThrow("Router2 service dependency is required");
  });

  it("passes the configured Gnosis App from-block to the fetcher", async () => {
    const circlesRpc = new FakeCirclesRpc();
    const seenBlocks: Array<number | undefined> = [];
    const router2Service = new FakeRouter2Service();

    await runOnce(
      makeDepsWithBlockCapture(circlesRpc, seenBlocks, router2Service),
      makeConfig({gnosisAppFromBlock: 12345})
    );

    expect(seenBlocks).toEqual([12345]);
  });

  it("skips addresses already marked approved in the in-memory store", async () => {
    const cached = getAddress("0x1000000000000000000000000000000000000041");
    const uncached = getAddress("0x1000000000000000000000000000000000000042");
    const store = new InMemoryRouter2ApprovalStore();
    store.markApproved([cached]);

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      cached,
      uncached
    ];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service, [], store),
      makeConfig()
    );

    expect(outcome.uniqueApprovalCount).toBe(2);
    expect(outcome.cachedApprovalCount).toBe(1);
    expect(outcome.approvalCandidateCount).toBe(1);
    expect(router2Service.approvalCalls).toEqual([
      [uncached.toLowerCase()]
    ]);
    expect(store.isApproved(uncached)).toBe(true);
  });

  it("does not mark dry-run simulations as approved", async () => {
    const address = getAddress("0x1000000000000000000000000000000000000051");
    const store = new InMemoryRouter2ApprovalStore();

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [address];
    const router2Service = new FakeRouter2Service();

    await runOnce(
      makeDeps(circlesRpc, router2Service, [], store),
      makeConfig({dryRun: true})
    );

    expect(store.isApproved(address)).toBe(false);
    expect(router2Service.approvalSimulations).toEqual([[address.toLowerCase()]]);
  });

});
