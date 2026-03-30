import {TransactionSimulationResult} from "./ITransactionSimulation";

export type ResetCowSwapOrderResult = "OrderAlreadySettled" | "OrderUidIsTheSame" | "OrderValid";
export type CreateLBPResult = "LBPAlreadyCreated" | "OrderNotYetFilled" | "BackingAssetBalanceInsufficient" | "Success";

export interface IBackingInstanceService {
    /**
     * Simulates resetting the Cowswap order.
     * Reverts if the previous order has already been settled or if the new order UID is the same.
     * @param circlesBackingInstance The address of the CirclesBacking contract instance.
     */
    simulateResetCowSwapOrder(circlesBackingInstance: string): Promise<ResetCowSwapOrderResult>;

    /**
     * Simulates calling the Cowswap posthook to create an LBP and provide liquidity.
     * Reverts if LBP is already created, if the order isn't filled but the deadline is not reached, or if
     * the backing asset received is insufficient.
     * @param circlesBackingInstance The address of the CirclesBacking contract instance.
     */
    simulateCreateLbp(circlesBackingInstance: string): Promise<CreateLBPResult>;

    /**
     * Resets the Cowswap order by calling the `resetCowSwapOrder` function on the CirclesBacking contract.
     * @param circlesBackingInstance The address of the CirclesBacking contract instance.
     * @returns The tx hash
     */
    resetCowSwapOrder(circlesBackingInstance: string): Promise<string>;

    /**
     * Calls the Cowswap posthook "manually" to create an LBP and provide liquidity.
     * @param circlesBackingInstance The address of the CirclesBacking contract instance.
     */
    createLbp(circlesBackingInstance: string) : Promise<string>;

    /**
     * Simulates the actual Safe transaction that would call `resetCowSwapOrder` and estimates its gas.
     */
    simulateResetCowSwapOrderTx?(circlesBackingInstance: string): Promise<TransactionSimulationResult>;

    /**
     * Simulates the actual Safe transaction that would call `createLBP` and estimates its gas.
     */
    simulateCreateLbpTx?(circlesBackingInstance: string): Promise<TransactionSimulationResult>;
}
