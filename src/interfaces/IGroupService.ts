import {TransactionSimulationResult} from "./ITransactionSimulation";

export type GroupOwnerAndServiceAddress = {
    owner: string,
    service: string
};

export interface IGroupService {
    trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string>;
    untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string>;
    fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress>;
    simulateTrustBatchWithConditions?(groupAddress: string, trusteeAddresses: string[]): Promise<TransactionSimulationResult>;
    simulateUntrustBatch?(groupAddress: string, trusteeAddresses: string[]): Promise<TransactionSimulationResult>;
    validateSafeOwnership?(): Promise<void>;
}
