import {InMemoryRouterEnablementStore} from "../../../src/apps/router-tms/enablementStore";

describe("InMemoryRouterEnablementStore", () => {
  let originalDateNow: () => number;
  let fakeTime: number;

  beforeEach(() => {
    originalDateNow = Date.now;
    fakeTime = 1_000_000;
    Date.now = () => fakeTime;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it("stores and retrieves enabled addresses", async () => {
    const store = new InMemoryRouterEnablementStore();
    await store.markEnabled(["0x1000000000000000000000000000000000000001"]);

    const enabled = await store.loadEnabledAddresses();
    expect(enabled).toHaveLength(1);
  });

  it("initializes with addresses from constructor", async () => {
    const store = new InMemoryRouterEnablementStore([
      "0x1000000000000000000000000000000000000001",
      "0x1000000000000000000000000000000000000002"
    ]);

    const enabled = await store.loadEnabledAddresses();
    expect(enabled).toHaveLength(2);
  });

  it("stores and retrieves quarantined addresses", async () => {
    const store = new InMemoryRouterEnablementStore();
    await store.markQuarantined(["0x2000000000000000000000000000000000000001"]);

    const quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toBe("0x2000000000000000000000000000000000000001".toLowerCase());
  });

  it("evicts quarantined addresses after TTL expires", async () => {
    const store = new InMemoryRouterEnablementStore([], 50);
    await store.markQuarantined(["0x2000000000000000000000000000000000000002"]);

    // Immediately available
    let quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(1);

    // Advance past TTL
    fakeTime += 51;

    // Should be evicted
    quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(0);
  });

  it("does not evict quarantined addresses before TTL expires", async () => {
    const store = new InMemoryRouterEnablementStore([], 5000);
    await store.markQuarantined(["0x2000000000000000000000000000000000000003"]);

    fakeTime += 4999;
    const quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(1);
  });

  it("re-marking a quarantined address resets its TTL", async () => {
    const store = new InMemoryRouterEnablementStore([], 100);
    await store.markQuarantined(["0x2000000000000000000000000000000000000004"]);

    // Advance 60ms, then re-quarantine
    fakeTime += 60;
    await store.markQuarantined(["0x2000000000000000000000000000000000000004"]);

    // Advance another 60ms — original TTL would have expired, but re-mark extended it
    fakeTime += 60;

    const quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(1);
  });

  it("normalizes quarantined addresses via checksum then lowercase", async () => {
    const store = new InMemoryRouterEnablementStore();
    // Mixed case — should be normalized
    await store.markQuarantined(["0x2000000000000000000000000000000000000005"]);

    const quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined[0]).toBe("0x2000000000000000000000000000000000000005");
  });

  it("ignores invalid addresses in markQuarantined", async () => {
    const store = new InMemoryRouterEnablementStore();
    await store.markQuarantined(["not-an-address", "0x2000000000000000000000000000000000000006"]);

    const quarantined = await store.loadQuarantinedAddresses();
    expect(quarantined).toHaveLength(1);
  });

  it("keeps enabled and quarantined sets independent", async () => {
    const store = new InMemoryRouterEnablementStore();
    const addr = "0x2000000000000000000000000000000000000007";
    await store.markEnabled([addr]);
    await store.markQuarantined([addr]);

    const enabled = await store.loadEnabledAddresses();
    const quarantined = await store.loadQuarantinedAddresses();

    expect(enabled).toHaveLength(1);
    expect(quarantined).toHaveLength(1);
  });
});
