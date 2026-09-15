import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import type { OpenAPIObject } from '@nestjs/swagger';

const check = process.argv.includes('--check');
if (check) {
  const build = spawnSync(
    process.execPath,
    ['node_modules/@nestjs/cli/bin/nest.js', 'build'],
    { stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const { createOpenApiDocument } = await import('../dist/openapi.cli.js');
const document: OpenAPIObject = check
  ? await createOpenApiDocument()
  : JSON.parse(await readFile('docs/openapi.json', 'utf8'));
const escape = (value: string) =>
  value.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
const lines = [
  '# API Access — Mandaria',
  '',
  'Generado por `npm run docs:openapi`. No editar manualmente.',
  '',
  'Los roles y scopes se obtienen de los decorators del backend. El perfil del proveedor requiere además una membership vigente; los guards validan estado y asociación en cada petición.',
  '',
  '| Método | Ruta | Autenticación | Roles globales | Scopes | Operación |',
  '|---|---|---|---|---|---|',
];
for (const [path, item] of Object.entries(document.paths).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  for (const method of [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'options',
    'head',
  ] as const) {
    const operation = item?.[method];
    if (!operation) continue;
    const extra = operation as typeof operation & {
      'x-roles'?: string[];
      'x-scopes'?: string[];
    };
    const security = (operation.security ?? document.security ?? []).flatMap(
      (entry) => Object.keys(entry),
    );
    const cells = [
      method.toUpperCase(),
      path,
      security.join(', ') || 'Pública',
      extra['x-roles']?.join(', ') || '—',
      extra['x-scopes']?.join(', ') || '—',
      operation.summary || operation.operationId || '—',
    ];
    lines.push('| ' + cells.map(escape).join(' | ') + ' |');
  }
}
const artifacts = {
  'docs/openapi.json': JSON.stringify(document, null, 2) + '\n',
  'docs/API_ACCESS.md': lines.join('\n') + '\n',
};
for (const [path, expected] of Object.entries(artifacts)) {
  if (check) {
    const actual = await readFile(path, 'utf8').catch(() => '');
    if (actual.replaceAll('\r\n', '\n') !== expected) {
      console.error(`${path} is outdated. Run npm run docs:openapi.`);
      process.exitCode = 1;
    }
  } else {
    await writeFile(path, expected);
  }
}
if (!process.exitCode)
  console.log(
    check ? 'API documentation is up to date.' : 'Generated docs/API_ACCESS.md',
  );
