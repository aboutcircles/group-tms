import { Interface, JsonRpcProvider } from "ethers";
import {
  AffiliateGroupChanged,
  IAffiliateGroupEventsService,
} from "../interfaces/IAffiliateGroupEventsService";
import {ILoggerService} from "../interfaces/ILoggerService";

const ABI = [
  "event AffiliateGroupChanged(address indexed human, address oldGroup, address newGroup)",
];

export class AffiliateGroupEventsService implements IAffiliateGroupEventsService {
  private readonly provider: JsonRpcProvider;
  private readonly iface = new Interface(ABI);
  private readonly topic = this.iface.getEvent("AffiliateGroupChanged")!.topicHash;
  private readonly logger?: ILoggerService;

  private readonly chunkSize: number = 100000;
  private readonly maxRetries: number = 3;
  private readonly retryDelayMs: number = 1000;

  constructor(rpcUrl: string, logger?: ILoggerService) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.logger = logger;
  }

  async fetchAffiliateGroupChanged(
    registryAddress: string,
    targetGroup: string,
    fromBlock: number,
    toBlock?: number
  ): Promise<AffiliateGroupChanged[]> {
    const latest = toBlock ?? (await this.provider.getBlockNumber());
    const allLogs: any[] = [];
    const totalChunks = latest >= fromBlock
      ? Math.ceil((latest - fromBlock + 1) / this.chunkSize)
      : 0;
    const startedAt = Date.now();

    this.logger?.info(
      `[affiliate-fetch] start registry=${registryAddress} targetGroup=${targetGroup} range=${fromBlock}-${latest} chunkSize=${this.chunkSize} chunks=${totalChunks}`
    );

    let start = fromBlock;
    let chunkIndex = 0;
    while (start <= latest) {
      const end = Math.min(latest, start + this.chunkSize - 1);
      chunkIndex++;
      let attempt = 0;
      // retry loop for transient RPC timeouts
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const chunkStartedAt = Date.now();
          const chunkLogs = await this.provider.getLogs({
            address: registryAddress,
            fromBlock: start,
            toBlock: end,
            topics: [this.topic],
          });
          allLogs.push(...chunkLogs);
          const elapsedMs = Date.now() - startedAt;
          const chunkMs = Date.now() - chunkStartedAt;
          this.logger?.info(
            `[affiliate-fetch] chunk ${chunkIndex}/${totalChunks} range=${start}-${end} logs=${chunkLogs.length} totalLogs=${allLogs.length} chunkMs=${chunkMs} elapsedMs=${elapsedMs}`
          );
          break;
        } catch (err: any) {
          const msg = String(err?.message || err);
          const code = (err && (err.code ?? err.error?.code)) as any;
          const isTimeout =
            code === -32016 ||
            msg.includes("timeout") ||
            msg.includes("canceled") ||
            msg.includes("cancelled");
          this.logger?.warn(
            `[affiliate-fetch] chunk ${chunkIndex}/${totalChunks} range=${start}-${end} failed attempt=${attempt + 1}/${this.maxRetries + 1} code=${String(code ?? "unknown")} error=${msg}`
          );
          if (!isTimeout || attempt >= this.maxRetries) {
            throw err;
          }
          attempt++;
          if (this.retryDelayMs > 0) {
            await new Promise((res) => setTimeout(res, this.retryDelayMs));
          }
        }
      }
      start = end + 1;
    }

    const targetLc = targetGroup.toLowerCase();

    const events: AffiliateGroupChanged[] = allLogs
      .map((l) => {
        const decoded = this.iface.decodeEventLog(
          "AffiliateGroupChanged",
          l.data,
          l.topics
        ) as unknown as { human: string; oldGroup: string; newGroup: string };

        const human = String(decoded.human);
        const oldGroup = String(decoded.oldGroup);
        const newGroup = String(decoded.newGroup);

        return {
          blockNumber: l.blockNumber!,
          txHash: l.transactionHash!,
          human,
          oldGroup,
          newGroup,
        } satisfies AffiliateGroupChanged;
      })
      .filter(
        (e) =>
          e.oldGroup.toLowerCase() === targetLc ||
          e.newGroup.toLowerCase() === targetLc
      );

    this.logger?.info(
      `[affiliate-fetch] done range=${fromBlock}-${latest} rawLogs=${allLogs.length} matchingEvents=${events.length} elapsedMs=${Date.now() - startedAt}`
    );

    return events;
  }
}
