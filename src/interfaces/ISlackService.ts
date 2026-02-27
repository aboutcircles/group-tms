import {CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";

export enum SlackSeverity {
    CRITICAL = "critical",
    WARNING = "warning",
    INFO = "info"
}

export interface ISlackService {

    notifyBackingNotCompleted(backingInitiatedEvent: CrcV2_CirclesBackingInitiated, reason: string): Promise<void>;

    notifySlackStartOrCrash(message: string, severity?: SlackSeverity): Promise<void>;
}