import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  publicB2bDocument,
  serializePublicB2b,
  checkPublicB2b,
} from './export-public-b2b.mjs';
const source = () => JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
test('V1.17 exposes B2B terms and consent while excluding human demand, collection and administrative policy', () => {
  const full = source(),
    d = publicB2bDocument(full);
  assert.ok(full.paths['/api/v1/customer/delivery-prequotes']);
  assert.ok(
    full.paths['/api/v1/driver/dispatches/{dispatchId}/shipping-collection'],
  );
  assert.ok(full.paths['/api/v1/admin/integrations/{id}/shipping-policy']);
  for (const route of Object.keys(d.paths))
    assert.doesNotMatch(route, /\/customer|\/driver\/|\/admin\//);
  assert.deepEqual(
    d.components.schemas.ShippingTermsResponse.properties.payer.enum,
    ['REQUESTER', 'RECIPIENT'],
  );
  assert.ok(
    d.components.schemas.DeliveryStatusResponse.properties.shippingPayment,
  );
  assert.deepEqual(
    d.components.schemas.CustomerAuthorizationDto.properties.version.enum,
    [1, 2],
  );
  assert.ok(
    d.components.schemas.CustomerAuthorizationDto.properties.shippingTermsHash,
  );
  assert.ok(
    !d.components.schemas.ShippingPaymentResponse.properties.payerContact,
  );
  for (const name of [
    'DirectConversionDto',
    'CustomerProfileViewDto',
    'ShippingCollectionDto',
    'ShippingPolicyDto',
  ])
    assert.ok(!d.components.schemas[name]);
});
const path = '/api/v1/delivery-prequotes';
const expected = [
  'POST /api/v1/integrations/token',
  'GET /api/v1/integrations/me',
  'GET /api/v1/integrations/scope-check',
  'POST /api/v1/delivery-requests',
  'GET /api/v1/delivery-requests',
  'GET /api/v1/delivery-requests/{publicId}',
  'GET /api/v1/delivery-requests/{publicId}/status',
  'POST /api/v1/delivery-requests/{publicId}/cancel',
  'POST /api/v1/delivery-requests/{publicId}/quotes',
  'GET /api/v1/delivery-requests/{publicId}/quotes',
  'GET /api/v1/delivery-quotes/{publicId}',
  'POST /api/v1/delivery-quotes/{publicId}/accept',
  'POST /api/v1/delivery-prequotes',
  'GET /api/v1/delivery-prequotes/{publicId}',
  'POST /api/v1/delivery-prequotes/{publicId}/convert',
].sort();
const keys = (doc) =>
  Object.entries(doc.paths)
    .flatMap(([p, methods]) =>
      Object.keys(methods)
        .filter((m) => m !== 'parameters')
        .map((m) => `${m.toUpperCase()} ${p}`),
    )
    .sort();
const op = (s) => s.paths[path].post;

test('public execution progress is additive and excludes private custody audit', () => {
  const d = publicB2bDocument(source());
  assert.deepEqual(
    Object.keys(
      d.components.schemas.PublicExecutionProgressResponse.properties,
    ).sort(),
    ['attentionRequired', 'phase', 'registeredAt', 'revision'],
  );
  assert.deepEqual(
    Object.keys(
      d.components.schemas.PublicExecutionOutcomeResponse.properties,
    ).sort(),
    ['occurredAt', 'type'],
  );
  for (const name of [
    'ExecutionResponse',
    'ResolutionAuditResponse',
    'IncidentRecordResponse',
    'ResolveCustodyIncidentDto',
  ])
    assert.equal(d.components.schemas[name], undefined);
  assert.equal(
    Object.keys(d.paths).some(
      (p) => p.includes('custody') || p.includes('execution-events'),
    ),
    false,
  );
});
test('exact independently specified public operations; original source unchanged', () => {
  const s = source(),
    before = JSON.stringify(s),
    d = publicB2bDocument(s);
  assert.deepEqual(keys(d), expected);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(Object.keys(d.components.securitySchemes), [
    'integration-bearer',
  ]);
  assert.equal(d.servers[0].url, 'https://mandaria.com.mx');
});
for (const [m, p] of [
  ['get', '/api/v1/internal-secret'],
  ['delete', '/api/v1/delivery-prequotes'],
  ['post', '/api/v1/delivery-requests/{publicId}/internal'],
]) {
  test(`reject new method/route ${m} ${p}`, () => {
    const s = source();
    (s.paths[p] ??= {})[m] = { security: [{ 'integration-bearer': [] }] };
    assert.throws(() => publicB2bDocument(s), /Unreviewed B2B operation/);
  });
}
test('detect missing approved operation and changed authentication', () => {
  const s = source();
  delete s.paths[path].post;
  assert.throws(() => publicB2bDocument(s), /Missing approved/);
  const t = source();
  op(t).security = [];
  assert.throws(() => publicB2bDocument(t), /security/);
});
test('inherit root B2B security and materialize it; explicit operation security wins', () => {
  const s = source();
  s.security = [{ 'integration-bearer': [] }];
  // Existing public token remains explicitly public; preserve others exactly.
  s.paths['/api/v1/integrations/token'].post.security = [];
  for (const methods of Object.values(s.paths))
    for (const [m, o] of Object.entries(methods))
      if (
        ['get', 'post', 'put', 'patch', 'delete'].includes(m) &&
        !Object.hasOwn(o, 'security')
      )
        o.security = [];
  delete op(s).security;
  assert.deepEqual(publicB2bDocument(s).paths[path].post.security, [
    { 'integration-bearer': [] },
  ]);
  s.paths['/api/v1/new-machine'] = { get: {} };
  assert.throws(() => publicB2bDocument(s), /Unreviewed B2B/);
});
test('explicit B2B overrides root human authentication', () => {
  const s = source();
  s.security = [{ bearer: [] }];
  s.paths['/api/v1/integrations/token'].post.security = [];
  assert.deepEqual(publicB2bDocument(s).paths[path].post.security, [
    { 'integration-bearer': [] },
  ]);
});
for (const security of [
  [{ 'integration-bearer': [], bearer: [] }],
  [{ 'integration-bearer': [] }, { bearer: [] }],
  [{ 'integration-bearer': [] }, {}],
  [{ 'integration-bearer': ['unexpected'] }],
  null,
  {},
]) {
  test(`reject ambiguous/malformed security ${JSON.stringify(security)}`, () => {
    const s = source();
    op(s).security = security;
    assert.throws(() => publicB2bDocument(s), /security/);
  });
}
test('token cannot inherit protected security', () => {
  const s = source();
  s.security = [{ bearer: [] }];
  delete s.paths['/api/v1/integrations/token'].post.security;
  assert.throws(() => publicB2bDocument(s), /security/);
});
test('preserve path parameters, referenced parameter, request body, response schema and headers', () => {
  const s = source();
  s.components.parameters = {
    Shared: { name: 'cursor', in: 'query', schema: { type: 'string' } },
  };
  s.paths[path].parameters = [{ $ref: '#/components/parameters/Shared' }];
  op(s).responses['201'].headers = {
    'X-Example': { schema: { type: 'integer' } },
  };
  const d = publicB2bDocument(s);
  assert.deepEqual(d.paths[path].parameters, s.paths[path].parameters);
  assert.deepEqual(
    d.components.parameters.Shared,
    s.components.parameters.Shared,
  );
  assert.deepEqual(d.paths[path].post.parameters, op(s).parameters);
  assert.deepEqual(
    d.paths[path].post.requestBody.content,
    op(s).requestBody.content,
  );
  assert.deepEqual(
    d.paths[path].post.responses['201'].content,
    op(s).responses['201'].content,
  );
  assert.deepEqual(
    d.paths[path].post.responses['201'].headers,
    op(s).responses['201'].headers,
  );
});
test('transitive components, cycles, escaped JSON pointers and discriminator mappings resolve', () => {
  const s = source();
  s.components.parameters = {
    'cursor/a~b': {
      name: 'cursor',
      in: 'query',
      schema: { $ref: '#/components/schemas/IntegrationMeResponse' },
    },
  };
  s.paths[path].parameters = [{ $ref: '#/components/parameters/cursor~1a~0b' }];
  s.components.schemas.IntegrationMeResponse.properties.self = {
    $ref: '#/components/schemas/IntegrationMeResponse',
  };
  s.components.schemas.IntegrationMeResponse.discriminator = {
    propertyName: 'kind',
    mapping: { self: '#/components/schemas/IntegrationMeResponse' },
  };
  const d = publicB2bDocument(s);
  assert.ok(d.components.parameters['cursor/a~b']);
  assert.equal(
    d.components.schemas.IntegrationMeResponse.properties.self.$ref,
    '#/components/schemas/IntegrationMeResponse',
  );
});
test('reject broken, external and internal references', () => {
  for (const ref of [
    '#/components/schemas/Missing',
    'https://internal.example/schema',
    '#/components/schemas/AdminEventDetailResponse',
  ]) {
    const s = source();
    op(s).requestBody = { $ref: ref };
    assert.throws(() => publicB2bDocument(s), /reference|component/);
  }
});
test('exclude unused components/extensions and reject reachable internal marker', () => {
  const s = source();
  s.components.schemas.PrivateUnused = { type: 'string' };
  op(s)['x-internal-note'] = 'private';
  const d = publicB2bDocument(s);
  assert.equal(d.components.schemas.PrivateUnused, undefined);
  assert.equal(d.paths[path].post['x-internal-note'], undefined);
  assert.equal(d.components.schemas.AdminEventDetailResponse, undefined);
  s.components.schemas.CreatePrequoteDto['x-internal'] = true;
  assert.throws(() => publicB2bDocument(s), /Internal object/);
});
test('preserve schema fields named description and extension-like property names', () => {
  const s = source();
  s.components.schemas.CreatePrequoteDto.properties['x-client-field'] = {
    type: 'string',
  };
  const d = publicB2bDocument(s);
  assert.equal(
    d.components.schemas.CreatePrequoteDto.properties['x-client-field'].type,
    'string',
  );
  assert.equal(
    d.components.schemas.DeliveryPackageDto.properties.description.type,
    'string',
  );
});
test('unknown prose needs review; historical/internal operation prose is not published', () => {
  const s = source();
  op(s).description = 'INTERNAL_SQL_ONLY';
  const text = serializePublicB2b(s);
  assert.ok(!text.includes('INTERNAL_SQL_ONLY'));
  assert.ok(!/durante B|issuedAt interno|MAX_RETRIES|fencing/.test(text));
  s.components.schemas.CreatePrequoteDto.description = 'new unreviewed wording';
  assert.throws(() => publicB2bDocument(s), /Unreviewed public prose/);
});
test('reject unreviewed callback links rather than leak internal operations', () => {
  const s = source();
  op(s).callbacks = { hidden: {} };
  assert.throws(() => publicB2bDocument(s), /Unreviewed callbacks/);
});
test('detect stale artifact and changed constraints, allow only line-ending equivalence', () => {
  const s = source(),
    text = serializePublicB2b(s);
  assert.doesNotThrow(() => checkPublicB2b(s, text.replaceAll('\n', '\r\n')));
  assert.throws(() => checkPublicB2b(s, text + ' '), /stale/);
  s.components.schemas.CreatePrequoteDto.properties.conditionsVersion.description =
    undefined;
  s.components.schemas.CreatePrequoteDto.properties.conditionsVersion.maximum = 2;
  assert.throws(() => checkPublicB2b(s, text), /stale/);
});

test('every generated reference resolves and only reachable schemas are retained', () => {
  const d = publicB2bDocument(source());
  const visited = new Set();
  function walk(v) {
    if (!v || typeof v !== 'object') return;
    if (v.$ref) {
      const parts = v.$ref
        .slice(2)
        .split('/')
        .map((x) => x.replaceAll('~1', '/').replaceAll('~0', '~'));
      const target = parts.reduce((o, k) => o?.[k], d);
      assert.ok(target, v.$ref);
      if (!visited.has(v.$ref)) {
        visited.add(v.$ref);
        walk(target);
      }
    }
    Object.values(v).forEach(walk);
  }
  walk(d.paths);
  assert.deepEqual(
    Object.keys(d.components.schemas).sort(),
    [...visited]
      .filter((r) => r.startsWith('#/components/schemas/'))
      .map((r) => r.split('/')[3])
      .sort(),
  );
  const converted =
    d.components.schemas.PrequoteResponse.properties.deliveryQuotePublicId;
  assert.equal(converted.type, 'string');
  assert.equal(converted.nullable, true);
  assert.equal(converted.enum, undefined);
});

test('new anonymous operation under B2B namespace also requires review', () => {
  const s = source();
  s.paths['/api/v1/delivery-prequotes/debug'] = { get: { security: [] } };
  assert.throws(() => publicB2bDocument(s), /Unreviewed B2B/);
});

test('transitive requestBodies, responses, headers and examples survive references', () => {
  const s = source();
  s.components.requestBodies = {
    SharedBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CreatePrequoteDto' },
        },
      },
    },
  };
  s.components.headers = { SharedHeader: { schema: { type: 'string' } } };
  s.components.examples = {
    SharedExample: {
      value: { description: 'example data, not editorial prose' },
    },
  };
  s.components.responses = {
    SharedResponse: {
      description: '',
      headers: { 'X-Test': { $ref: '#/components/headers/SharedHeader' } },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PrequoteResponse' },
          examples: { one: { $ref: '#/components/examples/SharedExample' } },
        },
      },
    },
  };
  op(s).requestBody = { $ref: '#/components/requestBodies/SharedBody' };
  op(s).responses['201'] = { $ref: '#/components/responses/SharedResponse' };
  const d = publicB2bDocument(s);
  assert.deepEqual(d.components.requestBodies, s.components.requestBodies);
  assert.deepEqual(d.components.headers, s.components.headers);
  assert.deepEqual(d.components.examples, s.components.examples);
  assert.deepEqual(d.components.responses, s.components.responses);
});
test('unknown security scheme on an approved operation and internal path are rejected', () => {
  const s = source();
  op(s).security = [{ unknown: [] }];
  assert.throws(() => publicB2bDocument(s), /security/);
  const t = source();
  t.paths[path]['x-internal'] = true;
  assert.throws(() => publicB2bDocument(t), /Internal approved operation/);
});

