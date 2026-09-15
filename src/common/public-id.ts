import type { Prisma } from '@prisma/client';

/** Formats a sequence value as PREFIX-000001 without truncating beyond six digits. */
export const formatPublicId = (prefix: string, value: bigint | number) =>
  `${prefix}-${String(value).padStart(6, '0')}`;

/**
 * Operational identifiers (MDR-, MQ-) come from dedicated PostgreSQL sequences read inside the
 * creating transaction: nextval never returns the same value twice, even concurrently.
 */
const SEQUENCES = {
  MDR: '"DeliveryRequest_publicId_seq"',
  MQ: '"DeliveryQuote_publicId_seq"',
} as const;
export async function nextPublicId(
  tx: Prisma.TransactionClient,
  prefix: keyof typeof SEQUENCES,
) {
  const [{ value }] = await tx.$queryRawUnsafe<{ value: bigint }[]>(
    `SELECT nextval('${SEQUENCES[prefix]}') AS value`,
  );
  return formatPublicId(prefix, value);
}
