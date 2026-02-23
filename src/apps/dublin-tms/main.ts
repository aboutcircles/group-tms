import {LoggerService} from "../../services/loggerService";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {GroupService} from "../../services/groupService";
import {SlackService} from "../../services/slackService";
import {IGroupService} from "../../interfaces/IGroupService";
import {
  runOnce,
  RunConfig,
  RunOutcome,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GROUP_BATCH_SIZE,
  DEFAULT_CONFIRMATION_BLOCKS
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";
import {getAddress, Wallet} from "ethers";
import {ensureRpcHealthyOrNotify} from "../../services/rpcHealthService";

const DEFAULT_RPC_URL = "https://rpc.aboutcircles.com/";
const DEFAULT_INVITATION_MODULE = "0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5";
const DEFAULT_TARGET_GROUP = "0xAeCda439CC8Ac2a2da32bE871E0C2D7155350f80";
const DEFAULT_SERVICE_EOA = "0x20a3C619De4C15E360d30F329DBCfe5bb618654f";
const DEFAULT_FROM_BLOCK = 44_591_039n; 
const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1_000;

const DEFAULT_ORIGIN_INVITERS = [
  "0xa63AbF03D5c6EF8D56E1432277573c47cBE8A8A6", // bijan
  "0x61AC0f4875f6BE819e5368cD87F3b1510bf07B39", // adz
  "0xED1AfB38731cE824D51e01EF733B0031b69fEAd9", // deep
  "0xf48554937f18885c7f15c432c596b5843648231D", //paul
  "0x4d9145DeF1647eFF0136205aB3034F5297b524AC"  //goncalo
] as const;

const verboseLogging = !!process.env.VERBOSE_LOGGING;
const rootLogger = new LoggerService(verboseLogging, "dublin-tms");

const rpcUrl = process.env.RPC_URL || DEFAULT_RPC_URL;
const invitationModuleAddress = DEFAULT_INVITATION_MODULE;
const targetGroupAddress = normalizeAddressOrThrow(
  process.env.DUBLIN_TMS_ADDRESS || DEFAULT_TARGET_GROUP,
  "DUBLIN_TMS_ADDRESS"
);
const configuredStartBlock = parseEnvBigInt("DUBLIN_TMS_START_BLOCK", DEFAULT_FROM_BLOCK);
const configuredToBlock = parseOptionalEnvBigInt("DUBLIN_TMS_TO_BLOCK");
const chunkSize = parseEnvBigInt("DUBLIN_TMS_CHUNK_SIZE", DEFAULT_CHUNK_SIZE);
const confirmationBlocks = parseEnvBigInt("DUBLIN_TMS_CONFIRMATION_BLOCKS", DEFAULT_CONFIRMATION_BLOCKS);
const groupBatchSize = parseEnvInt("DUBLIN_TMS_BATCH_SIZE", DEFAULT_GROUP_BATCH_SIZE);
const pollIntervalMs = parseEnvInt("DUBLIN_TMS_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
const originInviters = [...DEFAULT_ORIGIN_INVITERS];
const configuredServiceEoa = normalizeAddressOrThrow(
  process.env.DUBLIN_TMS_SERVICE_EOA || DEFAULT_SERVICE_EOA,
  "DUBLIN_TMS_SERVICE_EOA"
);

const dryRun = process.env.DRY_RUN === "1";
const servicePrivateKey = process.env.DUBLIN_TMS_SERVICE_PRIVATE_KEY || "";
const slackWebhookUrl = process.env.DUBLIN_TMS_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || "";

if (configuredToBlock !== undefined && configuredToBlock < configuredStartBlock) {
  throw new Error(
    `DUBLIN_TMS_TO_BLOCK (${configuredToBlock}) must be >= DUBLIN_TMS_START_BLOCK (${configuredStartBlock})`
  );
}

if (!dryRun && servicePrivateKey.trim().length === 0) {
  throw new Error("DUBLIN_TMS_SERVICE_PRIVATE_KEY is required when not running in dry-run mode");
}

const circlesRpc = new CirclesRpcService(rpcUrl);
const slackService = new SlackService(slackWebhookUrl);
const slackConfigured = slackWebhookUrl.trim().length > 0;

let groupService: IGroupService | undefined;
if (!dryRun) {
  const signerAddress = normalizeAddressOrThrow(new Wallet(servicePrivateKey).address, "DUBLIN_TMS_SERVICE_PRIVATE_KEY");
  if (signerAddress.toLowerCase() !== configuredServiceEoa.toLowerCase()) {
    throw new Error(
      `Configured DUBLIN_TMS_SERVICE_EOA (${configuredServiceEoa}) does not match signer address (${signerAddress}).`
    );
  }
  groupService = new GroupService(rpcUrl, servicePrivateKey);
}

const runLogger = rootLogger.child("run");
const staticConfig = {
  rpcUrl,
  invitationModuleAddress,
  targetGroupAddress,
  originInviters,
  chunkSize,
  groupBatchSize,
  confirmationBlocks,
  dryRun
};

let nextFromBlock = configuredStartBlock;

rootLogger.info("Starting dublin-tms watcher with config:");
rootLogger.info(`  - rpcUrl=${rpcUrl}`);
rootLogger.info(`  - invitationModuleAddress=${invitationModuleAddress}`);
rootLogger.info(`  - targetGroupAddress=${targetGroupAddress}`);
rootLogger.info(`  - configuredStartBlock=${configuredStartBlock}`);
rootLogger.info(`  - configuredToBlock=${configuredToBlock ?? "(live head - confirmations)"}`);
rootLogger.info(`  - chunkSize=${chunkSize}`);
rootLogger.info(`  - groupBatchSize=${groupBatchSize}`);
rootLogger.info(`  - confirmationBlocks=${confirmationBlocks}`);
rootLogger.info(`  - pollIntervalMs=${pollIntervalMs}`);
rootLogger.info(`  - originInviters=${originInviters.join(",")}`);
rootLogger.info(`  - dryRun=${dryRun}`);
rootLogger.info(`  - serviceEoa=${configuredServiceEoa}`);
rootLogger.info(`  - servicePrivateKeyConfigured=${servicePrivateKey.trim().length > 0}`);
rootLogger.info(`  - slackConfigured=${slackConfigured}`);

void notifySlackStartup();

process.on("SIGINT", async () => {
  await notifySlackShutdown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await notifySlackShutdown("SIGTERM");
  process.exit(0);
});

async function mainLoop(): Promise<void> {
  while (true) {
    if (configuredToBlock !== undefined && nextFromBlock > configuredToBlock) {
      rootLogger.info(`Reached configured TO_BLOCK ${configuredToBlock}. Stopping watcher loop.`);
      return;
    }

    try {
      await ensureRpcHealthyOrNotify({
        appName: "dublin-tms",
        rpcUrl,
        slackService,
        logger: rootLogger
      });
      const runConfig: RunConfig = {
        ...staticConfig,
        fromBlock: nextFromBlock,
        toBlock: configuredToBlock
      };

      const outcome = await runOnce(
        {
          circlesRpc,
          groupService,
          logger: runLogger
        },
        runConfig
      );

      nextFromBlock = outcome.nextFromBlock;

      runLogger.info(
        `run complete: scanned=[${outcome.fromBlock}..${outcome.toBlock}] chunks=${outcome.scannedChunks} ` +
        `matches=${outcome.matchedEventCount} uniqueHumans=${outcome.uniqueHumanCount} ` +
        `alreadyTrusted=${outcome.alreadyTrustedHumans.length} queued=${outcome.humansQueuedForTrust.length} ` +
        `txs=${outcome.trustTxHashes.length}`
      );

      await notifySlackRunSummary(outcome);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      rootLogger.error("dublin-tms run failed:");
      rootLogger.error(formatErrorWithCauses(error));
      await notifySlackRunError(error);
    }

    await delay(pollIntervalMs);
  }
}

async function start(): Promise<void> {
  await mainLoop();
}

start().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("dublin-tms service crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 **Dublin TMS service crashed**\n\nLast error: ${error.message}`
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const header = dryRun
    ? "🧪 **Dublin TMS Service started (dry-run)**"
    : "✅ **Dublin TMS Service started**";
  const message =
    `${header}\n\n` +
    `Watching RegisterHuman and trusting matching avatars.\n` +
    `- Target Group: ${targetGroupAddress}\n` +
    `- Service EOA: ${configuredServiceEoa}\n` +
    `- Origin Inviters: ${originInviters.join(", ")}\n` +
    `- Start Block: ${configuredStartBlock}\n` +
    `- Poll Interval (min): ${formatMinutes(pollIntervalMs)}\n` +
    `- Dry Run: ${dryRun}`;

  try {
    await slackService.notifySlackStartOrCrash(message);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (error) {
    rootLogger.warn("Failed to send Slack startup notification:", error);
  }
}

async function notifySlackShutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 **Dublin TMS Service shutting down**\n\nReceived ${signal}.`
    );
  } catch (error) {
    rootLogger.warn("Failed to send Slack shutdown notification:", error);
  }
}

async function notifySlackRunSummary(outcome: RunOutcome): Promise<void> {
  const hasChanges = outcome.humansQueuedForTrust.length > 0;
  const sentTx = outcome.trustTxHashes.length > 0;

  if (!hasChanges && !sentTx) {
    return;
  }

  const header = dryRun
    ? "🧪 **Dublin TMS Dry-Run Summary**"
    : "✅ **Dublin TMS Run Summary**";

  const lines: string[] = [
    header,
    "",
    `- Scanned Range: ${outcome.fromBlock}..${outcome.toBlock}`,
    `- Latest Block: ${outcome.latestBlock}`,
    `- Safe Head: ${outcome.safeHeadBlock}`,
    `- Matched RegisterHuman Events: ${outcome.matchedEventCount}`,
    `- Unique Humans Matched: ${outcome.uniqueHumanCount}`,
    `- Already Trusted: ${outcome.alreadyTrustedHumans.length}`,
    `- ${dryRun ? "Would Trust" : "Queued for Trust"}: ${outcome.humansQueuedForTrust.length}`
  ];

  const inviterCounts = Object.entries(outcome.originInviterCounts)
    .map(([inviter, count]) => `${inviter}: ${count}`)
    .join(" | ");
  if (inviterCounts.length > 0) {
    lines.push(`- Matches per Origin Inviter: ${inviterCounts}`);
  }

  if (outcome.humansQueuedForTrust.length > 0) {
    lines.push(`- ${dryRun ? "Would trust" : "Humans trusted"}: ${limitList(outcome.humansQueuedForTrust, 10)}`);
  }

  if (!dryRun && outcome.trustTxHashes.length > 0) {
    lines.push(`- Trust tx hashes: ${limitList(outcome.trustTxHashes, 5)}`);
  }

  try {
    await slackService.notifySlackStartOrCrash(lines.join("\n"));
  } catch (error) {
    rootLogger.warn("Failed to send Slack run summary notification:", error);
  }
}

async function notifySlackRunError(error: Error): Promise<void> {
  try {
    await slackService.notifySlackStartOrCrash(`⚠️ **Dublin TMS run failed**\n\n${error.message}`);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run-error notification:", slackError);
  }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    rootLogger.warn(`Invalid positive integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }

  return value;
}

function parseEnvBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  try {
    const value = BigInt(raw.trim());
    if (value < 0n) {
      throw new Error("negative value");
    }
    return value;
  } catch {
    rootLogger.warn(`Invalid non-negative integer for ${name}='${raw}', using fallback ${fallback}.`);
    return fallback;
  }
}

function parseOptionalEnvBigInt(name: string): bigint | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }

  try {
    const value = BigInt(raw.trim());
    if (value < 0n) {
      throw new Error("negative value");
    }
    return value;
  } catch {
    throw new Error(`Invalid non-negative integer for ${name}='${raw}'.`);
  }
}

function normalizeAddressOrThrow(value: string, envName: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Invalid address '${value}' in ${envName}.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return (Math.round(minutes * 100) / 100).toString();
}

function limitList(values: string[], limit: number): string {
  if (values.length <= limit) {
    return values.join(", ");
  }

  const shown = values.slice(0, limit).join(", ");
  return `${shown} (+${values.length - limit} more)`;
}
