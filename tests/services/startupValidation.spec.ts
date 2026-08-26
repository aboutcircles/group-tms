import {SlackSeverity} from "../../src/interfaces/ISlackService";
import {validateSafeOwnershipOrExit} from "../../src/services/startupValidation";
import {FakeLogger, FakeSlack} from "../../fakes/fakes";

/** Stand-in for process.exit that stops execution the way the real one does. */
class ProcessExited extends Error {
  constructor(public readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

describe("validateSafeOwnershipOrExit", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new ProcessExited(code as number | undefined);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("skips the check when the service cannot validate ownership (EOA workers)", async () => {
    const logger = new FakeLogger();
    const slack = new FakeSlack();

    await validateSafeOwnershipOrExit({validate: undefined, appLabel: "gp-crc", logger, slack});

    expect(logger.logs).toHaveLength(0);
    expect(slack.generalNotifications).toHaveLength(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("continues when the signer is a registered owner", async () => {
    const logger = new FakeLogger();
    const slack = new FakeSlack();
    const validate = jest.fn().mockResolvedValue(undefined);

    await validateSafeOwnershipOrExit({validate, appLabel: "gp-crc", logger, slack});

    expect(validate).toHaveBeenCalledTimes(1);
    expect(logger.logs.filter((l) => l.level === "info")).toHaveLength(1);
    expect(slack.generalNotifications).toHaveLength(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("alerts with the app label and exits 1 when validation fails", async () => {
    const logger = new FakeLogger();
    const slack = new FakeSlack();
    const validate = jest.fn().mockRejectedValue(new Error("signer 0xabc is not an owner"));

    await expect(
      validateSafeOwnershipOrExit({validate, appLabel: "Router-TMS", logger, slack})
    ).rejects.toBeInstanceOf(ProcessExited);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(slack.generalNotifications).toEqual([{
      message: "🚨 *Router-TMS Safe ownership check failed*\n\nsigner 0xabc is not an owner",
      severity: SlackSeverity.CRITICAL
    }]);
    expect(logger.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("still exits when the Slack alert itself fails", async () => {
    const logger = new FakeLogger();
    const slack = new FakeSlack();
    jest.spyOn(slack, "notifySlackStartOrCrash").mockRejectedValue(new Error("webhook 500"));
    const validate = jest.fn().mockRejectedValue(new Error("not an owner"));

    await expect(
      validateSafeOwnershipOrExit({validate, appLabel: "crc-backers", logger, slack})
    ).rejects.toBeInstanceOf(ProcessExited);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.logs.some((l) => l.level === "warn")).toBe(true);
  });
});
