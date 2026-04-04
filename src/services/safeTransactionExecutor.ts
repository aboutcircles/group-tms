import Safe from "@safe-global/protocol-kit";
import { FallbackProvider, getAddress, JsonRpcProvider, Wallet } from "ethers";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import { retryWithBackoff } from "./retryWithBackoff";
import { createProvider, primaryRpcUrl } from "./rpcProvider";

/** Default timeout for waiting on tx confirmation (5 minutes). */
const DEFAULT_TX_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const GAS_LIMIT_BUFFER_NUMERATOR = 120n;
const GAS_LIMIT_BUFFER_DENOMINATOR = 100n;

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
 *
 * execute() is serialized via an async lock to prevent nonce collisions when multiple
 * callers share the same Safe address (e.g. gnosis-group + router-tms in separate processes
 * won't help, but concurrent calls within a single process are safe).
 */
export class SafeTransactionExecutor {
  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly safePromise: Promise<Safe>;
  private readonly safeAddress: string;
  private readonly signerAddress: string;
  /** Async mutex: each execute() waits for the previous one to finish. */
  private _executeLock: Promise<void> = Promise.resolve();

  constructor(rpcUrl: string, signerPrivateKey: string, safeAddress: string) {
    if (!signerPrivateKey || signerPrivateKey.trim().length === 0) {
      throw new Error("Safe signer private key is required");
    }
    if (!safeAddress || safeAddress.trim().length === 0) {
      throw new Error("Safe address is required");
    }

    this.provider = createProvider(rpcUrl);
    this.safeAddress = getAddress(safeAddress);
    this.signerAddress = getAddress(SafeTransactionExecutor.privateKeyToAddress(signerPrivateKey));
    this.safePromise = Safe.init({
      provider: primaryRpcUrl(rpcUrl),
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
    // Serialize: wait for any in-flight execute() to finish before starting.
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const prev = this._executeLock;
    this._executeLock = gate;
    await prev;

    try {
      return await this._executeInner(to, data, confirmationsToWait, value, confirmationTimeoutMs);
    } finally {
      release!();
    }
  }

  private async _executeInner(
    to: string,
    data: string,
    confirmationsToWait: number,
    value: string | bigint,
    confirmationTimeoutMs: number
  ): Promise<string> {
    const safe = await this.safePromise;
    const normalizedTo = getAddress(to);
    const normalizedValue = typeof value === "bigint" ? value.toString() : value ?? "0";

    const unsignedSafeTx = await safe.createTransaction({
      transactions: [
        {
          to: normalizedTo,
          value: normalizedValue,
          data
        }
      ]
    });
    const signedSafeTx = await safe.signTransaction(unsignedSafeTx);
    const gasLimit = await this.estimateExecutionGasLimit(safe, signedSafeTx);

    // Do NOT retry executeTransaction — if the first attempt reaches the mempool but
    // the response is lost (timeout), a retry would send a second tx with a new EOA nonce,
    // causing duplicate on-chain execution. Gas estimation (above) is safe to retry.
    const execution = await safe.executeTransaction(signedSafeTx, { gasLimit: gasLimit.toString() });

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

  async simulate(
    to: string,
    data: string,
    value: string | bigint = 0n
  ): Promise<TransactionSimulationResult> {
    const safe = await this.safePromise;
    const normalizedTo = getAddress(to);
    const normalizedValue = typeof value === "bigint" ? value.toString() : value ?? "0";

    const unsignedSafeTx = await safe.createTransaction({
      transactions: [
        {
          to: normalizedTo,
          value: normalizedValue,
          data
        }
      ]
    });
    const signedSafeTx = await safe.signTransaction(unsignedSafeTx);
    const gasEstimate = await this.estimateExecutionGasLimit(safe, signedSafeTx);
    const encodedSafeTx = await safe.getEncodedTransaction(signedSafeTx);

    await retryWithBackoff(() => this.provider.call({
      from: this.signerAddress,
      to: this.safeAddress,
      data: encodedSafeTx
    }));

    return {gasEstimate};
  }

  private async estimateExecutionGasLimit(safe: Safe, safeTx: Awaited<ReturnType<Safe["createTransaction"]>>): Promise<bigint> {
    // Estimate the fully encoded execTransaction with ethers to avoid Protocol Kit's
    // internal viem estimate path. Wrapped in retryWithBackoff because public RPCs
    // intermittently return "evm timeout" or empty CALL_EXCEPTION on complex Safe calls.
    const encodedSafeTx = await safe.getEncodedTransaction(safeTx);
    const gasEstimate = await retryWithBackoff<bigint>(() => this.provider.estimateGas({
      from: this.signerAddress,
      to: this.safeAddress,
      data: encodedSafeTx
    }), { maxRetries: 5, baseDelayMs: 2_000 });

    return ((gasEstimate * GAS_LIMIT_BUFFER_NUMERATOR) + (GAS_LIMIT_BUFFER_DENOMINATOR - 1n)) / GAS_LIMIT_BUFFER_DENOMINATOR;
  }

  private static privateKeyToAddress(privateKey: string): string {
    const normalized = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    return new Wallet(normalized).address;
  }
}
