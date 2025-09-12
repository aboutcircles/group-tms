export type GroupOwnerAndServiceAddress = {
    owner: string,
    service: string
};

export interface IGroupService {
    trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string>;
    untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string>;
    fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress>
}
