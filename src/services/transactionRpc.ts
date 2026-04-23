export const TX_RPC_URL_ENV_VAR = "TX_RPC_URL";

export function resolveTransactionRpcUrl(
  readRpcUrl: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configured = env[TX_RPC_URL_ENV_VAR]?.trim();
  return configured && configured.length > 0 ? configured : readRpcUrl;
}
