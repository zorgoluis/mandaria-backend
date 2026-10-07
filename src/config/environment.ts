import { z } from 'zod';

/** Empty variables (common in .env templates) count as unset. */
const optional = <T extends z.ZodTypeAny>(type: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), type.optional());

const schema = z.object({
  LOCATION_IP_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(60),
  LOCATION_TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SHARED_TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOCATION_DRIVER_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30),
  LOCATION_OWNER_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(60),
  LOCATION_RECIPIENT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(12),
  LOCATION_LINK_MUTATIONS_PER_TEN_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5),
  CUSTOMER_ADMISSION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CUSTOMER_CHALLENGE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(1800),
  DETAILED_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .regex(/^postgres(ql)?:\/\//),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  INTEGRATION_JWT_SECRET: z.string().min(32),
  INTEGRATION_ACCESS_TOKEN_EXPIRES_IN: z.coerce
    .number()
    .int()
    .min(60)
    .max(3600)
    .default(3600),
  JWT_ACCESS_EXPIRES_IN: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_REFRESH_EXPIRES_IN: z.coerce
    .number()
    .int()
    .min(3600)
    .max(2592000)
    .default(604800),
  CORS_ORIGINS: z.string().default(''),
  // Reverse proxies in front of the backend whose X-Forwarded-For is trusted for the client IP
  // (rate limits). 0 keeps the socket address; 1 for a single nginx. Never more than the real hops.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  // Optional internal mailbox notified of each new partner application (no personal data sent).
  PARTNER_APPLICATIONS_NOTIFY_EMAIL: optional(
    z.string().trim().email().max(254),
  ),
  // A5 remains disabled by default; enabling also requires explicit shared routing budget.
  PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PREQUOTE_CONVERSION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PREQUOTE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PREQUOTE_VALIDITY_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86400000)
    .default(900000),
  PREQUOTE_LEASE_MS: z.coerce.number().int().min(1).max(300000).default(90000),
  PREQUOTE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  PREQUOTE_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(10),
  PREQUOTE_PER_DAY: z.coerce.number().int().min(1).max(1000000).default(500),
  PREQUOTE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(2),
  PREQUOTE_PERMIT_RESERVE_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300000)
    .default(30000),
  PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS: optional(
    z.coerce.number().int().min(1).max(1000000),
  ),
  // V1.6 routing. local_fake is LOCAL/TEST ONLY and rejected in production.
  ROUTING_PROVIDER: z.enum(['google', 'local_fake']).default('google'),
  GOOGLE_ROUTES_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(20).max(200).optional(),
  ),
  GOOGLE_ROUTES_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(15000)
    .default(5000),
  GOOGLE_ROUTES_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  GOOGLE_ROUTES_TRAVEL_MODE: z.enum(['DRIVE', 'TWO_WHEELER']).default('DRIVE'),
  // V1.6.1 user provisioning. local_outbox is LOCAL/TEST ONLY and rejected in production.
  USER_INVITATION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24),
  USER_INVITATION_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(60),
  MANDARIA_WEB_URL: optional(
    z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password
        );
      }, 'must be an http(s) URL without credentials, query or fragment')
      .transform((value) => value.replace(/\/+$/, '')),
  ),
  MAIL_PROVIDER: optional(z.enum(['resend', 'local_outbox'])),
  MAIL_FROM: optional(z.string().min(3).max(320)),
  RESEND_API_KEY: optional(z.string().trim().min(1).max(1024)),
  LOCAL_MAIL_OUTBOX_DIR: optional(z.string().min(1).max(1024)),
  // V1.7 dispatch: how long an accepted service stays claimable by eligible providers.
  DISPATCH_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  // V1.8: expected time between claim and driver/vehicle assignment, per ServiceType.
  LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(5),
  DEFAULT_FLEET_MAX_DRIVERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(10),
  DEFAULT_FLEET_MAX_VEHICLES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(10),
  DEFAULT_INDEPENDENT_MAX_DRIVERS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(1),
  DEFAULT_INDEPENDENT_MAX_VEHICLES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(2),
  /// V1.9: vehicles SUPER_ADMIN may register for one independent driver (their own, not a fleet).
  INDEPENDENT_DRIVER_MAX_VEHICLES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3),
  // V1.12-C webhook delivery. The insecure-targets switch is LOCAL/TEST ONLY (it allows http and
  // loopback so the suites can run a real receiver) and is rejected in production.
  B2B_WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(30000)
    .default(5000),
  B2B_WEBHOOK_ALLOW_INSECURE_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // V1.12-D reliable delivery. The master key encrypts the per-endpoint HMAC secrets (32 bytes as
  // hex or base64) and is required in production; losing it means reissuing every secret.
  B2B_WEBHOOK_SECRET_KEY: optional(z.string().min(32).max(200)),
  // How often a backend looks for work. 0 disables the loop, which is how the suites drive the
  // worker deterministically; production keeps a moderate, unhurried cadence.
  B2B_WEBHOOK_POLL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(15),
  // How long a worker owns a handover before another may take it over. It has to outlast a request
  // (timeout plus margin) and still be short enough that a dead worker does not block for long.
  B2B_WEBHOOK_LEASE_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(600)
    .default(60),
});
export function validateEnvironment(input: Record<string, unknown>) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`,
    );
  const env = result.data;
  if (
    env.PREQUOTE_ENABLED &&
    (!env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS ||
      env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS <
        env.GOOGLE_ROUTES_MAX_RETRIES + 1)
  )
    throw new Error(
      'PREQUOTE_ENABLED requires explicit PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS covering routing retries',
    );
  const routingBudget =
    env.GOOGLE_ROUTES_TIMEOUT_MS * (env.GOOGLE_ROUTES_MAX_RETRIES + 1) +
    100 * env.GOOGLE_ROUTES_MAX_RETRIES * (env.GOOGLE_ROUTES_MAX_RETRIES + 1);
  if (env.PREQUOTE_LEASE_MS < routingBudget + 15000)
    throw new Error(
      'PREQUOTE_LEASE_MS must cover routing timeout/retries/backoff plus 15000 ms publication margin',
    );
  if (
    new Set([
      env.JWT_ACCESS_SECRET,
      env.JWT_REFRESH_SECRET,
      env.INTEGRATION_JWT_SECRET,
    ]).size !== 3
  )
    throw new Error('JWT secrets must differ');
  if (env.NODE_ENV === 'production') {
    if (env.ROUTING_PROVIDER === 'local_fake')
      throw new Error(
        'ROUTING_PROVIDER=local_fake is not allowed in production',
      );
    if (env.ROUTING_PROVIDER === 'google' && !env.GOOGLE_ROUTES_API_KEY)
      throw new Error('GOOGLE_ROUTES_API_KEY is required in production');
    if (env.MAIL_PROVIDER !== 'resend')
      throw new Error('MAIL_PROVIDER=resend is required in production');
    if (!env.MANDARIA_WEB_URL?.startsWith('https://'))
      throw new Error('MANDARIA_WEB_URL must be an https URL in production');
    if (env.B2B_WEBHOOK_ALLOW_INSECURE_TARGETS)
      throw new Error(
        'B2B_WEBHOOK_ALLOW_INSECURE_TARGETS=true is not allowed in production',
      );
    if (!env.B2B_WEBHOOK_SECRET_KEY)
      throw new Error('B2B_WEBHOOK_SECRET_KEY is required in production');
  }
  // Development and test default to the local outbox so no real email is ever sent by accident.
  const mailProvider = env.MAIL_PROVIDER ?? 'local_outbox';
  if (mailProvider === 'resend') {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM?.trim())
      throw new Error(
        'MAIL_PROVIDER=resend requires RESEND_API_KEY and MAIL_FROM',
      );
  }
  for (const origin of env.CORS_ORIGINS.split(',').filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('CORS_ORIGINS must contain exact HTTP origins');
  }
  return { ...env, MAIL_PROVIDER: mailProvider };
}
