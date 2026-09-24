import { isIP } from 'node:net';

/**
 * V1.12-C: the URL an administrator configures becomes a destination Mandaria itself connects to,
 * from inside the network where the database lives. That makes it an SSRF surface, not a text
 * field, so it is checked twice: when it is written, and again — including the addresses its
 * hostname resolves to — immediately before every request.
 *
 * Checking only at configuration time would be theatre: a public hostname can start resolving to a
 * private address at any moment, and that is the classic way this kind of feature is abused.
 */

export const WEBHOOK_TARGET_REJECTIONS = {
  NOT_A_URL: 'The endpoint must be an absolute URL',
  SCHEME: 'The endpoint must use https',
  CREDENTIALS: 'The endpoint must not embed credentials',
  FRAGMENT: 'The endpoint must not contain a fragment',
  HOST: 'The endpoint host is not a valid public destination',
  PRIVATE_HOST: 'The endpoint resolves to an address Mandaria will not call',
  TOO_LONG: 'The endpoint must be at most 2048 characters',
} as const;
export type WebhookTargetRejection = keyof typeof WEBHOOK_TARGET_REJECTIONS;

export class WebhookTargetError extends Error {
  constructor(readonly reason: WebhookTargetRejection) {
    super(WEBHOOK_TARGET_REJECTIONS[reason]);
    this.name = 'WebhookTargetError';
  }
}

/**
 * Hostnames that never denote a public destination, whatever they resolve to. `.local`,
 * `.internal` and `.home.arpa` are reserved for internal naming; `localhost` is special-cased by
 * resolvers everywhere.
 */
const FORBIDDEN_HOST = /(^|\.)(localhost|local|internal|intranet|home\.arpa)$/i;

/** Big-endian numeric value of a dotted-quad address. */
const ipv4 = (value: string) =>
  value.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);

/**
 * Everything that is not a globally routable unicast address: loopback, this-host, private ranges,
 * carrier-grade NAT, link-local (which is where cloud metadata services live, 169.254.169.254
 * among them), shared benchmarking space, multicast and reserved.
 */
function isForbiddenIpv4(address: string) {
  const n = ipv4(address);
  const inRange = (cidr: string, bits: number) =>
    n >>> (32 - bits) === ipv4(cidr) >>> (32 - bits);
  return (
    inRange('0.0.0.0', 8) || // this host
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) || // loopback
    inRange('169.254.0.0', 16) || // link-local, incl. cloud metadata
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.0.2.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) || // benchmarking
    inRange('198.51.100.0', 24) ||
    inRange('203.0.113.0', 24) ||
    n >>> 28 === 0xe || // 224.0.0.0/4 multicast
    n >>> 28 === 0xf // 240.0.0.0/4 reserved, incl. broadcast
  );
}

/**
 * The eight 16-bit groups of an IPv6 address, with `::` expanded and a trailing dotted quad folded
 * in. Decisions are made on the expanded form rather than on the spelling, because the URL parser
 * rewrites addresses: `[::ffff:127.0.0.1]` arrives as `::ffff:7f00:1`, and a policy that pattern-
 * matched the text would wave it through.
 */
function ipv6Groups(value: string): number[] | null {
  let text = value;
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const n = ipv4(quad[1]);
    text = `${text.slice(0, quad.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail, ...rest] = text.split('::');
  if (rest.length) return null;
  const parse = (part: string) =>
    part ? part.split(':').map((g) => Number.parseInt(g, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 ? groups : null;
}

function isForbiddenIpv6(address: string) {
  const value = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  const g = ipv6Groups(value);
  if (!g) return true; // unparseable is not a destination we call
  const zeroPrefix = (count: number) => g.slice(0, count).every((x) => x === 0);
  // Unspecified (::) and loopback (::1).
  if (zeroPrefix(7) && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): IPv4 wearing a costume.
  if (zeroPrefix(5) && (g[5] === 0xffff || g[5] === 0))
    return isForbiddenIpv4(
      [g[6] >>> 8, g[6] & 0xff, g[7] >>> 8, g[7] & 0xff].join('.'),
    );
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g[0] & 0xff00) === 0xff00 || // multicast
    (g[0] === 0x64 && g[1] === 0xff9b) || // NAT64
    (g[0] === 0x2001 && g[1] === 0x0db8) // documentation
  );
}

/** True when this literal address must never be connected to. */
export const isForbiddenAddress = (address: string) =>
  isIP(address) === 6 ? isForbiddenIpv6(address) : isForbiddenIpv4(address);

export type WebhookTargetPolicy = {
  /**
   * LOCAL/TEST ONLY. Allows http and loopback destinations so the suites can run a real receiver
   * on 127.0.0.1. The environment refuses to start with this enabled in production, exactly like
   * ROUTING_PROVIDER=local_fake and MAIL_PROVIDER=local_outbox.
   */
  allowInsecureTargets: boolean;
};

/**
 * Validates the shape of a configured URL. Returns the parsed URL so callers do not parse twice.
 * Does not resolve DNS: that belongs to the moment of use, in `assertResolvedAddresses`.
 */
export function parseWebhookTarget(
  raw: string,
  policy: WebhookTargetPolicy,
): URL {
  if (raw.length > 2048) throw new WebhookTargetError('TOO_LONG');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetError('NOT_A_URL');
  }
  const httpAllowed = policy.allowInsecureTargets && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !httpAllowed)
    throw new WebhookTargetError('SCHEME');
  // Credentials in the URL would travel in the request and end up in logs and proxies.
  if (url.username || url.password) throw new WebhookTargetError('CREDENTIALS');
  if (url.hash) throw new WebhookTargetError('FRAGMENT');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new WebhookTargetError('HOST');
  if (policy.allowInsecureTargets) return url;
  if (FORBIDDEN_HOST.test(host)) throw new WebhookTargetError('HOST');
  // A literal address is decided here; a name is decided again after it resolves.
  if (isIP(host) && isForbiddenAddress(host))
    throw new WebhookTargetError('PRIVATE_HOST');
  return url;
}

/**
 * The second half of the policy, applied right before the request with the addresses the hostname
 * actually resolved to. A public name pointing at 10.x or at the metadata service is the whole
 * point of this check.
 *
 * Known limitation, deliberately not solved here: between this check and the socket, a resolver
 * could answer differently (DNS rebinding). Closing that needs a custom dispatcher pinned to the
 * validated address, which is a larger change than V1.12-C should carry; it is written down in the
 * documentation rather than left implied.
 */
export function assertResolvedAddresses(
  addresses: string[],
  policy: WebhookTargetPolicy,
) {
  if (policy.allowInsecureTargets) return;
  if (addresses.length === 0) throw new WebhookTargetError('PRIVATE_HOST');
  for (const address of addresses)
    if (isForbiddenAddress(address))
      throw new WebhookTargetError('PRIVATE_HOST');
}
