import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publicB2bDocument(source) {
  const paths = {};
  for (const [path, methods] of Object.entries(source.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const token = path === '/api/v1/integrations/token' && method === 'post';
      const b2b = operation.security?.some(s => Object.hasOwn(s, 'integration-bearer'));
      if (!token && !b2b) continue;
      if (!/^\/api\/v1\/(integrations\/(token|me|scope-check)|delivery-(requests|quotes|prequotes)(\/.*)?)$/.test(path))
        throw new Error(`Unreviewed public B2B route: ${path}`);
      (paths[path] ??= {})[method] = structuredClone(operation);
    }
  }
  const components = { securitySchemes: { 'integration-bearer': source.components.securitySchemes['integration-bearer'] } };
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(value.$ref);
      if (!match) throw new Error(`Unsupported reference ${value.$ref}`);
      const [, group, name] = match;
      if (!components[group]?.[name]) {
        const schema = source.components[group]?.[name];
        if (!schema) throw new Error(`Missing reference ${value.$ref}`);
        (components[group] ??= {})[name] = structuredClone(schema);
        visit(schema);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(paths);
  return { openapi: source.openapi, info: { title: 'Mandaria — API B2B', version: source.info.version,
    description: 'Contrato público B2B. Acceso server-to-server; las credenciales se provisionan por administración. Incluye precotización, conversión y aceptación autorizada V1.13.' },
    servers: [{ url: '/', description: 'Origen de tu entorno Mandaria; las rutas incluyen /api/v1.' }], paths, components };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = JSON.stringify(publicB2bDocument(JSON.parse(readFileSync('docs/openapi.json', 'utf8'))), null, 2) + '\n';
  const destination = 'docs/openapi-b2b.json';
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8').replaceAll('\r\n', '\n') !== text) throw new Error('B2B OpenAPI stale; run npm run docs:b2b');
  } else writeFileSync(destination, text);
  console.log('Public B2B contract verified');
}
