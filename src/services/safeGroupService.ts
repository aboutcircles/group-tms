import {Contract, Interface, JsonRpcProvider, getAddress} from "ethers";
import {GroupOwnerAndServiceAddress, IGroupService} from "../interfaces/IGroupService";
import {GROUP_MINI_ABI} from "./groupService";
import {SafeTransactionExecutor} from "./safeTransactionExecutor";
import {createProvider} from "./rpcProvider";

const GROUP_INTERFACE = new Interface(GROUP_MINI_ABI);
const MAX_UINT96 = (1n << 96n) - 1n;

export class SafeGroupService implements IGroupService {
  private readonly provider: JsonRpcProvider;
  private readonly executor: SafeTransactionExecutor;

  constructor(rpcUrl: string, signerPrivateKey: string, safeAddress: string) {
    this.provider = createProvider(rpcUrl) as JsonRpcProvider;
    this.executor = new SafeTransactionExecutor(rpcUrl, signerPrivateKey, safeAddress);
  }

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      MAX_UINT96
    ]);

    return this.executor.execute(groupAddress, data);
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      0n
    ]);

    return this.executor.execute(groupAddress, data);
  }

  async fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress> {
    const group = new Contract(groupAddress, GROUP_MINI_ABI, this.provider);

    const owner = String(await group.owner());
    const service = String(await group.service());

    return {
      owner: getAddress(owner).toLowerCase(),
      service: getAddress(service).toLowerCase()
    };
  }
}
