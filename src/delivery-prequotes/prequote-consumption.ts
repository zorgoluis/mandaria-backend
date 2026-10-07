import type { DemandOwnerInput } from '../customers/demand-owner.js';
import { Injectable } from '@nestjs/common';

export const PREQUOTE_CONSUMPTION = Symbol('PREQUOTE_CONSUMPTION');
export type ConsumptionDecision =
  | { admitted: false; retryAt?: Date; code?: 'PREQUOTE_CONSUMPTION_LIMIT' }
  | { admitted: true; permit: ConsumptionPermit };
export interface ConsumptionPermit {
  /** A5 must durably mark possible consumption BEFORE returning; crashes are ambiguous. */
  start(): Promise<void>;
  /** DB-clock check immediately before routing; never renews start. */
  assertReady(): Promise<void>;
  /** Idempotent; must never refund consumed/ambiguous routing merely because publication failed. */
  finish(outcome: {
    routingStarted: boolean;
    published: boolean;
  }): Promise<void>;
}
export interface PrequoteConsumption {
  admit(
    integrationClientId: DemandOwnerInput,
    attemptKey?: string,
  ): Promise<ConsumptionDecision>;
}
/** Deny-only adapter retained for A4 regression; production binds durable A5 protection. */
@Injectable()
export class UnavailablePrequoteConsumption implements PrequoteConsumption {
  async admit(): Promise<ConsumptionDecision> {
    return { admitted: false };
  }
}
