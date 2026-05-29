import {Interface, getAddress} from "ethers";
import {IRouter2Service} from "../interfaces/IRouter2Service";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import {EoaTransactionExecutor} from "./eoaTransactionExecutor";

const ROUTER2_ABI = [
  "function enableCRCForRouting(address[] crcArray)",
  "function setApprovalForCRC(address[] crcArray)"
] as const;

const ROUTER2_INTERFACE = new Interface(ROUTER2_ABI);

export class Router2Service implements IRouter2Service {
  private readonly executor: EoaTransactionExecutor;
  private readonly routerAddress: string;

  constructor(
    rpcUrl: string,
    routerAddress: string,
    signerPrivateKey: string,
    txRpcUrl: string = rpcUrl
  ) {
    this.routerAddress = getAddress(routerAddress);
    this.executor = new EoaTransactionExecutor(txRpcUrl, signerPrivateKey);
  }

  getSignerAddress(): string {
    return this.executor.getSignerAddress();
  }

  async enableCRCForRouting(crcAddresses: string[]): Promise<string> {
    const data = this.encodeEnableCRCForRouting(crcAddresses);
    return this.executor.execute(this.routerAddress, data);
  }

  async setApprovalForCRC(crcAddresses: string[]): Promise<string> {
    const data = this.encodeSetApprovalForCRC(crcAddresses);
    return this.executor.execute(this.routerAddress, data);
  }

  async simulateEnableCRCForRouting(crcAddresses: string[]): Promise<TransactionSimulationResult> {
    const data = this.encodeEnableCRCForRouting(crcAddresses);
    return this.executor.simulate(this.routerAddress, data);
  }

  async simulateSetApprovalForCRC(crcAddresses: string[]): Promise<TransactionSimulationResult> {
    const data = this.encodeSetApprovalForCRC(crcAddresses);
    return this.executor.simulate(this.routerAddress, data);
  }

  private encodeEnableCRCForRouting(crcAddresses: string[]): string {
    if (crcAddresses.length === 0) {
      throw new Error("enableCRCForRouting requires at least one CRC address.");
    }

    return ROUTER2_INTERFACE.encodeFunctionData("enableCRCForRouting", [
      normalizeAddressArray(crcAddresses)
    ]);
  }

  private encodeSetApprovalForCRC(crcAddresses: string[]): string {
    if (crcAddresses.length === 0) {
      throw new Error("setApprovalForCRC requires at least one CRC address.");
    }

    return ROUTER2_INTERFACE.encodeFunctionData("setApprovalForCRC", [
      normalizeAddressArray(crcAddresses)
    ]);
  }
}

function normalizeAddressArray(addresses: string[]): string[] {
  return addresses.map((address) => getAddress(address));
}
