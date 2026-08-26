import {ILoggerService} from "../interfaces/ILoggerService";
import {ISlackService, SlackSeverity} from "../interfaces/ISlackService";

/**
 * Boot-time Safe ownership check, shared by every worker that signs through a
 * Safe.
 *
 * A signer that is not a registered owner cannot produce a valid signature, so
 * every write the worker attempts will revert. Failing at boot turns that into
 * one loud alert instead of a revert per poll cycle, which is why this exits
 * rather than continuing degraded.
 *
 * `validate` is optional because `IGroupService.validateSafeOwnership` is only
 * implemented by the Safe-backed services; EOA workers pass `undefined` and the
 * check is skipped.
 */
export async function validateSafeOwnershipOrExit(options: {
  validate: (() => Promise<void>) | undefined;
  /** Worker name as it should read in the Slack alert, e.g. "router-tms". */
  appLabel: string;
  logger: ILoggerService;
  slack: ISlackService;
}): Promise<void> {
  const {validate, appLabel, logger, slack} = options;
  if (!validate) return;

  try {
    await validate();
    logger.info("Safe ownership validation passed — signer is a registered owner.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Safe ownership validation FAILED: ${message}`);
    try {
      await slack.notifySlackStartOrCrash(
        `🚨 *${appLabel} Safe ownership check failed*\n\n${message}`,
        SlackSeverity.CRITICAL
      );
    } catch (slackError) {
      logger.warn("Failed to send Slack ownership failure notification:", slackError);
    }
    process.exit(1);
  }
}
