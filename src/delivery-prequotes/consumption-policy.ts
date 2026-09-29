import type { PrequoteConsumptionPermit } from '@prisma/client';
export type ConsumptionLimits = {
  minute: number;
  day: number;
  concurrent: number;
  globalUnits: number;
  reserveMs: number;
  retries: number;
  timeoutMs: number;
};
export const routingProtectionMs = (
  c: Pick<ConsumptionLimits, 'retries' | 'timeoutMs'>,
) => c.timeoutMs * (c.retries + 1) + 100 * c.retries * (c.retries + 1) + 15000;
export function validateConsumptionLimits(c: ConsumptionLimits) {
  for (const [value, min, max] of [
    [c.minute, 1, 10000],
    [c.day, 1, 1000000],
    [c.concurrent, 1, 100],
    [c.globalUnits, c.retries + 1, 1000000],
    [c.reserveMs, 1000, 300000],
    [c.retries, 0, 2],
    [c.timeoutMs, 1000, 15000],
  ])
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error('Invalid MPQ consumption configuration');
  return c;
}
type Entry = { units: number; until: number };
function availableAt(
  entries: Entry[],
  limit: number,
  need: number,
  now: number,
) {
  let used = entries.reduce((n, r) => n + r.units, 0);
  if (used + need <= limit) return now;
  for (const e of entries.sort((a, b) => a.until - b.until)) {
    used -= e.units;
    if (used + need <= limit) return e.until;
  }
  return Infinity;
}
/** Single ledger projection; DB supplies now and rows. No in-memory quota authority. */
export function consumptionRetryAt(
  rows: Pick<
    PrequoteConsumptionPermit,
    | 'integrationClientId'
    | 'state'
    | 'reserveExpiresAt'
    | 'startedAt'
    | 'protectedUntil'
    | 'units'
  >[],
  integrationId: string,
  c: ConsumptionLimits,
  now: Date,
) {
  const t = now.getTime();
  const window = (ms: number, own: boolean, weighted: boolean): Entry[] =>
    rows
      .filter((r) => !own || r.integrationClientId === integrationId)
      .flatMap((r) => {
        const until = r.startedAt
          ? r.startedAt.getTime() + ms
          : r.state === 'RESERVED'
            ? r.reserveExpiresAt.getTime()
            : 0;
        return until > t ? [{ units: weighted ? r.units : 1, until }] : [];
      });
  const slots = rows
    .filter((r) => r.integrationClientId === integrationId)
    .flatMap((r) => {
      const until = r.startedAt
        ? r.protectedUntil!.getTime()
        : r.state === 'RESERVED'
          ? r.reserveExpiresAt.getTime()
          : 0;
      return until > t ? [{ units: 1, until }] : [];
    });
  const retry = Math.max(
    availableAt(window(60000, true, false), c.minute, 1, t),
    availableAt(window(86400000, true, false), c.day, 1, t),
    availableAt(slots, c.concurrent, 1, t),
    availableAt(window(86400000, false, true), c.globalUnits, c.retries + 1, t),
  );
  return retry > t ? new Date(retry) : undefined;
}
