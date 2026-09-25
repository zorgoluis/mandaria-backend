import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '@prisma/client';

/**
 * A Prisma Client generated for the schema as it was *before* the award integrity boundary
 * (V1.10-D). `scripts/verify-award-boundary.mjs` reconstructs that historical working copy and
 * generates its client into it, so this module does not exist in a clean checkout: it only appears
 * once that script has run, which is why it must be loaded at runtime and cannot be imported
 * statically. A static import made `tsc` depend on whatever a previous CHECK happened to leave on
 * the machine.
 *
 * The check genuinely needs this client and not the current one. It reads every Dispatch before
 * applying the boundary migration and again afterwards, and asserts the rows are identical; a
 * current client would select `creditMode`, which does not exist yet, and would then compare a
 * column the migration is supposed to add. Selecting through the historical client is exactly what
 * expresses "compare only the columns that already existed".
 */
export type PreBoundaryPrismaClient = Omit<
  PrismaClient,
  'dispatchPreEnforcementAward'
>;

const CLIENT_PATH =
  '.tmp/check-v110d/previous-c/node_modules/@prisma/client/index.js';

/** Loads that generated client, failing with the reason instead of a module resolution error. */
export async function preBoundaryPrismaClient(
  datasourceUrl: string,
): Promise<PreBoundaryPrismaClient> {
  const url = pathToFileURL(resolve(CLIENT_PATH)).href;
  const loaded = (await import(url).catch(() => {
    throw new Error(
      `${CLIENT_PATH} is missing: run scripts/verify-award-boundary.mjs, which builds the historical working copy this check compares against`,
    );
  })) as {
    PrismaClient: new (options: {
      datasourceUrl: string;
    }) => PreBoundaryPrismaClient;
  };
  return new loaded.PrismaClient({ datasourceUrl });
}
