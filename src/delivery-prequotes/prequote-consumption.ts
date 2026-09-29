import { Injectable } from '@nestjs/common';

export const PREQUOTE_CONSUMPTION = Symbol('PREQUOTE_CONSUMPTION');
export type ConsumptionDecision =
  | { admitted: false; retryAt?: Date }
  | { admitted: true; permit: ConsumptionPermit };
export interface ConsumptionPermit {
  /** A5 must durably mark possible consumption BEFORE returning; crashes are ambiguous. */
  start(): Promise<void>;
  /** Idempotent; must never refund consumed/ambiguous routing merely because publication failed. */
  finish(outcome: {
    routingStarted: boolean;
    published: boolean;
  }): Promise<void>;
}
export interface PrequoteConsumption {
  admit(integrationClientId: string): Promise<ConsumptionDecision>;
}
/** Intentionally no configuration bypass. Replace with shared protection in A5. */
@Injectable()
export class UnavailablePrequoteConsumption implements PrequoteConsumption {
  async admit(): Promise<ConsumptionDecision> {
    return { admitted: false };
  }
}
