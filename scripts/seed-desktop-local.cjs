// Synthetic accounts only. Receive local credentials through stdin, never CLI arguments/logs.
const fs = require('node:fs');
const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const db = new PrismaClient();
(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.NODE_ENV !== 'development' || url.hostname !== 'postgres' || url.pathname !== '/mandaria_desktop_local') throw Error('Local-only guard');
  const accounts = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!Array.isArray(accounts) || accounts.length !== 4) throw Error('Invalid fixtures');
  for (const account of accounts) {
    if (!account.email.endsWith('@mandaria-local.test') || !['SUPER_ADMIN','PROVIDER_ADMIN','DRIVER'].includes(account.role) || typeof account.password !== 'string' || account.password.length < 24) throw Error('Invalid fixture');
    const existing = await db.user.findUnique({where:{email:account.email}});
    if (existing && (existing.role !== account.role || !existing.active)) throw Error('Unexpected existing account');
    if (!existing) await db.user.create({data:{email:account.email,role:account.role,passwordHash:await argon2.hash(account.password),emailVerifiedAt:new Date()}});
  }
  const admin = await db.user.findUniqueOrThrow({where:{email:'provider@mandaria-local.test'}});
  const provider = await db.deliveryProvider.upsert({where:{code:'DESKTOP_SYNTHETIC'},update:{},create:{name:'Flotilla sintética Docker local',code:'DESKTOP_SYNTHETIC',type:'FLEET',status:'ACTIVE',maxDrivers:4,maxVehicles:4}});
  await db.providerMembership.upsert({where:{providerId_userId:{providerId:provider.id,userId:admin.id}},update:{},create:{providerId:provider.id,userId:admin.id,role:'OWNER'}});
  const driverUser = await db.user.findUniqueOrThrow({where:{email:'driver@mandaria-local.test'}});
  await db.driver.upsert({where:{userId:driverUser.id},update:{},create:{providerId:provider.id,userId:driverUser.id,name:'Repartidor sintético local',displayName:'Repartidor de pruebas',status:'ACTIVE',availability:'AVAILABLE'}});
  console.log('Synthetic setup ready: 2 SUPER_ADMIN, 1 PROVIDER_ADMIN/member, 1 fleet DRIVER. No deliveries or external integrations.');
})().catch(()=>{console.error('Local seed failed; sensitive details omitted');process.exitCode=1;}).finally(()=>db.$disconnect());
