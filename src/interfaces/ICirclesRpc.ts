import {ILoggerService} from "./ILoggerService";

/** Base shape for Circles events returned by the circles_events RPC method. */
export interface CirclesBaseEvent {
  $event?: string;
  blockNumber: number;
  timestamp?: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash?: string;
}

export interface BackingCompletedEvent extends CirclesBaseEvent {
  backer: string;
  circlesBackingInstance: string;
  lbp: string;
  emitter: string;
}

export interface BackingInitiatedEvent extends CirclesBaseEvent {
  backer: string;
  circlesBackingInstance: string;
  emitter: string;
}

/**
 * Provides access to Circles events and data.
 */
export interface ICirclesRpc {
  fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<BackingInitiatedEvent[]>;
  fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<BackingCompletedEvent[]>;
  fetchAllTrustees(truster: string): Promise<string[]>;
  fetchAllBaseGroups(pageSize?: number): Promise<string[]>;
  isHuman(address: string): Promise<boolean>;
  isHumanBatch(addresses: string[]): Promise<Map<string, boolean>>;
  fetchAllHumanAvatars(pageSize?: number, logger?: ILoggerService): Promise<string[]>;
}
