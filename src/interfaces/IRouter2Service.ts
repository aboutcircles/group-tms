import {TransactionSimulationResult} from "./ITransactionSimulation";

export interface IRouter2Service {
  enableCRCForRouting(crcAddresses: string[]): Promise<string>;
  setApprovalForCRC(crcAddresses: string[]): Promise<string>;
  simulateEnableCRCForRouting?(crcAddresses: string[]): Promise<TransactionSimulationResult>;
  simulateSetApprovalForCRC?(crcAddresses: string[]): Promise<TransactionSimulationResult>;
  validateSafeOwnership?(): Promise<void>;
}
