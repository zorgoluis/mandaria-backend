import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

/**
 * V1.12-D: the HMAC secret of a webhook endpoint.
 *
 * Mandaria had no secret encryption to reuse. Credentials are stored as a SHA-256 hash, which is
 * one-way and therefore useless here: signing a request needs the secret back. So the minimum safe
 * mechanism is built on `node:crypto` — AES-256-GCM under a master key supplied by configuration —
 * with no new dependency, following the same shape as the rest of the project's security helpers.
 *
 * The master key never appears in the database, in a log or in a response. Losing it means the
 * stored secrets can no longer be decrypted, and new ones have to be issued; that is the deliberate
 * trade of keeping it outside the data.
 */

/** Versioned on purpose: a future scheme can be added without guessing how to read old rows. */
const PREFIX = 'v1';
const b64 = (buffer: Buffer) => buffer.toString('base64url');

export class WebhookSecretError extends Error {
  constructor(readonly reason: 'NOT_CONFIGURED' | 'UNREADABLE') {
    super(
      reason === 'NOT_CONFIGURED'
        ? 'B2B_WEBHOOK_SECRET_KEY is not configured'
        : 'The stored webhook secret cannot be read with the configured key',
    );
    this.name = 'WebhookSecretError';
  }
}

/** 32 bytes, given as base64 or hex. Anything else is a configuration error, not a runtime one. */
export function masterKey(configured: string | undefined): Buffer {
  if (!configured) throw new WebhookSecretError('NOT_CONFIGURED');
  const key = /^[0-9a-fA-F]{64}$/.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new WebhookSecretError('NOT_CONFIGURED');
  return key;
}

/** A new secret, from the CSPRNG, in the same shape the project already uses for client secrets. */
export const newWebhookSecret = () => randomBytes(32).toString('base64url');

/** `v1:<iv>:<tag>:<ciphertext>`, all base64url, matching the CHECK in the migration. */
export function encryptSecret(secret: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  return [PREFIX, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(':');
}

export function decryptSecret(stored: string, key: Buffer) {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== PREFIX || !iv || !tag || !ciphertext)
    throw new WebhookSecretError('UNREADABLE');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Authentication failure means the row was tampered with or the key changed. Either way the
    // secret is not usable, and the reason must not leak which.
    throw new WebhookSecretError('UNREADABLE');
  }
}

/**
 * The signature contract, stated once so nobody has to guess it.
 *
 *   signed message = `${timestamp}.${rawBody}`
 *   signature      = `v1=` + HMAC-SHA256(secret, message) in lowercase hex
 *
 * `timestamp` is the Unix time **in seconds of this attempt**, not `occurredAt`: it lets a receiver
 * reject replays by age. It is not a substitute for `eventId`, which is what deduplicates.
 *
 * `rawBody` is the exact byte sequence sent, never a re-serialization of the parsed JSON — two
 * serializations of the same object are not the same bytes, and a receiver verifying against what
 * it received would fail.
 */
export const signedMessage = (timestampSeconds: number, rawBody: string) =>
  `${timestampSeconds}.${rawBody}`;

export const signWebhook = (
  secret: string,
  timestampSeconds: number,
  rawBody: string,
) =>
  `v1=${createHmac('sha256', secret)
    .update(signedMessage(timestampSeconds, rawBody))
    .digest('hex')}`;

/** What an administrator sees after the one time the secret is shown: that there is one. */
export const secretStatus = (endpoint: {
  secretCiphertext: string | null;
  secretSetAt: Date | null;
}) => ({
  secretConfigured: endpoint.secretCiphertext !== null,
  secretSetAt: endpoint.secretSetAt,
});
