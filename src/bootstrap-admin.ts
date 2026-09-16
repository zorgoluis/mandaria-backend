cat > /opt/mandaria/backend/src/bootstrap-admin.ts <<'EOF'
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { z } from 'zod';

const prisma = new PrismaClient();

async function main() {
  const env = z
    .object({
      BOOTSTRAP_ADMIN_EMAIL: z
        .string()
        .email()
        .transform((v) => v.trim().toLowerCase()),
      BOOTSTRAP_ADMIN_PASSWORD: z.string().min(16).max(128),
    })
    .safeParse(process.env);

  if (!env.success) {
    throw new Error(
      'Set valid BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (16-128 characters)',
    );
  }

  const existing = await prisma.user.findUnique({
    where: {
      email: env.data.BOOTSTRAP_ADMIN_EMAIL,
    },
  });

  if (existing) {
    if (existing.role !== Role.SUPER_ADMIN || !existing.active) {
      throw new Error(
        'Bootstrap email belongs to an inactive or non-admin user; refusing to elevate privileges',
      );
    }

    console.log('SUPER_ADMIN already exists; unchanged');
    return;
  }

  await prisma.user.create({
    data: {
      email: env.data.BOOTSTRAP_ADMIN_EMAIL,
      passwordHash: await argon2.hash(
        env.data.BOOTSTRAP_ADMIN_PASSWORD,
        {
          type: argon2.argon2id,
        },
      ),
      role: Role.SUPER_ADMIN,
    },
  });

  console.log('SUPER_ADMIN bootstrap complete');
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Bootstrap failed',
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
EOF