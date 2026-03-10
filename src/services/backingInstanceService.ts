import {ResetCowSwapOrderResult, IBackingInstanceService, CreateLBPResult} from "../interfaces/IBackingInstanceService";
import {Contract, Interface, JsonRpcProvider, FallbackProvider} from "ethers";
import CirclesBackingABI from "../abi/CirclesBackingABI.json";
import {SafeTransactionExecutor} from "./safeTransactionExecutor";
import {createProvider} from "./rpcProvider";

const BACKING_INTERFACE = new Interface(CirclesBackingABI);

export class BackingInstanceService implements IBackingInstanceService {
  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly executor?: SafeTransactionExecutor;

  constructor(rpcUrl: string, signerPrivateKey?: string, safeAddress?: string) {
    this.provider = createProvider(rpcUrl);
    if (signerPrivateKey && signerPrivateKey.trim().length > 0 && safeAddress && safeAddress.trim().length > 0) {
      this.executor = new SafeTransactionExecutor(rpcUrl, signerPrivateKey, safeAddress);
    }
  }

  destroy(): void {
    this.provider.destroy();
  }

  async resetCowSwapOrder(circlesBackingInstance: string): Promise<string> {
    if (!this.executor) {
      throw new Error("resetCowSwapOrder requires a configured Safe signer");
    }
    const data = BACKING_INTERFACE.encodeFunctionData("resetCowswapOrder", []);
    return this.executor.execute(circlesBackingInstance, data);
  }

  async createLbp(circlesBackingInstance: string): Promise<string> {
    if (!this.executor) {
      throw new Error("createLbp requires a configured Safe signer");
    }
    const data = BACKING_INTERFACE.encodeFunctionData("createLBP", []);
    return this.executor.execute(circlesBackingInstance, data);
  }

  async simulateCreateLbp(circlesBackingInstance: string): Promise<CreateLBPResult> {
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, this.provider);

    // 1) Simulate first to classify errors
    try {
      await contract.createLBP.staticCall();
    } catch (err: any) {
      const name = this.parseCustomError(contract, err);
      if (name === "LBPAlreadyCreated") {
        return "LBPAlreadyCreated";
      }
      if (name === "OrderNotYetFilled") {
        return "OrderNotYetFilled";
      }
      if (name === "BackingAssetBalanceInsufficient") {
        return "BackingAssetBalanceInsufficient";
      }
      throw new Error(`createLBP simulation failed: ${name ?? err?.shortMessage ?? err?.message}`);
    }

    return "Success";
  }

  async simulateResetCowSwapOrder(circlesBackingInstance: string): Promise<ResetCowSwapOrderResult> {
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, this.provider);

    // 1) Simulate to get a clean error classification without spending gas.
    try {
      await contract.resetCowswapOrder.staticCall();
    } catch (err: any) {
      const name = this.parseCustomError(contract, err);
      if (name === "OrderAlreadySettled") {
        return "OrderAlreadySettled";
      }
      if (name === "OrderUidIsTheSame") {
        return "OrderUidIsTheSame";
      }
      // Unknown custom error or non-custom revert
      throw new Error(`resetCowswapOrder simulation failed: ${name ?? err?.shortMessage ?? err?.message}`);
    }

    return "OrderValid";
  }

  parseCustomError(contract: Contract, err: any): string | undefined {
    // Try several known spots for revert data
    const candidates: unknown[] = [
      err?.data,
      err?.error?.data,
      err?.info?.error?.data,
      err?.info?.data,
      err?.cause?.data,
      err?.receipt?.revertReason // some providers include this
    ];

    for (const c of candidates) {
      try {
        if (!c) {
          continue;
        }
        const decoded = contract.interface.parseError(c as any);
        if (decoded?.name) {
          return decoded.name;
        }
      } catch {
        // fallthrough
      }
    }

    // Try to sniff a standard Error(string) message
    try {
      const reason: string | undefined =
        err?.reason ??
        err?.shortMessage ??
        err?.message;
      if (typeof reason === "string") {
        if (reason.includes("LBPAlreadyCreated")) {
          return "LBPAlreadyCreated";
        }
        if (reason.includes("OrderNotYetFilled")) {
          return "OrderNotYetFilled";
        }
        if (reason.includes("BackingAssetBalanceInsufficient")) {
          return "BackingAssetBalanceInsufficient";
        }
        if (reason.includes("OrderAlreadySettled")) {
          return "OrderAlreadySettled";
        }
        if (reason.includes("OrderUidIsTheSame")) {
          return "OrderUidIsTheSame";
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }
}
