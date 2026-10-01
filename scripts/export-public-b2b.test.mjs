import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicB2bDocument } from './export-public-b2b.mjs';
test('Public contract exposes only integration operations and reachable schemas', () => {
  const source = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  const doc = publicB2bDocument(source);
  assert.ok(doc.paths['/api/v1/delivery-prequotes/{publicId}/convert']);
  assert.ok(doc.paths['/api/v1/delivery-quotes/{publicId}/accept']);
  assert.ok(doc.paths['/api/v1/integrations/token']);
  assert.equal(Object.keys(doc.paths).some(p => /admin|provider|driver|auth\//.test(p)), false);
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ['integration-bearer']);
  assert.equal(Object.keys(doc.components.schemas).some(n => /WebhookSecret|Admin|CreditAccount/.test(n)), false);
  for (const [path, methods] of Object.entries(doc.paths)) for (const operation of Object.values(methods))
    assert.ok(path.endsWith('/integrations/token') || operation.security.some(s => 'integration-bearer' in s));
});
test('New unreviewed integration routes fail closed', () => {
  const source = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  source.paths['/api/v1/internal-secret'] = { get: { security: [{ 'integration-bearer': [] }] } };
  assert.throws(() => publicB2bDocument(source), /Unreviewed/);
});
