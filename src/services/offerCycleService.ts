import {AbiCoder, Contract, FallbackProvider, getAddress, Interface, JsonRpcProvider, keccak256} from "ethers";
import {IOfferCycleService, OfferTrustState} from "../interfaces/IOfferCycleService";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import {EoaTransactionExecutor} from "./eoaTransactionExecutor";
import {createProvider} from "./rpcProvider";

export const CIRCLES_HUB_V2_ADDRESS = "0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8";

const OFFER_CYCLE_ABI = [
  "function currentOfferId() view returns (uint256)",
  "function OFFERS_START() view returns (uint256)",
  "function OFFER_DURATION() view returns (uint256)",
  "function acceptedCRC(uint256 offerId, uint256 index) view returns (address)",
  "function syncOfferTrust()"
] as const;

const HUB_ABI = [
  "function trustMarkers(address truster, address trustee) view returns (address previous, uint96 expiry)"
] as const;

const OFFER_CYCLE_INTERFACE = new Interface(OFFER_CYCLE_ABI);
const SYNC_OFFER_TRUST_DATA = OFFER_CYCLE_INTERFACE.encodeFunctionData("syncOfferTrust", []);

// acceptedCRC has no length getter, so the length is read from storage.
// ERC20TokenOfferCycle storage: slot 0 offerOrgName, slot 1 offers,
// slot 2 acceptedCRC (constants and immutables take no slot). A dynamic array
// in a mapping keeps its length at keccak256(abi.encode(key, slot)).
// The getter's out-of-range revert is not used as the end marker: it carries no
// data, and neither does the error a node returns when it lacks the state.
const ACCEPTED_CRC_SLOT = 2n;
const MAX_ACCEPTED_CRC = 256n;

export class OfferCycleService implements IOfferCycleService {
  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly cycleAddress: string;
  private readonly cycle: Contract;
  private readonly hub: Contract;
  private readonly executor?: EoaTransactionExecutor;
  private schedule?: {start: bigint; duration: bigint};

  constructor(rpcUrl: string, cycleAddress: string, signerPrivateKey?: string, txRpcUrl: string = rpcUrl) {
    this.provider = createProvider(rpcUrl);
    this.cycleAddress = getAddress(cycleAddress);
    this.cycle = new Contract(this.cycleAddress, OFFER_CYCLE_ABI, this.provider);
    this.hub = new Contract(CIRCLES_HUB_V2_ADDRESS, HUB_ABI, this.provider);
    if (signerPrivateKey && signerPrivateKey.trim().length > 0) {
      this.executor = new EoaTransactionExecutor(txRpcUrl, signerPrivateKey);
    }
  }

  getSignerAddress(): string | undefined {
    return this.executor?.getSignerAddress();
  }

  async readState(): Promise<OfferTrustState> {
    // Every read is pinned to one block so the offer id, its CRC list and the
    // Hub trust markers describe the same moment.
    const block = await this.provider.getBlock("latest");
    if (!block) {
      throw new Error("RPC returned no latest block");
    }
    const blockTag = block.number;
    const {start, duration} = await this.readSchedule();
    const offerId: bigint = await this.cycle.currentOfferId({blockTag});
    const nextPeriodStart = start + duration * offerId;

    const lengthSlot = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [offerId, ACCEPTED_CRC_SLOT]));
    const length = BigInt(await this.provider.getStorage(this.cycleAddress, lengthSlot, blockTag));
    if (length > MAX_ACCEPTED_CRC) {
      throw new Error(`acceptedCRC(${offerId}) length ${length} exceeds ${MAX_ACCEPTED_CRC}; wrong storage slot?`);
    }

    const acceptedCrc: string[] = [];
    for (let index = 0n; index < length; index++) {
      acceptedCrc.push(getAddress(await this.cycle.acceptedCRC(offerId, index, {blockTag})));
    }

    const trustExpiries: bigint[] = [];
    for (const crc of acceptedCrc) {
      const marker = await this.hub.trustMarkers(this.cycleAddress, crc, {blockTag});
      trustExpiries.push(BigInt(marker.expiry));
    }

    return {
      blockTimestamp: BigInt(block.timestamp),
      offerId,
      offerEnd: nextPeriodStart - 1n,
      nextPeriodStart,
      acceptedCrc,
      trustExpiries
    };
  }

  async syncOfferTrust(): Promise<string> {
    if (!this.executor) {
      throw new Error("syncOfferTrust requires a signer private key");
    }
    return this.executor.execute(this.cycleAddress, SYNC_OFFER_TRUST_DATA);
  }

  async simulateSyncOfferTrust(): Promise<TransactionSimulationResult> {
    if (!this.executor) {
      throw new Error("simulateSyncOfferTrust requires a signer private key");
    }
    return this.executor.simulate(this.cycleAddress, SYNC_OFFER_TRUST_DATA);
  }

  private async readSchedule(): Promise<{start: bigint; duration: bigint}> {
    // OFFERS_START and OFFER_DURATION are immutables: read once per process.
    if (!this.schedule) {
      const [start, duration] = await Promise.all([this.cycle.OFFERS_START(), this.cycle.OFFER_DURATION()]);
      this.schedule = {start: BigInt(start), duration: BigInt(duration)};
    }
    return this.schedule;
  }
}
