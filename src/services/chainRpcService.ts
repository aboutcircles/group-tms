import {IChainRpc} from "../interfaces/IChainRpc";
import {JsonRpcProvider, TransactionReceipt} from "ethers";
import {createProvider} from "./rpcProvider";

export class ChainRpcService implements IChainRpc {
  private provider: JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.provider = createProvider(rpcUrl) as JsonRpcProvider;
  }

  async getHeadBlock(): Promise<{ blockNumber: number; timestamp: number }> {
    const block = await this.provider.getBlock("latest");
    if (!block) {
      throw new Error("Failed to fetch the latest block");
    }
    return {
      blockNumber: block.number,
      timestamp: block.timestamp
    };
  }

  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt> {
    const txReceipt = await this.provider.getTransactionReceipt(txHash);
    if (!txReceipt) {
      throw new Error(`Transaction receipt not found for hash: ${txHash}`);
    }

    return txReceipt;
  }
}
