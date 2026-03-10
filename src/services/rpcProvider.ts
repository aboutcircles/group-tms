/**
 * Shared helper to create an ethers provider from a (possibly comma-separated) RPC_URL.
 *
 * Single URL  → JsonRpcProvider
 * Multiple    → FallbackProvider with quorum=1 (first healthy wins)
 */
import { JsonRpcProvider, FallbackProvider } from "ethers";

export function parseRpcUrls(rpcUrl: string): string[] {
  return rpcUrl
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

export function createProvider(rpcUrl: string): JsonRpcProvider | FallbackProvider {
  const urls = parseRpcUrls(rpcUrl);
  if (urls.length === 0) {
    throw new Error("RPC_URL must contain at least one URL");
  }
  if (urls.length === 1) {
    return new JsonRpcProvider(urls[0]);
  }
  return new FallbackProvider(
    urls.map((u) => new JsonRpcProvider(u)),
    1, // quorum — accept first successful response
  );
}
