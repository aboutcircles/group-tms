import {TransactionSimulationResult} from "./ITransactionSimulation";

export interface IRouterService {
  /**
   * Calls the router contract to enable CRC routing for the given base group.
   * @param baseGroup Base group that already trusts the provided CRCs.
   * @param crcAddresses Human CRC addresses that should also be trusted by the router.
   * @returns Transaction hash of the enableCRCForRouting call.
  */
  enableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<string>;
  simulateEnableCRCForRouting?(baseGroup: string, crcAddresses: string[]): Promise<TransactionSimulationResult>;
}
