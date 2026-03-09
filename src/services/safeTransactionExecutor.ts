import Safe from "@safe-global/protocol-kit";
import {getAddress, JsonRpcProvider} from "ethers";

/** Default timeout for waiting on tx confirmation (5 minutes). */
const DEFAULT_TX_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

export class TransactionConfirmationTimeoutError extends Error {
  constructor(public readonly txHash: string, public readonly timeoutMs: number) {
    super(`Tx ${txHash} confirmation timed out after ${timeoutMs}ms`);
    this.name = "TransactionConfirmationTimeoutError";
  }
}

function ensureSuccessfulReceipt(receipt: any, context: string) {
  if (!receipt) throw new Error(`${context} did not return a receipt`);
  if (receipt.status !== 1 && receipt.status !== 1n && receipt.status !== "0x1") {
    throw new Error(`${context} failed on-chain (status ${String(receipt.status)})`);
  }
  return receipt;
}

/**
 * Thin helper around Safe Protocol Kit to execute arbitrary contract calls and wait for confirmations.
 */
export class SafeTransactionExecutor {
  private readonly provider: JsonRpcProvider;
  private readonly safePromise: Promise<Safe>;
  private readonly safeAddress: string;

  constructor(rpcUrl: string, signerPrivateKey: string, safeAddress: string) {
    if (!signerPrivateKey || signerPrivateKey.trim().length === 0) {
      throw new Error("Safe signer private key is required");
    }
    if (!safeAddress || safeAddress.trim().length === 0) {
      throw new Error("Safe address is required");
    }

    this.provider = new JsonRpcProvider(rpcUrl);
    this.safeAddress = getAddress(safeAddress);
    this.safePromise = Safe.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
      safeAddress: this.safeAddress
    });
  }

  async execute(
    to: string,
    data: string,
    confirmationsToWait = 1,
    value: string | bigint = 0n,
    confirmationTimeoutMs: number = DEFAULT_TX_CONFIRMATION_TIMEOUT_MS
  ): Promise<string> {
    const safe = await this.safePromise;
    const normalizedTo = getAddress(to);
    const normalizedValue = typeof value === "bigint" ? value.toString() : value ?? "0";

    const safeTx = await safe.createTransaction({
      transactions: [
        {
          to: normalizedTo,
          value: normalizedValue,
          data
        }
      ]
    });

    const execution = await safe.executeTransaction(safeTx);

    const txHash =
      (execution as any).hash ?? (execution as any).transactionResponse?.hash;

    if (!txHash) throw new Error("No transaction hash returned from Safe execution");

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([
      this.provider.waitForTransaction(txHash, confirmationsToWait),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new TransactionConfirmationTimeoutError(txHash, confirmationTimeoutMs)),
          confirmationTimeoutMs
        );
      })
    ]).finally(() => clearTimeout(timeoutId));
    ensureSuccessfulReceipt(receipt, `Safe tx to ${normalizedTo}`);

    return txHash;
  }
}
