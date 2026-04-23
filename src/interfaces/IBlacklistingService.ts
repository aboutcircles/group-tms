/**
 * Defines a service for checking if addresses are blacklisted.
 */
export interface IBlacklistingService {
    /**
     * Loads the blacklist from the remote service.
     * This should be called once during initialization before checking addresses.
     * @return A promise that resolves when the blacklist has been loaded.
     */
    loadBlacklist(): Promise<void>;

    /**
     * Checks if the given addresses are blacklisted based on the loaded blacklist data.
     * Note: loadBlacklist() must be called first, or this will return verdicts marking all addresses as allowed.
     * @param addresses The list of addresses to check.
     * @return A promise that resolves to an array of verdicts, each indicating whether the address is a bot and optionally providing a category and reason.
     */
    checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]>;

    /**
     * Gets the total count of blacklisted addresses currently loaded.
     * @return The number of blacklisted addresses.
     */
    getBlacklistCount(): number;

    /**
     * Returns true if at least one successful loadBlacklist() call has completed.
     */
    isLoaded(): boolean;
}

/**
 * A single verdict from the blacklisting service.
 */
export interface IBlacklistServiceVerdict {
    address: string;
    is_bot: boolean;
    category?: string;
    reason?: string;
}