test('human administrative compatibility aliases stay excluded', () => {
  const s = source();
  assert.deepEqual(s.paths['/api/v1/integrations'].get.security, [
    { bearer: [] },
  ]);
  const d = publicB2bDocument(s);
  assert.equal(d.paths['/api/v1/integrations'], undefined);
  s.paths['/api/v1/integrations'].get.security = [{ 'integration-bearer': [] }];
  assert.throws(() => publicB2bDocument(s), /Unreviewed B2B/);
});

test('explicit malformed root security is not treated as absent', () => {
  const s = source();
  s.security = null;
  delete op(s).security;
  assert.throws(() => publicB2bDocument(s), /Invalid security/);
});

test('confirmed origin composes every route with exactly one API prefix', () => {
  const d = publicB2bDocument(source());
  assert.equal(d.servers.length, 1);
  assert.equal(new URL(d.servers[0].url).pathname, '/');
  for (const route of Object.keys(d.paths)) {
    assert.ok(route.startsWith('/api/v1/'));
    const endpoint = new URL(d.servers[0].url + route);
    assert.equal(endpoint.origin, 'https://mandaria.com.mx');
    assert.equal(decodeURIComponent(endpoint.pathname), route);
    assert.equal(endpoint.pathname.split('/api/v1').length - 1, 1);
  }
  assert.equal(
    d.servers[0].url + '/api/v1/integrations/token',
    'https://mandaria.com.mx/api/v1/integrations/token',
  );
});

