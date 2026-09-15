import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const hashSecret = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export function matchesSecret(value: string, hash: string) {
  const actual = Buffer.from(hashSecret(value));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
