import { createHmac, timingSafeEqual } from 'node:crypto';

// Receiver example, not a Mandaria endpoint. Capture bytes BEFORE JSON parsing.
// maxAgeSeconds is the receiver's chosen replay window, not a Mandaria requirement.
export function verifyMandariaWebhook({
  rawBody,
  timestamp,
  signature,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300,
}) {
  if (
    !Buffer.isBuffer(rawBody) ||
    typeof secret !== 'string' ||
    !secret ||
    typeof timestamp !== 'string' ||
    !/^\d{1,12}$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^v1=[0-9a-f]{64}$/.test(signature) ||
    !Number.isSafeInteger(nowSeconds) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 0
  )
    return false;
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    Math.abs(nowSeconds - seconds) > maxAgeSeconds
  )
    return false;
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.', 'utf8')
    .update(rawBody)
    .digest();
  const received = Buffer.from(signature.slice(3), 'hex');
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
