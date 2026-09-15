// LOCAL/TEST ONLY: reproducible PROVIDER_ADMIN scenario for development and E2E.
// Never wired into `prisma db seed`, the Docker image or the entrypoint.
import type { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

export const LOCAL_PROVIDER_ADMIN_PASSWORD_VAR =
  'LOCAL_PROVIDER_ADMIN_PASSWORD';

export type LocalProviderAdminScenarioOptions = {
  password: string;
  emails?: { adminA: string; adminB: string; noMembership: string };
  codes?: { providerA: string; providerB: string };
  limits?: { maxDrivers: number; maxVehicles: number };
};

export const LOCAL_PROVIDER_ADMIN_DEFAULTS = {
  emails: {
    adminA: 'provider-admin-a@mandaria.local',
    adminB: 'provider-admin-b@mandaria.local',
    noMembership: 'provider-admin-sin-membership@mandaria.local',
  },
  codes: {
    providerA: 'LOCAL_RAPIDOS_COITA',
    providerB: 'LOCAL_MANDADOS_CENTRO',
  },
  names: { providerA: 'Rápidos de Coita', providerB: 'Mandados del Centro' },
} as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Throws unless the environment is explicitly non-production and the database is local. */
export function assertLocalSeedAllowed(
  env: Record<string, string | undefined>,
) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test'].includes(nodeEnv))
    throw new Error(
      'Local PROVIDER_ADMIN seed refused: NODE_ENV must be development or test',
    );
  let host: string;
  try {
    host = new URL(env.DATABASE_URL ?? '').hostname;
  } catch {
    throw new Error('Local PROVIDER_ADMIN seed refused: invalid DATABASE_URL');
  }
  if (!LOCAL_HOSTS.has(host))
    throw new Error(
      'Local PROVIDER_ADMIN seed refused: DATABASE_URL host must be localhost',
    );
  const password = env[LOCAL_PROVIDER_ADMIN_PASSWORD_VAR];
  if (!password || password.length < 16 || password.length > 128)
    throw new Error(
      `Set ${LOCAL_PROVIDER_ADMIN_PASSWORD_VAR} (16-128 characters, LOCAL/TEST ONLY)`,
    );
  if (password === env.BOOTSTRAP_ADMIN_PASSWORD)
    throw new Error(
      `${LOCAL_PROVIDER_ADMIN_PASSWORD_VAR} must differ from BOOTSTRAP_ADMIN_PASSWORD`,
    );
  return password;
}

/**
 * Idempotently creates Provider A/B (FLEET, ACTIVE) and three PROVIDER_ADMIN users:
 * Admin A → Provider A, Admin B → Provider B, and one user without memberships.
 * Uses the same tables the API uses; it never changes the role of an existing user.
 */
export async function seedLocalProviderAdmins(
  prisma: PrismaClient,
  options: LocalProviderAdminScenarioOptions,
) {
  const emails = options.emails ?? LOCAL_PROVIDER_ADMIN_DEFAULTS.emails;
  const codes = options.codes ?? LOCAL_PROVIDER_ADMIN_DEFAULTS.codes;
  const limits = options.limits ?? { maxDrivers: 10, maxVehicles: 10 };
  const passwordHash = await argon2.hash(options.password, {
    type: argon2.argon2id,
  });
  return prisma.$transaction(
    async (tx) => {
      const provider = async (code: string, name: string) => {
        const existing = await tx.deliveryProvider.findUnique({
          where: { code },
        });
        if (existing && existing.type !== 'FLEET')
          throw new Error(
            `Provider ${code} exists with another type; refusing`,
          );
        return existing
          ? tx.deliveryProvider.update({
              where: { id: existing.id },
              data: { status: 'ACTIVE' },
            })
          : tx.deliveryProvider.create({
              data: { code, name, type: 'FLEET', status: 'ACTIVE', ...limits },
            });
      };
      const user = async (email: string) => {
        const existing = await tx.user.findUnique({ where: { email } });
        if (!existing)
          return tx.user.create({
            data: { email, passwordHash, role: 'PROVIDER_ADMIN' },
          });
        if (existing.role !== 'PROVIDER_ADMIN')
          throw new Error(
            'Local seed email belongs to a non PROVIDER_ADMIN user; refusing to change roles',
          );
        const samePassword = await argon2.verify(
          existing.passwordHash,
          options.password,
        );
        if (!samePassword)
          await tx.refreshToken.updateMany({
            where: { userId: existing.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        return tx.user.update({
          where: { id: existing.id },
          data: { active: true, ...(samePassword ? {} : { passwordHash }) },
        });
      };
      const providerA = await provider(
        codes.providerA,
        LOCAL_PROVIDER_ADMIN_DEFAULTS.names.providerA,
      );
      const providerB = await provider(
        codes.providerB,
        LOCAL_PROVIDER_ADMIN_DEFAULTS.names.providerB,
      );
      const adminA = await user(emails.adminA);
      const adminB = await user(emails.adminB);
      const noMembership = await user(emails.noMembership);
      // Keep the scenario exact: seeded users only hold the memberships below.
      await tx.providerMembership.deleteMany({
        where: {
          OR: [
            { userId: adminA.id, providerId: { not: providerA.id } },
            { userId: adminB.id, providerId: { not: providerB.id } },
            { userId: noMembership.id },
          ],
        },
      });
      const membership = (userId: string, providerId: string) =>
        tx.providerMembership.upsert({
          where: { providerId_userId: { providerId, userId } },
          update: { role: 'OWNER' },
          create: { providerId, userId, role: 'OWNER' },
        });
      const membershipA = await membership(adminA.id, providerA.id);
      const membershipB = await membership(adminB.id, providerB.id);
      const pick = (u: { id: string; email: string }) => ({
        id: u.id,
        email: u.email,
      });
      const pickProvider = (p: { id: string; code: string; name: string }) => ({
        id: p.id,
        code: p.code,
        name: p.name,
      });
      return {
        providerA: pickProvider(providerA),
        providerB: pickProvider(providerB),
        adminA: pick(adminA),
        adminB: pick(adminB),
        noMembership: pick(noMembership),
        membershipA: { id: membershipA.id, role: membershipA.role },
        membershipB: { id: membershipB.id, role: membershipB.role },
      };
    },
    { timeout: 15000 },
  );
}
