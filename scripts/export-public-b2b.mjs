import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const prose = JSON.parse(
  readFileSync(new URL('./public-b2b-prose.json', import.meta.url), 'utf8'),
);
const bearer = 'integration-bearer';
const methods = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
]);
// Explicit method + path approval. Prefix matching is deliberately insufficient.
export const APPROVED_OPERATIONS = [
  [
    'post',
    '/api/v1/integrations/token',
    'issueToken',
    'Obtener token B2B',
    'Intercambia clientId y clientSecret por un Bearer temporal. Las credenciales pertenecen al sistema, no a una persona. No hay refresh token B2B.',
  ],
  [
    'get',
    '/api/v1/integrations/me',
    'integrationProfile',
    'Consultar mi integración',
    'Devuelve metadata segura y scopes de la integración autenticada.',
  ],
  [
    'get',
    '/api/v1/integrations/scope-check',
    'checkScope',
    'Comprobar permiso de lectura',
    'Comprueba deliveries:read sin crear ni modificar solicitudes.',
  ],
  [
    'post',
    '/api/v1/delivery-requests',
    'createRequest',
    'Crear solicitud directa',
    'Flujo directo, separado de la conversión de precotizaciones. Requiere Idempotency-Key estable por intención. externalReference no es única. No cotiza ni reserva capacidad.',
  ],
  [
    'get',
    '/api/v1/delivery-requests',
    'listRequests',
    'Listar mis solicitudes',
    'Lista paginada de solicitudes propias con los filtros documentados.',
  ],
  [
    'get',
    '/api/v1/delivery-requests/{publicId}',
    'getRequest',
    'Consultar mi solicitud',
    'Consulta la solicitud propia por su identificador MDR.',
  ],
  [
    'get',
    '/api/v1/delivery-requests/{publicId}/status',
    'requestStatus',
    'Consultar estado logístico',
    'Estado público e identidad visible de ejecución. DELIVERED significa entrega física, no confirmación de cobro.',
  ],
  [
    'post',
    '/api/v1/delivery-requests/{publicId}/cancel',
    'cancelRequest',
    'Cancelar mi solicitud',
    'Repetir sobre la misma MDR conserva fecha y razón originales. Admite cotización convertida vencida. Antes de reemplazar: confirmar MDR CANCELLED con cancelledAt y estado público CANCELLED/EXPIRED con deliveredAt null. Un 200 no descarta entrega previa. No continuar ante resultado incierto; no implica reembolso ni otra transferencia de comida.',
  ],
  [
    'post',
    '/api/v1/delivery-requests/{publicId}/quotes',
    'createQuote',
    'Cotizar solicitud directa',
    'Cotiza una solicitud del flujo directo. No permite recotizar una solicitud convertida desde MPQ.',
  ],
  [
    'get',
    '/api/v1/delivery-requests/{publicId}/quotes',
    'listQuotes',
    'Listar cotizaciones propias',
    'Lista las cotizaciones de la solicitud propia; no modifica precios ni vencimientos.',
  ],
  [
    'get',
    '/api/v1/delivery-quotes/{publicId}',
    'getQuote',
    'Consultar cotización',
    'Consulta importe, moneda y vencimiento de la MQ propia. El precio del envío no incluye mercancía.',
  ],
  [
    'post',
    '/api/v1/delivery-quotes/{publicId}/accept',
    'acceptQuote',
    'Aceptar cotización',
    'MQ convertida: Idempotency-Key y customerAuthorization obligatorios sobre MQ, importe, moneda y vencimiento exactos, con consentimiento posterior a conversión. Mandaria recibe la atestación del integrador; no verifica directamente el consentimiento humano. Replay exacto con credencial y scopes vigentes no reabre el servicio, incluso tras vencimiento, cancelación o deshabilitación. Flujo directo conserva body vacío. Aceptar publica el servicio de forma atómica; no confirma entrega ni cobro.',
  ],
  [
    'post',
    '/api/v1/delivery-prequotes',
    'createPrequote',
    'Emitir o recuperar precotización',
    'FOOD/LOCAL_DELIVERY/MXN, conditionsVersion=1. Requiere Idempotency-Key. 201 inicial y 200 replay; no renueva vigencia ni reserva capacidad. Puede recuperarse una intención ya publicada aunque la emisión esté deshabilitada. Respetar Retry-After cuando esté presente; cuotas y concurrencia dependen del entorno.',
  ],
  [
    'get',
    '/api/v1/delivery-prequotes/{publicId}',
    'getPrequote',
    'Consultar precotización',
    'Consulta MPQ propia y sus vínculos de conversión. No renueva vigencia.',
  ],
  [
    'post',
    '/api/v1/delivery-prequotes/{publicId}/convert',
    'convertPrequote',
    'Convertir precotización una sola vez',
    'Requiere todos los scopes indicados e Idempotency-Key. Crea atómicamente MDR PREPAID y MQ OFFERED conservando precio y vencimiento de MPQ. Registra confirmaciones declaradas del restaurante, no verificación bancaria. No acepta MQ ni reserva capacidad. Replay devuelve los mismos vínculos y estados actuales; cancelar no libera la MPQ. La MQ requiere aceptación autorizada separada.',
  ],
];
const approved = new Map(
  APPROVED_OPERATIONS.map(([m, p, ...copy]) => [`${m} ${p}`, copy]),
);
const schemas = new Set([
  'IntegrationTokenDto',
  'IntegrationTokenResponse',
  'IntegrationMeResponse',
  'CreateDeliveryRequestDto',
  'DeliveryStopDto',
  'DeliveryPackageDto',
  'DeliveryFinancialContextDto',
  'DeliveryRequestResponse',
  'DeliveryStopResponse',
  'DeliveryPackageResponse',
  'DeliveryFinancialContextResponse',
  'DeliveryRequestPageResponse',
  'DeliveryRequestSummaryResponse',
  'DeliveryStatusResponse',
  'DeliveryExecutionResponse',
  'PublicExecutionNameResponse',
  'CancelDeliveryRequestDto',
  'DeliveryQuoteResponse',
  'QuoteZoneResponse',
  'DeliveryQuotePageResponse',
  'AcceptDeliveryQuoteDto',
  'CustomerAuthorizationDto',
  'CreatePrequoteDto',
  'PrequoteStop',
  'PrequoteFoodPackage',
  'PrequoteResponse',
  'PrequoteZoneResponse',
  'ConvertPrequoteDto',
  'ConversionDeliveryRequestDto',
  'ConversionFoodPackageDto',
  'ConversionFinancialContextDto',
  'MerchantConfirmationDto',
  'CollectionInstructionDto',
  'PrequoteConversionResponse',
]);
const groups = new Set([
  'schemas',
  'parameters',
  'requestBodies',
  'responses',
  'headers',
  'examples',
]);

