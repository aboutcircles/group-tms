import { parseRpcUrls, createProvider } from "../../src/services/rpcProvider";
import { JsonRpcProvider, FallbackProvider } from "ethers";

describe("parseRpcUrls", () => {
  it("parses a single URL", () => {
    expect(parseRpcUrls("http://localhost:8545")).toEqual(["http://localhost:8545"]);
  });

  it("parses comma-separated URLs", () => {
    expect(parseRpcUrls("http://a:8545,http://b:8545")).toEqual([
      "http://a:8545",
      "http://b:8545",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseRpcUrls("  http://a:8545 , http://b:8545  ")).toEqual([
      "http://a:8545",
      "http://b:8545",
    ]);
  });

  it("filters empty segments", () => {
    expect(parseRpcUrls("http://a:8545,,")).toEqual(["http://a:8545"]);
  });
});

describe("createProvider", () => {
  it("returns JsonRpcProvider for single URL", () => {
    const provider = createProvider("http://localhost:8545");
    expect(provider).toBeInstanceOf(JsonRpcProvider);
  });

  it("returns FallbackProvider for multiple URLs", () => {
    const provider = createProvider("http://a:8545,http://b:8545");
    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it("throws on empty string", () => {
    expect(() => createProvider("")).toThrow("at least one URL");
  });
});
