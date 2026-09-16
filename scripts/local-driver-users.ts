// LOCAL/TEST ONLY: DRIVER users for the V1.4 manual scenario. Creates identities only;
// Driver profiles, vehicles and assignments are created through the API.
import type { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

export const LOCAL_DRIVER_USERS = {
  carlos: 'driver-carlos@mandaria.local',
  pedro: 'driver-pedro@mandaria.local',
  jose: 'driver-jose@mandaria.local',
  luis: 'driver-luis@mandaria.local',
  mario: 'driver-mario@mandaria.local',
} as const;

/** Idempotent; never changes the role of an existing email. */
export async function seedLocalDriverUsers(
  prisma: PrismaClient,
  password: string,
  emails: Record<string, string> = LOCAL_DRIVER_USERS,
) {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const result: Record<string, { id: string; email: string }> = {};
  for (const [key, email] of Object.entries(emails)) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.role !== 'DRIVER')
      throw new Error(
        'Local seed email belongs to a non DRIVER user; refusing to change roles',
      );
    const samePassword =
      existing?.passwordHash &&
      (await argon2.verify(existing.passwordHash, password));
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { active: true, ...(samePassword ? {} : { passwordHash }) },
        })
      : await prisma.user.create({
          data: { email, passwordHash, role: 'DRIVER' },
        });
    if (existing && !samePassword)
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    result[key] = { id: user.id, email: user.email };
  }
  return result;
}