test('versioned tracking preserves old fields and excludes internal error vocabulary', () => {
  const d = publicB2bDocument(source());
  const schema = d.components.schemas.DeliveryStatusResponse;
  for (const key of [
    'publicVersion',
    'trackingMode',
    'assignmentState',
    'terminalOutcome',
  ]) {
    assert.ok(schema.required.includes(key));
    assert.ok(schema.properties[key]);
  }
  assert.equal(schema.properties.publicVersion.type, 'string');
  assert.equal(schema.properties.publicVersion.pattern, '^[1-9][0-9]*$');
  assert.ok(schema.properties.executionProgress);
  for (const document of [source(), d]) {
    const description =
      document.components.schemas.DeliveryStatusResponse.properties
        .executionProgress.description;
    assert.match(
      description,
      /Comparar publicVersion numéricamente por solicitud/,
    );
    assert.doesNotMatch(description, /Comparar revision/);
    assert.ok(
      document.components.schemas.PublicExecutionProgressResponse.properties
        .revision,
    );
  }
  assert.ok(schema.properties.executionOutcome);
  assert.ok(
    d.paths['/api/v1/delivery-requests/{publicId}/cancel'].post.responses[
      '409'
    ],
  );
  assert.ok(
    d.paths['/api/v1/delivery-requests/{publicId}/status'].get.responses['503'],
  );
  assert.ok(!JSON.stringify(d).includes('/api/v1/admin/providers'));
  assert.ok(!JSON.stringify(d).includes('maxDrivers'));
});

