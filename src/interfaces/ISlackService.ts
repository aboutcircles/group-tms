import {BackingInitiatedEvent} from "./ICirclesRpc";

export enum SlackSeverity {
    CRITICAL = "critical",
    WARNING = "warning",
    INFO = "info"
}

export interface ISlackService {

    notifyBackingNotCompleted(backingInitiatedEvent: BackingInitiatedEvent, reason: string): Promise<void>;

    notifySlackStartOrCrash(message: string, severity?: SlackSeverity): Promise<void>;
}