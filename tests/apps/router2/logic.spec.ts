import {getAddress} from "ethers";
import {
  DEFAULT_ROUTER2_ADDRESS,
  DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS,
  runApprovalsForHumanAvatars,
  runOnce,
  type Deps,
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
    fetchPageSize: 10,
    ...overrides
  };
}

function makeDeps(circlesRpc: FakeCirclesRpc, router2Service?: IRouter2Service): Deps {
  return {
    circlesRpc,
    logger: new FakeLogger(true),
    router2Service
  };
}

describe("router2 logic", () => {
  it("enables routing for trusted addresses and approvals for human avatars", async () => {
    const trustedA = getAddress("0x1000000000000000000000000000000000000001");
    const trustedB = getAddress("0x1000000000000000000000000000000000000002");
    const humanA = getAddress("0x2000000000000000000000000000000000000001");
    const humanB = getAddress("0x2000000000000000000000000000000000000002");
    const humanC = getAddress("0x2000000000000000000000000000000000000003");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      trustedA,
      trustedB,
      trustedA
    ];
    circlesRpc.humanAvatars = [humanA, humanB, humanC, humanA];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(makeDeps(circlesRpc, router2Service), makeConfig());

    expect(outcome.totalTrustedRows).toBe(3);
    expect(outcome.uniqueTrustedCount).toBe(2);
    expect(outcome.totalHumanRows).toBe(4);
    expect(outcome.uniqueHumanCount).toBe(3);
    expect(outcome.routingTxHashes).toEqual(["0xenable_1"]);
    expect(outcome.approvalTxHashes).toEqual(["0xapproval_1", "0xapproval_2"]);
    expect(router2Service.enableCalls).toEqual([
      [trustedA.toLowerCase(), trustedB.toLowerCase()]
    ]);
    expect(router2Service.approvalCalls).toEqual([
      [humanA.toLowerCase(), humanB.toLowerCase()],
      [humanC.toLowerCase()]
    ]);
  });

  it("simulates batches without executing in dry-run mode", async () => {
    const trustedA = getAddress("0x1000000000000000000000000000000000000011");
    const humanA = getAddress("0x2000000000000000000000000000000000000011");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [trustedA];
    circlesRpc.humanAvatars = [humanA];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service),
      makeConfig({dryRun: true})
    );

    expect(outcome.routingTxHashes).toEqual([]);
    expect(outcome.approvalTxHashes).toEqual([]);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([]);
    expect(router2Service.enableSimulations).toEqual([[trustedA.toLowerCase()]]);
    expect(router2Service.approvalSimulations).toEqual([
      [humanA.toLowerCase()]
    ]);
  });

  it("skips enableCRCForRouting for addresses already trusted by router2", async () => {
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
    expect(outcome.routingCandidateCount).toBe(1);
    expect(router2Service.enableCalls).toEqual([
      [missing.toLowerCase()]
    ]);
  });

  it("only enables routing for addresses trusted by the configured score group", async () => {
    const scoreGroupTrusted = getAddress("0x1000000000000000000000000000000000000031");
    const humanOnlyAvatar = getAddress("0x2000000000000000000000000000000000000031");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[DEFAULT_ROUTER2_TRUSTED_BY_ADDRESS.toLowerCase()] = [
      scoreGroupTrusted
    ];
    circlesRpc.humanAvatars = [humanOnlyAvatar];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(makeDeps(circlesRpc, router2Service), makeConfig());

    expect(outcome.routingCandidateCount).toBe(1);
    expect(outcome.approvalCandidateCount).toBe(1);
    expect(router2Service.enableCalls).toEqual([
      [scoreGroupTrusted.toLowerCase()]
    ]);
    expect(router2Service.approvalCalls).toEqual([
      [humanOnlyAvatar.toLowerCase()]
    ]);
  });

  it("limits scheduled approvals to avatars registered after the configured block", async () => {
    const oldHuman = getAddress("0x2000000000000000000000000000000000000041");
    const newHuman = getAddress("0x2000000000000000000000000000000000000042");
    const approvalsFromBlock = 12345;

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.humanAvatars = [oldHuman, newHuman];
    circlesRpc.humanAvatarsAfterBlock[approvalsFromBlock] = [newHuman];
    const router2Service = new FakeRouter2Service();

    const outcome = await runOnce(
      makeDeps(circlesRpc, router2Service),
      makeConfig({approvalsFromBlock})
    );

    expect(circlesRpc.requestedHumanAvatarsAfterBlock).toBe(approvalsFromBlock);
    expect(outcome.totalHumanRows).toBe(1);
    expect(outcome.approvalCandidateCount).toBe(1);
    expect(router2Service.approvalCalls).toEqual([
      [newHuman.toLowerCase()]
    ]);
  });

  it("requires a router2 service outside dry-run mode", async () => {
    const circlesRpc = new FakeCirclesRpc();

    await expect(runOnce(makeDeps(circlesRpc), makeConfig({dryRun: false})))
      .rejects
      .toThrow("Router2 service dependency is required");
  });

  it("can approve realtime human avatars without routing", async () => {
    const humanA = getAddress("0x2000000000000000000000000000000000000021");
    const humanB = getAddress("0x2000000000000000000000000000000000000022");

    const circlesRpc = new FakeCirclesRpc();
    const router2Service = new FakeRouter2Service();

    const outcome = await runApprovalsForHumanAvatars(
      makeDeps(circlesRpc, router2Service),
      makeConfig(),
      [humanA, humanB]
    );

    expect(outcome.routingCandidateCount).toBe(0);
    expect(outcome.approvalCandidateCount).toBe(2);
    expect(router2Service.enableCalls).toEqual([]);
    expect(router2Service.approvalCalls).toEqual([
      [humanA.toLowerCase(), humanB.toLowerCase()]
    ]);
  });
});
