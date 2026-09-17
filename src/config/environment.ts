import { z } from 'zod';

/** Empty variables (common in .env templates) count as unset. */
const optional = <T extends z.ZodTypeAny>(type: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), type.optional());

const schema = z.object({
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
  MAIL_PROVIDER: optional(z.enum(['smtp', 'local_outbox'])),
  MAIL_FROM: optional(z.string().min(3).max(320)),
  SMTP_HOST: optional(z.string().min(1).max(255)),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: optional(z.string().min(1).max(320)),
  SMTP_PASSWORD: optional(z.string().min(1).max(1024)),
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
});
export function validateEnvironment(input: Record<string, unknown>) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ')}`,
    );
  const env = result.data;
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
    if (env.MAIL_PROVIDER !== 'smtp')
      throw new Error('MAIL_PROVIDER=smtp is required in production');
    if (!env.MANDARIA_WEB_URL?.startsWith('https://'))
      throw new Error('MANDARIA_WEB_URL must be an https URL in production');
  }
  // Development and test default to the local outbox so no real email is ever sent by accident.
  const mailProvider = env.MAIL_PROVIDER ?? 'local_outbox';
  if (mailProvider === 'smtp') {
    if (!env.SMTP_HOST || !env.MAIL_FROM)
      throw new Error('MAIL_PROVIDER=smtp requires SMTP_HOST and MAIL_FROM');
    if (!env.SMTP_USER !== !env.SMTP_PASSWORD)
      throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
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
