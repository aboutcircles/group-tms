import {FallbackProvider, getAddress, JsonRpcProvider, Wallet} from "ethers";
import {TransactionSimulationResult} from "../interfaces/ITransactionSimulation";
import {createProvider, primaryRpcUrl} from "./rpcProvider";
import {retryWithBackoff} from "./retryWithBackoff";

const DEFAULT_TX_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;
const GAS_LIMIT_BUFFER_NUMERATOR = 120n;
const GAS_LIMIT_BUFFER_DENOMINATOR = 100n;

function bufferGasLimit(gasEstimate: bigint): bigint {
  return ((gasEstimate * GAS_LIMIT_BUFFER_NUMERATOR) + (GAS_LIMIT_BUFFER_DENOMINATOR - 1n)) / GAS_LIMIT_BUFFER_DENOMINATOR;
}

function ensureSuccessfulReceipt(receipt: any, context: string) {
  if (!receipt) {
    throw new Error(`${context} did not return a receipt`);
  }
  if (receipt.status !== 1 && receipt.status !== 1n && receipt.status !== "0x1") {
    throw new Error(`${context} failed on-chain (status ${String(receipt.status)})`);
  }
  return receipt;
}

export class EoaTransactionConfirmationTimeoutError extends Error {
  constructor(public readonly txHash: string, public readonly timeoutMs: number) {
    super(`Tx ${txHash} confirmation timed out after ${timeoutMs}ms`);
    this.name = "EoaTransactionConfirmationTimeoutError";
  }
}

export class EoaTransactionExecutor {
  private readonly provider: JsonRpcProvider | FallbackProvider;
  private readonly signer: Wallet;
  private readonly signerAddress: string;
  private _executeLock: Promise<void> = Promise.resolve();

  constructor(rpcUrl: string, signerPrivateKey: string) {
    if (!signerPrivateKey || signerPrivateKey.trim().length === 0) {
      throw new Error("EOA signer private key is required");
    }

    const normalizedPrivateKey = signerPrivateKey.startsWith("0x")
      ? signerPrivateKey
      : `0x${signerPrivateKey}`;

    this.provider = createProvider(rpcUrl);
    this.signer = new Wallet(normalizedPrivateKey, new JsonRpcProvider(primaryRpcUrl(rpcUrl)));
    this.signerAddress = getAddress(this.signer.address);
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  async execute(
    to: string,
    data: string,
    confirmationsToWait = 1,
    value: string | bigint = 0n,
    confirmationTimeoutMs: number = DEFAULT_TX_CONFIRMATION_TIMEOUT_MS
  ): Promise<string> {
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const prev = this._executeLock;
    this._executeLock = gate;
    await prev;

    try {
      return await this.executeInner(to, data, confirmationsToWait, value, confirmationTimeoutMs);
    } finally {
      release!();
    }
  }

  async simulate(
    to: string,
    data: string,
    value: string | bigint = 0n
  ): Promise<TransactionSimulationResult> {
    const normalizedTo = getAddress(to);
    const normalizedValue = typeof value === "bigint" ? value : BigInt(value ?? "0");
    const request = {
      from: this.signerAddress,
      to: normalizedTo,
      data,
      value: normalizedValue
    };
    const gasEstimate = await retryWithBackoff(() => this.provider.estimateGas(request), {
      maxRetries: 5,
      baseDelayMs: 2_000
    });

    await retryWithBackoff(() => this.provider.call({
      ...request,
      gasLimit: bufferGasLimit(gasEstimate)
    }));

    return {gasEstimate};
  }

  private async executeInner(
    to: string,
    data: string,
    confirmationsToWait: number,
    value: string | bigint,
    confirmationTimeoutMs: number
  ): Promise<string> {
    const normalizedTo = getAddress(to);
    const normalizedValue = typeof value === "bigint" ? value : BigInt(value ?? "0");
    const request = {
      from: this.signerAddress,
      to: normalizedTo,
      data,
      value: normalizedValue
    };
    const gasEstimate = await retryWithBackoff(() => this.provider.estimateGas(request), {
      maxRetries: 5,
      baseDelayMs: 2_000
    });
    const tx = await this.signer.sendTransaction({
      to: normalizedTo,
      data,
      value: normalizedValue,
      gasLimit: bufferGasLimit(gasEstimate)
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const receipt = await Promise.race([
      this.provider.waitForTransaction(tx.hash, confirmationsToWait),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new EoaTransactionConfirmationTimeoutError(tx.hash, confirmationTimeoutMs)),
          confirmationTimeoutMs
        );
      })
    ]).finally(() => clearTimeout(timeoutId));
    ensureSuccessfulReceipt(receipt, `EOA tx to ${normalizedTo}`);

    return tx.hash;
  }
}
