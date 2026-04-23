import {IBlacklistingService, IBlacklistServiceVerdict} from "../interfaces/IBlacklistingService";

export const DEFAULT_BLACKLIST_PAGE_TIMEOUT_MS = 60_000;
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGES = 100; // 100k addresses max — well beyond expected blacklist size

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
        private readonly pageTimeoutMs: number = DEFAULT_BLACKLIST_PAGE_TIMEOUT_MS,
        private readonly pageSize: number = DEFAULT_PAGE_SIZE
    ) {}

    async loadBlacklist(): Promise<void> {
        const allAddresses: string[] = [];
        let offset = 0;
        let total: number | undefined;
        let pageCount = 0;

        // Fetch all pages. If ANY page fails, throw — no partial state.
        while (total === undefined || offset < total) {
            if (++pageCount > MAX_PAGES) {
                throw new Error(`Failed to load blacklist: exceeded ${MAX_PAGES} pages (${offset} addresses fetched)`);
            }

            const page = await this.fetchPage(offset);
            total = page.total;

            for (const address of page.addresses) {
                if (typeof address === "string") {
                    allAddresses.push(address.toLowerCase());
                }
            }

            if (page.count < this.pageSize) break;
            offset += this.pageSize;
        }

        // Only swap in the complete set after ALL pages succeed
        this.blacklistedAddresses = new Set(allAddresses);
        this.loaded = true;
    }

    private async fetchPage(offset: number): Promise<BlacklistResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.pageTimeoutMs);

        try {
            const url = new URL(this.serviceUrl);
            url.searchParams.set("include_reason", "false");
            url.searchParams.set("v2_only", "true");
            url.searchParams.set("limit", this.pageSize.toString());
            url.searchParams.set("offset", offset.toString());

            const response = await fetch(url.toString(), {
                method: "GET",
                signal: controller.signal,
                headers: { "User-Agent": "group-tms/1.0" }
            });

            if (!response.ok) {
                throw new Error(`Failed to load blacklist: HTTP ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as BlacklistResponse;
            if (!data || !Array.isArray(data.addresses)) {
                throw new Error("Failed to load blacklist: malformed response payload");
            }
            if (typeof data.total !== "number" || !Number.isFinite(data.total) || data.total < 0) {
                throw new Error(`Failed to load blacklist: invalid total=${data.total}`);
            }
            if (typeof data.count !== "number" || !Number.isFinite(data.count) || data.count < 0) {
                throw new Error(`Failed to load blacklist: invalid count=${data.count}`);
            }

            return data;
        } catch (error) {
            if (error && typeof error === "object" && (error as any).name === "AbortError") {
                throw new Error(`Failed to load blacklist: page at offset ${offset} timed out after ${this.pageTimeoutMs}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
        if (!this.loaded) {
            // WARN: Blacklist not loaded — all addresses pass through as allowed.
            // Callers MUST call loadBlacklist() before checkBlacklist().
            // The polling loop enforces this: refreshBlacklist() throws on failure,
            // preventing runOnce() from executing with stale/empty data.
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
