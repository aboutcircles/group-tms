import {IAvatarSafeMappingStore, SafeTrustState} from "../interfaces/IAvatarSafeMappingStore";

export class InMemoryAvatarSafeMappingStore implements IAvatarSafeMappingStore {
  private mapping = new Map<string, string>();
  private safeTrustState = new Map<string, SafeTrustState>();

  async load(): Promise<Map<string, string>> {
    return new Map(this.mapping);
  }

  async save(mapping: Map<string, string>): Promise<void> {
    this.mapping = new Map(mapping);
  }

  async loadSafeTrustState(): Promise<Map<string, SafeTrustState>> {
    return new Map(
      Array.from(this.safeTrustState.entries()).map(([safe, state]) => [safe, {...state}])
    );
  }

  async saveSafeTrustState(state: Map<string, SafeTrustState>): Promise<void> {
    this.safeTrustState = new Map(
      Array.from(state.entries()).map(([safe, value]) => [safe, {...value}])
    );
  }
}