test('human recovery stays private and human response schemas reflect real nullable integrations and offers', () => {
  const full = source(),
    pub = publicB2bDocument(full);
  for (const [path, methods] of Object.entries({
    '/api/v1/customer/command-attempt': ['get'],
    '/api/v1/customer/command-attempt/close': ['post'],
    '/api/v1/customer/delivery-requests/{publicId}/consent-context': ['get'],
    '/api/v1/admin/integrations/{id}/shipping-policy/attempt': ['get'],
    '/api/v1/admin/integrations/{id}/shipping-policy/attempt/close': ['post'],
  })) {
    for (const method of methods)
      assert.deepEqual(full.paths[path][method].security, [{ bearer: [] }]);
    assert.equal(pub.paths[path], undefined);
  }
  assert.equal(pub.components.schemas.HumanAttemptResult, undefined);
  assert.ok(
    full.components.schemas.ShippingPaymentResponse.properties.instructionStatus.enum.includes(
      'OFFER',
    ),
  );
  for (const name of [
    'AdminDeliveryRequestSummaryResponse',
    'AdminDeliveryRequestResponse',
  ]) {
    assert.equal(
      full.components.schemas[name].properties.integrationClientId.nullable,
      true,
    );
    assert.equal(
      full.components.schemas[name].properties.integrationClient.nullable,
      true,
    );
  }
  assert.ok(full.components.schemas.ConsentContext.properties.shippingTerms);
});
