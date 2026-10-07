import {FakeLogger} from "../../../fakes/fakes";
import {
  OldRegistrySource,
  REORG_DEPTH_BLOCKS,
  refreshUnionProtectedTrustees
} from "../../../src/apps/community-new/oldRegistrySource";
import {
  fetchAffiliateGroupChangedEventsBetween,
  fetchCurrentBlockNumber
} from "../../../src/apps/group-affiliates/realtime";

jest.mock("../../../src/apps/group-affiliates/realtime", () => ({
  ...jest.requireActual("../../../src/apps/group-affiliates/realtime"),
  fetchCurrentBlockNumber: jest.fn(),
  fetchAffiliateGroupChangedEventsBetween: jest.fn()
}));

const headMock = fetchCurrentBlockNumber as jest.MockedFunction<typeof fetchCurrentBlockNumber>;
const eventsMock = fetchAffiliateGroupChangedEventsBetween as jest.MockedFunction<
  typeof fetchAffiliateGroupChangedEventsBetween
>;

const REGISTRY = "0xca8222e780d046707083f51377b5fd85e2866014";
const START_BLOCK = 1000;
const ZERO = "0x0000000000000000000000000000000000000000";
// Checksummed on purpose: callers pass group addresses as configured.
const GROUP = "0xEEcAe593589a6eE4a12AE64F19420B47F3112Fa9";
const GROUP_LC = GROUP.toLowerCase();
const OTHER_GROUP = "0x1000000000000000000000000000000000000002";
const ALICE = "0x2000000000000000000000000000000000000001";
const BOB = "0x2000000000000000000000000000000000000002";
const GRANDFATHERED = "0x3000000000000000000000000000000000000001";

function event(blockNumber: number, human: string, oldGroup: string, newGroup: string) {
  return {
    blockNumber,
    txHash: `0x${blockNumber.toString(16)}`,
    human,
    oldGroup,
    newGroup,
    cursor: {blockNumber, logIndex: 0}
  } as any;
}

async function createSource(): Promise<OldRegistrySource> {
  return OldRegistrySource.create({
    chainRpcUrl: "http://rpc.invalid",
    registryAddress: REGISTRY,
    startBlock: START_BLOCK,
    logger: new FakeLogger(false),
    stateStore: null,
    enableWss: false
  });
}

beforeEach(() => {
  headMock.mockReset();
  eventsMock.mockReset();
});

describe("OldRegistrySource.refresh", () => {
  it("scans from the start block once, then only the blocks added since plus the reorg depth", async () => {
    const source = await createSource();

    headMock.mockResolvedValueOnce(5000);
    eventsMock.mockResolvedValueOnce([event(1200, ALICE, ZERO, GROUP_LC)]);
    await expect(source.refresh()).resolves.toBe(true);

    headMock.mockResolvedValueOnce(5100);
    eventsMock.mockResolvedValueOnce([event(5050, BOB, ZERO, GROUP_LC)]);
    await expect(source.refresh()).resolves.toBe(true);

    expect(eventsMock.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [START_BLOCK, 5000],
      [5001 - REORG_DEPTH_BLOCKS, 5100]
    ]);
    expect(source.getMembersByGroup([GROUP])).toEqual({[GROUP_LC]: new Set([ALICE, BOB])});
  });

  it("re-reads recent blocks, so an event a reorg moved into an already-scanned block is applied", async () => {
    const source = await createSource();
    // The first pass reads a fork without Alice's transaction.
    let chain = [event(1200, BOB, ZERO, GROUP_LC)];
    eventsMock.mockImplementation(async (_rpc, _registry, from, to) =>
      chain.filter((e) => e.blockNumber >= from && e.blockNumber <= to)
    );

    headMock.mockResolvedValueOnce(5000);
    await source.refresh();
    expect(source.getMembersByGroup([GROUP])).toEqual({[GROUP_LC]: new Set([BOB])});

    // The canonical chain now holds it in block 4998, below the saved cursor.
    chain = [...chain, event(4998, ALICE, ZERO, GROUP_LC)];
    headMock.mockResolvedValueOnce(5100);
    await source.refresh();
    expect(source.getMembersByGroup([GROUP])).toEqual({[GROUP_LC]: new Set([ALICE, BOB])});
  });

  it("replaying re-read events leaves the map as it was", async () => {
    const source = await createSource();
    const chain = [event(4995, ALICE, ZERO, GROUP_LC), event(4997, ALICE, GROUP_LC, OTHER_GROUP)];
    eventsMock.mockImplementation(async (_rpc, _registry, from, to) =>
      chain.filter((e) => e.blockNumber >= from && e.blockNumber <= to)
    );

    headMock.mockResolvedValueOnce(5000);
    await source.refresh();
    headMock.mockResolvedValueOnce(5003);
    await source.refresh();

    expect(source.getMembersByGroup([GROUP, OTHER_GROUP])).toEqual({
      [GROUP_LC]: new Set(),
      [OTHER_GROUP.toLowerCase()]: new Set([ALICE])
    });
  });

  it("does not fetch when no block was added", async () => {
    const source = await createSource();
    headMock.mockResolvedValueOnce(5000);
    eventsMock.mockResolvedValueOnce([]);
    await source.refresh();

    headMock.mockResolvedValueOnce(5000);
    await expect(source.refresh()).resolves.toBe(true);
    expect(eventsMock).toHaveBeenCalledTimes(1);
  });

  it("reports that it did not reach the head when the head block is unknown", async () => {
    const source = await createSource();
    headMock.mockResolvedValueOnce(null);
    await expect(source.refresh()).resolves.toBe(false);
    expect(eventsMock).not.toHaveBeenCalled();
  });
});

describe("refreshUnionProtectedTrustees", () => {
  it("returns current old-registry members plus grandfathered addresses, per group", async () => {
    const source = await createSource();
    headMock.mockResolvedValueOnce(5000);
    eventsMock.mockResolvedValueOnce([
      event(1200, ALICE, ZERO, GROUP_LC),
      event(1300, BOB, ZERO, GROUP_LC),
      event(1400, BOB, GROUP_LC, OTHER_GROUP)
    ]);

    const protectedByGroup = await refreshUnionProtectedTrustees(source, [GROUP], {
      [GROUP_LC]: new Set([GRANDFATHERED])
    });

    expect(protectedByGroup).toEqual({[GROUP_LC]: new Set([ALICE, GRANDFATHERED])});
  });

  it("throws instead of returning a stale list when the map could not reach the head", async () => {
    const source = await createSource();
    headMock.mockResolvedValueOnce(null);
    await expect(refreshUnionProtectedTrustees(source, [GROUP], {})).rejects.toThrow(/chain head/);
  });

  it("propagates a getLogs failure instead of protecting nobody", async () => {
    const source = await createSource();
    headMock.mockResolvedValueOnce(5000);
    eventsMock.mockRejectedValueOnce(new Error("getLogs failed"));
    await expect(refreshUnionProtectedTrustees(source, [GROUP], {})).rejects.toThrow("getLogs failed");
  });
});
