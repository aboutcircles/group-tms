import {Contract, FallbackProvider, Interface, JsonRpcProvider, getAddress} from "ethers";
import {GroupOwnerAndServiceAddress, IGroupService} from "../interfaces/IGroupService";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import {GROUP_MINI_ABI} from "./groupService";
import {SafeTransactionExecutor} from "./safeTransactionExecutor";
import {createProvider} from "./rpcProvider";

const GROUP_INTERFACE = new Interface(GROUP_MINI_ABI);
const MAX_UINT96 = (1n << 96n) - 1n;

export class SafeGroupService implements IGroupService {
  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly executor: SafeTransactionExecutor;

  constructor(rpcUrl: string, signerPrivateKey: string, safeAddress: string, txRpcUrl: string = rpcUrl) {
    this.provider = createProvider(rpcUrl);
    this.executor = new SafeTransactionExecutor(txRpcUrl, signerPrivateKey, safeAddress);
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

  async simulateTrustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<TransactionSimulationResult> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      MAX_UINT96
    ]);

    return this.executor.simulate(groupAddress, data);
  }

  async simulateUntrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<TransactionSimulationResult> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      0n
    ]);

    return this.executor.simulate(groupAddress, data);
  }
}
