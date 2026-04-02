import {IBlacklistingService, IBlacklistServiceVerdict} from "../interfaces/IBlacklistingService";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 10000;
const DEFAULT_OFFSET = 0;

type BlacklistResponse = {
    status: string;
    total: number;
    count: number;
    v2_only: boolean;
    addresses: string[];
};

export class BlacklistingService implements IBlacklistingService {
    private blacklistedAddresses: Set<string> = new Set();
    private loaded: boolean = false;

    constructor(
        private serviceUrl: string,
        private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
        private readonly limit: number = DEFAULT_LIMIT,
        private readonly offset: number = DEFAULT_OFFSET
    ) {
        // https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist
    }

    async loadBlacklist(): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const url = new URL(this.serviceUrl);
            url.searchParams.set("include_reason", "false");
            url.searchParams.set("v2_only", "true");
            url.searchParams.set("limit", this.limit.toString());
            url.searchParams.set("offset", this.offset.toString());

            const response = await fetch(url.toString(), {
                method: "GET",
                signal: controller.signal,
                headers: {
                    "User-Agent": "group-tms/1.0"
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to load blacklist: HTTP ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as BlacklistResponse;
            if (!data || !Array.isArray(data.addresses)) {
                throw new Error("Failed to load blacklist: malformed response payload");
            }

            this.blacklistedAddresses.clear();
            for (const address of data.addresses) {
                if (typeof address === "string") {
                    this.blacklistedAddresses.add(address.toLowerCase());
                }
            }

            this.loaded = true;
        } catch (error) {
            if (error && typeof error === "object" && (error as any).name === "AbortError") {
                throw new Error("Failed to load blacklist: request timed out");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
        if (!this.loaded) {
            // Return all addresses as allowed if blacklist hasn't been loaded
            return addresses.map((address) => ({
                address,
                is_bot: false
            }));
        }

        return addresses.map((address) => {
            const isBlacklisted = this.blacklistedAddresses.has(address.toLowerCase());
            return {
                address,
                is_bot: isBlacklisted,
                category: isBlacklisted ? "blocked" : undefined
            };
        });
    }

    getBlacklistCount(): number {
        return this.blacklistedAddresses.size;
    }
}
