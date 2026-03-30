import {resolveTransactionRpcUrl} from "../../src/services/transactionRpc";

describe("resolveTransactionRpcUrl", () => {
  it("falls back to the read RPC when TX_RPC_URL is unset", () => {
    expect(resolveTransactionRpcUrl("https://read.rpc", {})).toBe("https://read.rpc");
  });

  it("falls back to the read RPC when TX_RPC_URL is blank", () => {
    expect(resolveTransactionRpcUrl("https://read.rpc", {TX_RPC_URL: "   "})).toBe("https://read.rpc");
  });

  it("prefers TX_RPC_URL when configured", () => {
    expect(resolveTransactionRpcUrl("https://read.rpc", {TX_RPC_URL: " https://write.rpc "})).toBe("https://write.rpc");
  });
});