function effectiveSecurity(source, operation) {
  const security = Object.hasOwn(operation, 'security')
    ? operation.security
    : Object.hasOwn(source, 'security')
      ? source.security
      : [];
  if (
    !Array.isArray(security) ||
    security.some(
      (r) =>
        !r ||
        typeof r !== 'object' ||
        Array.isArray(r) ||
        Object.values(r).some(
          (s) => !Array.isArray(s) || s.some((v) => typeof v !== 'string'),
        ),
    )
  ) {
    throw Error('Invalid security requirements');
  }
  return security;
}
const pointerParts = (ref) => {
  if (
    typeof ref !== 'string' ||
    !ref.startsWith('#/components/') ||
    /~(?![01])/u.test(ref)
  )
    throw Error(`Unsupported reference: ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
};
function resolve(source, ref) {
  let value = source;
  for (const part of pointerParts(ref)) {
    if (!value || !Object.hasOwn(value, part))
      throw Error(`Missing reference: ${ref}`);
    value = value[part];
  }
  return value;
}

export function publicB2bDocument(source) {
  if (!source.paths || !source.components || !source.info)
    throw Error('Incomplete OpenAPI source');
  const scheme = source.components.securitySchemes?.[bearer];
  if (scheme?.type !== 'http' || scheme.scheme !== 'bearer' || scheme.$ref)
    throw Error('Unreviewed integration security scheme');
  const components = {
    securitySchemes: {
      [bearer]: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Token temporal obtenido mediante /api/v1/integrations/token.',
      },
    },
  };
  const copying = new Set();
  function include(ref) {
    resolve(source, ref);
    const [, group, name] = pointerParts(ref);
    if (!groups.has(group) || (group === 'schemas' && !schemas.has(name)))
      throw Error(`Unreviewed component: ${group}/${name}`);
    const key = `${group}/${name}`;
    if (copying.has(key)) return;
    copying.add(key);
    (components[group] ??= {})[name] = clean(
      source.components[group][name],
      `/components/${key}`,
    );
  }
  function clean(value, path = '') {
    if (Array.isArray(value))
      return value.map((v, i) => clean(v, `${path}/${i}`));
    if (!value || typeof value !== 'object') return value;
    if (
      /\/(properties|patternProperties|headers|content|examples|responses)$/.test(
        path,
      )
    ) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, clean(v, `${path}/${k}`)]),
      );
    }
    if (value['x-internal'])
      throw Error(`Internal object reachable at ${path}`);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (['example', 'default', 'enum', 'const', 'value'].includes(key)) {
        out[key] = structuredClone(item);
        continue;
      }
      if (key.startsWith('x-') && key !== 'x-scopes') continue;
      if (['externalDocs', 'servers'].includes(key)) continue;
      if (['callbacks', 'links', 'externalValue'].includes(key))
        throw Error(`Unreviewed ${key} at ${path}`);
      if (key === '$ref') {
        include(item);
        out[key] = item;
        continue;
      }
      // Dictionaries may legitimately contain fields named description/summary.
      if (
        ['description', 'summary'].includes(key) &&
        typeof item === 'string'
      ) {
        if (
          /\/responses\/(?:[1-5][0-9X]{2}|default)$/.test(path) &&
          key === 'description'
        ) {
          const codes = [
            ...new Set(item.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g) ?? []),
          ];
          out[key] =
            `Respuesta HTTP ${path.split('/').at(-1)}.${codes.length ? ` Códigos posibles: ${codes.join(', ')}.` : ''}`;
        } else {
          if (!Object.hasOwn(prose, item))
            throw Error(`Unreviewed public prose at ${path}/${key}`);
          out[key] = prose[item];
          if (
            path ===
            '/components/schemas/ConversionFinancialContextDto/properties/goodsPaymentMode'
          )
            out[key] =
              'Sólo PREPAID: comida confirmada como pagada al restaurante, sin adelanto. No significa envío pagado.';
          if (
            path ===
            '/components/schemas/ConversionFinancialContextDto/properties/goodsValue'
          )
            out[key] =
              'Valor de comida opcional, separado del envío; decimal positivo con hasta dos decimales.';
        }
        continue;
      }
      if (key === 'mapping' && path.endsWith('/discriminator')) {
        out[key] = Object.fromEntries(
          Object.entries(item).map(([k, ref]) => {
            const full = ref.startsWith('#')
              ? ref
              : `#/components/schemas/${ref}`;
            include(full);
            return [k, full];
          }),
        );
        continue;
      }
      out[key] = clean(item, `${path}/${key}`);
    }
    return out;
  }
  const paths = {};
  const seen = new Set();
  for (const [path, pathItem] of Object.entries(source.paths)) {
    if (pathItem.$ref) throw Error(`Unreviewed path reference: ${path}`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      const key = `${method} ${path}`;
      const copy = approved.get(key);
      const security = effectiveSecurity(source, operation);
      const b2b = security.some((s) => Object.hasOwn(s, bearer));
      const marked =
        operation['x-scopes']?.length ||
        (security.length === 0 &&
          operation.tags?.some((t) => /\bB2B\b/.test(t)));
      if (!copy) {
        if (
          b2b ||
          marked ||
          ((security.length === 0 ||
            security.some((s) => Object.keys(s).length === 0)) &&
            /^\/api\/v1\/(integrations|delivery-prequotes|delivery-quotes|delivery-requests)(?:\/|$)/.test(
              path,
            ))
        )
          throw Error(`Unreviewed B2B operation: ${key}`);
        continue;
      }
      if (operation['x-roles']?.length)
        throw Error(`Unreviewed human role requirement: ${key}`);
      if (pathItem['x-internal'] || operation['x-internal'])
        throw Error(`Internal approved operation: ${key}`);
      const token = key === 'post /api/v1/integrations/token';
      const anonymous =
        security.length === 0 ||
        (security.length === 1 && Object.keys(security[0]).length === 0);
      const integrationOnly =
        security.length === 1 &&
        Object.keys(security[0]).length === 1 &&
        security[0][bearer]?.length === 0;
      if (token ? !anonymous : !integrationOnly)
        throw Error(`Ambiguous or changed security: ${key}`);
      const {
        description: _description,
        summary: _summary,
        operationId: _id,
        tags: _tags,
        security: _security,
        ...contract
      } = operation;
      const result = clean(contract, `/paths/${path}/${method}`);
      result.operationId = copy[0];
      result.summary = copy[1];
      result.description = copy[2];
      result.tags = [
        path.includes('/integrations/')
          ? 'Autenticación B2B'
          : path.includes('prequotes')
            ? 'Precotizaciones'
            : path.includes('quotes')
              ? 'Cotizaciones'
              : 'Solicitudes',
      ];
      result.security = token ? [] : [{ [bearer]: [] }];
      if (!paths[path]) {
        paths[path] = {};
        if (pathItem.parameters)
          paths[path].parameters = clean(
            pathItem.parameters,
            `/paths/${path}/parameters`,
          );
      }
      paths[path][method] = result;
      seen.add(key);
    }
  }
  for (const key of approved.keys())
    if (!seen.has(key)) throw Error(`Missing approved operation: ${key}`);
  return {
    openapi: source.openapi,
    info: {
      title: 'Mandaria — API B2B',
      version: source.info.version,
      description:
        'API server-to-server. Guías: B2B-PUBLIC-GUIDE.md y B2B-WEBHOOKS.md. Las credenciales se provisionan por administración. Aceptación, entrega física y cobro son hechos distintos.',
    },
    servers: [
      {
        url: 'https://mandaria.com.mx',
        description:
          'Origen público confirmado por el propietario. Las rutas ya incluyen /api/v1; no añadir ese prefijo a servers.url.',
      },
    ],
    paths,
    components,
  };
}
export const serializePublicB2b = (source) =>
  JSON.stringify(publicB2bDocument(source), null, 2) + '\n';
export function checkPublicB2b(source, actual) {
  if (actual.replaceAll('\r\n', '\n') !== serializePublicB2b(source))
    throw Error('B2B OpenAPI stale; run npm run docs:b2b');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const source = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
  const destination = 'docs/openapi-b2b.json';
  if (process.argv.includes('--check'))
    checkPublicB2b(source, readFileSync(destination, 'utf8'));
  else writeFileSync(destination, serializePublicB2b(source));
  console.log('Public B2B contract verified');
}
