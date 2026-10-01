import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyMandariaWebhook } from '../docs/examples/verify-mandaria-webhook.mjs';
const secret = 'fictional-test-only-not-a-production-secret';
const rawBody = Buffer.from('{"eventId":"example","name":"Envío"}');
const timestamp = '1790834400';
const signature =
  'v1=' +
  createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(rawBody)
    .digest('hex');
const valid = {
  rawBody,
  timestamp,
  signature,
  secret,
  nowSeconds: Number(timestamp),
};
test('receiver verifies exact UTF-8 bytes with the documented HMAC format', () =>
  assert.equal(verifyMandariaWebhook(valid), true));
test('tamper, reserialization, wrong key and malformed signature fail safely', () => {
  for (const patch of [
    { rawBody: Buffer.from('{ "eventId":"example","name":"Envío"}') },
    { secret: 'other' },
    { signature: 'v1=ab' },
    { signature: 'v2=' + signature.slice(3) },
    { signature: ['duplicate', signature] },
    { rawBody: {} },
    { timestamp: ['1', '2'] },
  ])
    assert.equal(verifyMandariaWebhook({ ...valid, ...patch }), false);
});
test('stale/future timestamp and invalid receiver window fail', () => {
  for (const patch of [
    { nowSeconds: Number(timestamp) + 301 },
    { nowSeconds: Number(timestamp) - 301 },
    { maxAgeSeconds: -1 },
    { timestamp: 'NaN' },
  ])
    assert.equal(verifyMandariaWebhook({ ...valid, ...patch }), false);
});
test('a later retry has a new timestamp and needs its new signature', () => {
  const later = String(Number(timestamp) + 600);
  assert.equal(
    verifyMandariaWebhook({
      ...valid,
      timestamp: later,
      nowSeconds: Number(later),
    }),
    false,
  );
  const signed =
    'v1=' +
    createHmac('sha256', secret)
      .update(later + '.')
      .update(rawBody)
      .digest('hex');
  assert.equal(
    verifyMandariaWebhook({
      ...valid,
      timestamp: later,
      signature: signed,
      nowSeconds: Number(later),
    }),
    true,
  );
});
