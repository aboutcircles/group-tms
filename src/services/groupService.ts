import {GroupOwnerAndServiceAddress, IGroupService} from "../interfaces/IGroupService";
import {Contract, getAddress, JsonRpcProvider, Wallet} from "ethers";
import {TransactionConfirmationTimeoutError} from "./safeTransactionExecutor";
import {retryWithBackoff} from "./retryWithBackoff";
import {createProvider} from "./rpcProvider";

const TX_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

function waitWithTimeout(tx: { hash: string; wait: () => Promise<any> }, timeoutMs: number): Promise<any> {
  return Promise.race([
    tx.wait(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new TransactionConfirmationTimeoutError(tx.hash, timeoutMs)),
        timeoutMs
      );
    })
  ]);
}

export const GROUP_MINI_ABI = [
  "function owner() view returns (address)",
  "function service() view returns (address)",
  "function trustBatchWithConditions(address[] memory _members, uint96 _expiry)"
];

export class GroupService implements IGroupService {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;

  constructor(private readonly rpcUrl: string, private readonly servicePrivateKey: string) {
    this.provider = createProvider(rpcUrl) as JsonRpcProvider;
    this.wallet = new Wallet(servicePrivateKey, this.provider);
  }

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const group = this.getWritableGroupContract(groupAddress);

    const expiry: bigint = (1n << 96n) - 1n;

    const tx = await retryWithBackoff(() => group.trustBatchWithConditions(trusteeAddresses, expiry));
    const receipt = await waitWithTimeout(tx, TX_CONFIRMATION_TIMEOUT_MS);

    if (!receipt || receipt.status !== 1) {
      throw new Error(`trustBatchWithConditions failed: ${tx.hash}`);
    }

    return tx.hash;
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {

    const group = this.getWritableGroupContract(groupAddress);

    const tx = await retryWithBackoff(() => group.trustBatchWithConditions(trusteeAddresses, 0n));
    const receipt = await waitWithTimeout(tx, TX_CONFIRMATION_TIMEOUT_MS);

    if (!receipt || receipt.status !== 1) {
      throw new Error(`untrustBatch failed: ${tx.hash}`);
    }

    return tx.hash;
  }

  async fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress> {
    const group = new Contract(groupAddress, GROUP_MINI_ABI, this.provider);

    const owner = String(await group.owner());
    const service = String(await group.service());

    const ownerC = getAddress(owner).toLowerCase();
    const serviceC = getAddress(service).toLowerCase();

    return {
      owner: ownerC,
      service: serviceC
    };
  }

  private getWritableGroupContract(groupAddress: string): Contract {
    return new Contract(groupAddress, GROUP_MINI_ABI, this.wallet);
  }
}
