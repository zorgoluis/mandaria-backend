import { z } from 'zod';

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
  return env;
}
