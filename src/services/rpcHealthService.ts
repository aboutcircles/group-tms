import {ILoggerService} from "../interfaces/ILoggerService";
import {ISlackService} from "../interfaces/ISlackService";

type RpcHealthResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

export type RpcHealthCheckResult = {
  healthy: boolean;
  blockNumber?: number;
  error?: string;
};

const DEFAULT_RPC_HEALTH_TIMEOUT_MS = 10_000;

export async function checkRpcHealth(
  rpcUrl: string,
  timeoutMs: number = DEFAULT_RPC_HEALTH_TIMEOUT_MS
): Promise<RpcHealthCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return {healthy: false, error: `HTTP ${response.status} ${response.statusText}`};
    }

    const payload = await response.json() as RpcHealthResponse;
    if (payload.error) {
      const message = payload.error.message || "unknown RPC error";
      return {healthy: false, error: `RPC error ${payload.error.code ?? "unknown"}: ${message}`};
    }

    if (typeof payload.result !== "string" || !payload.result.startsWith("0x")) {
      return {healthy: false, error: "Invalid eth_blockNumber response"};
    }

    const blockNumber = Number.parseInt(payload.result, 16);
    if (!Number.isFinite(blockNumber) || blockNumber < 0) {
      return {healthy: false, error: "Unparseable block number from eth_blockNumber"};
    }

    return {healthy: true, blockNumber};
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {healthy: false, error: `Timed out after ${timeoutMs} ms`};
    }
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function ensureRpcHealthyOrNotify(params: {
  appName: string;
  rpcUrl: string;
  slackService: ISlackService;
  logger: ILoggerService;
  timeoutMs?: number;
}): Promise<boolean> {
  const health = await checkRpcHealth(params.rpcUrl, params.timeoutMs);
  if (health.healthy) {
    return true;
  }

  const detail = health.error || "unknown error";
  const message =
    `⚠️ *${params.appName} RPC health check failed*\n\n` +
    `- RPC: ${params.rpcUrl}\n` +
    `- Reason: ${detail}\n` +
    `- Action: Run will proceed; investigate RPC health`;

  params.logger.warn(
    `[rpc-health] ${params.appName}: unhealthy RPC endpoint '${params.rpcUrl}' (${detail}). Skipping run.`
  );

  try {
    await params.slackService.notifySlackStartOrCrash(message);
  } catch (error) {
    params.logger.warn(`[rpc-health] Failed to send Slack RPC health notification:`, error);
  }

  return false;
}
