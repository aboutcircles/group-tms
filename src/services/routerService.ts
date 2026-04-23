import {getAddress, Interface} from "ethers";
import {IRouterService} from "../interfaces/IRouterService";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import {SafeTransactionExecutor} from "./safeTransactionExecutor";

const ROUTER_ABI = [
  "function enableCRCForRouting(address baseGroup, address[] crcArray)"
];
const ROUTER_INTERFACE = new Interface(ROUTER_ABI);

export class RouterService implements IRouterService {
  private readonly executor: SafeTransactionExecutor;
  private readonly routerAddress: string;

  constructor(
    rpcUrl: string,
    routerAddress: string,
    signerPrivateKey: string,
    safeAddress: string,
    txRpcUrl: string = rpcUrl
  ) {
    this.routerAddress = getAddress(routerAddress);
    this.executor = new SafeTransactionExecutor(txRpcUrl, signerPrivateKey, safeAddress);
  }

  async enableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<string> {
    if (crcAddresses.length === 0) {
      throw new Error("enableCRCForRouting requires at least one CRC address.");
    }

    const normalizedBaseGroup = getAddress(baseGroup);
    const normalizedCrcs = crcAddresses.map((address) => getAddress(address));

    const data = ROUTER_INTERFACE.encodeFunctionData("enableCRCForRouting", [
      normalizedBaseGroup,
      normalizedCrcs
    ]);

    return this.executor.execute(this.routerAddress, data);
  }

  async simulateEnableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<TransactionSimulationResult> {
    if (crcAddresses.length === 0) {
      throw new Error("enableCRCForRouting requires at least one CRC address.");
    }

    const normalizedBaseGroup = getAddress(baseGroup);
    const normalizedCrcs = crcAddresses.map((address) => getAddress(address));

    const data = ROUTER_INTERFACE.encodeFunctionData("enableCRCForRouting", [
      normalizedBaseGroup,
      normalizedCrcs
    ]);

    return this.executor.simulate(this.routerAddress, data);
  }
}
