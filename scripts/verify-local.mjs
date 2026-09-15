import 'dotenv/config';
import assert from 'node:assert/strict';
const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
async function call(path, status, body, token) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status, `${path}: unexpected HTTP status`);
  return status === 204 ? undefined : response.json();
}
try {
  await call('/health', 200);
  const docs = await call('/docs-json', 200);
  assert.ok(docs.paths['/api/v1/auth/login']);
  const tokens = await call('/api/v1/auth/login', 200, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  const me = await call('/api/v1/auth/me', 200, undefined, tokens.accessToken);
  assert.equal(me.role, 'SUPER_ADMIN');
  assert.equal(me.passwordHash, undefined);
  await call('/api/v1/users', 200, undefined, tokens.accessToken);
  const next = await call('/api/v1/auth/refresh', 200, {
    refreshToken: tokens.refreshToken,
  });
  await call('/api/v1/auth/logout', 204, { refreshToken: next.refreshToken });
  await call('/api/v1/auth/refresh', 401, { refreshToken: next.refreshToken });
  console.log(
    'Local HTTP verification passed: health, Swagger, bootstrap login, me, roles, refresh and logout. No credentials printed.',
  );
} catch {
  console.error(
    'Local HTTP verification failed. Check the running backend and bootstrap configuration.',
  );
  process.exitCode = 1;
}
