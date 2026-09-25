import 'dotenv/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL);
const suffix = randomBytes(5).toString('hex');
const cleanDb = `mandaria_clean_${suffix}_test`;
const upgradeDb = `mandaria_upgrade_${suffix}_test`;
const v19Db = `mandaria_v19_${suffix}_test`;
const v110aDb = `mandaria_v110a_${suffix}_test`;
const windowsPsql = 'C:/Program Files/PostgreSQL/18/bin/psql.exe';
const psql =
  process.env.PSQL_PATH || (existsSync(windowsPsql) ? windowsPsql : 'psql');
const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGCONNECT_TIMEOUT: '5',
};
function sql(db, args) {
  const result = spawnSync(
    psql,
    ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-tA', ...args],
    { env: { ...pgEnv, PGDATABASE: db }, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      `SQL verification failed in ${db}; check psql access and CREATEDB permission`,
    );
  return result.stdout.trim();
}
function prisma(db, args) {
  const target = new URL(url);
  target.pathname = '/' + db;
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`Prisma migration verification failed in ${db}`);
}
try {
  for (const db of [cleanDb, upgradeDb])
    sql('postgres', ['-c', `CREATE DATABASE "${db}"`]);
  prisma(cleanDb, ['migrate', 'deploy']);
  assert.equal(
    sql(cleanDb, [
      '-c',
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    ]),
    String(
      readdirSync('prisma/migrations', { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
      ).length,
    ),
  );
  sql(upgradeDb, ['-f', 'prisma/migrations/20260915000100_core/migration.sql']);
  const integrationId = randomUUID();
  const userId = randomUUID();
  const activeId = randomUUID();
  const revokedId = randomUUID();
  const refreshId = randomUUID();
  const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${userId}','migration@example.test','${hash}','SUPER_ADMIN',now());
    INSERT INTO "RefreshToken" (id,"userId","tokenHash","expiresAt","updatedAt") VALUES ('${refreshId}','${userId}','${hash}',now()+interval '1 day',now());
    INSERT INTO "IntegrationClient" (id,name,code,status,"updatedAt") VALUES ('${integrationId}','Migration fixture','MIGRATION_FIXTURE','INACTIVE',now());
    INSERT INTO "IntegrationCredential" (id,"clientId","secretHash","revokedAt","updatedAt") VALUES
      ('${activeId}','${integrationId}','${hash}',NULL,now()),
      ('${revokedId}','${integrationId}','${hash}revoked',now(),now());
  `,
  ]);
  const before = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT row_to_json(c) FROM "IntegrationClient" c WHERE id='${integrationId}'`,
    ]),
  );
  prisma(upgradeDb, ['migrate', 'resolve', '--applied', '20260915000100_core']);
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000200_b2b_credentials/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000200_b2b_credentials',
  ]);
  const snapshot = () =>
    Object.fromEntries(
      [
        'User',
        'RefreshToken',
        'IntegrationClient',
        'IntegrationCredential',
      ].map((table) => [
        table,
        sql(upgradeDb, [
          '-c',
          `SELECT json_agg(t ORDER BY id) FROM "${table}" t`,
        ]),
      ]),
    );
  const v11Snapshot = snapshot();
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000300_delivery_providers/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000300_delivery_providers',
  ]);
  assert.deepEqual(snapshot(), v11Snapshot);
  // V1.2 fixtures: provider with limits and a PROVIDER_ADMIN membership.
  const providerId = randomUUID();
  const providerAdminId = randomUUID();
  const membershipId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${providerAdminId}','provider-admin@example.test','${hash}','PROVIDER_ADMIN',now());
    INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES ('${providerId}','Migration provider','MIGRATION_PROVIDER','FLEET','ACTIVE',7,9,now());
    INSERT INTO "ProviderMembership" (id,"providerId","userId",role,"updatedAt") VALUES ('${membershipId}','${providerId}','${providerAdminId}','OWNER',now());
  `,
  ]);
  const v12Tables = [
    'User',
    'RefreshToken',
    'IntegrationClient',
    'IntegrationCredential',
    'DeliveryProvider',
    'ProviderMembership',
  ];
  const fullSnapshot = () =>
    Object.fromEntries(
      v12Tables.map((table) => [
        table,
        sql(upgradeDb, [
          '-c',
          `SELECT json_agg(t ORDER BY id) FROM "${table}" t`,
        ]),
      ]),
    );
  /** Re-serializes `after` keeping only the columns present in `before`, per table. */
  const sameColumnsAs = (after, before) =>
    Object.fromEntries(
      Object.entries(after).map(([table, json]) => {
        const previous = JSON.parse(before[table] ?? 'null');
        const current = JSON.parse(json ?? 'null');
        if (!previous?.length || !current?.length) return [table, json];
        const keys = Object.keys(previous[0]);
        // Untouched tables keep the exact psql text, so formatting never masks a real difference.
        if (keys.length === Object.keys(current[0]).length)
          return [table, json];
        return [
          table,
          JSON.stringify(
            current.map((row) =>
              Object.fromEntries(keys.map((k) => [k, row[k]])),
            ),
          ),
        ];
      }),
    );
  const v12Snapshot = fullSnapshot();
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000400_drivers_vehicles/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000400_drivers_vehicles',
  ]);
  assert.deepEqual(fullSnapshot(), v12Snapshot);
  // V1.4 fixtures: driver with an active assignment and a closed history row.
  const driverUserId = randomUUID();
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${driverUserId}','driver@example.test','${hash}','DRIVER',now());
    INSERT INTO "Driver" (id,"providerId","userId",name,status,availability,"updatedAt") VALUES ('${driverId}','${providerId}','${driverUserId}','Carlos','ACTIVE','AVAILABLE',now());
    INSERT INTO "Vehicle" (id,"providerId",identifier,type,status,"updatedAt") VALUES ('${vehicleId}','${providerId}','MOTO-01','MOTORCYCLE','ACTIVE',now());
    INSERT INTO "DriverVehicleAssignment" (id,"providerId","driverId","vehicleId","assignedAt","unassignedAt") VALUES
      ('${randomUUID()}','${providerId}','${driverId}','${vehicleId}',now() - interval '2 days',now() - interval '1 day'),
      ('${randomUUID()}','${providerId}','${driverId}','${vehicleId}',now(),NULL);
  `,
  ]);
  v12Tables.push('Driver', 'Vehicle', 'DriverVehicleAssignment');
  const v14Snapshot = fullSnapshot();
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000500_delivery_requests/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000500_delivery_requests',
  ]);
  assert.deepEqual(fullSnapshot(), v14Snapshot);
  // V1.5 fixtures: a delivery request with stops, package, financial context and idempotency record.
  const deliveryRequestId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "DeliveryRequest" (id,"publicId","integrationClientId","externalReference",status,"updatedAt") VALUES ('${deliveryRequestId}','MDR-000001','${integrationId}','ORDER-1842','CREATED',now());
    INSERT INTO "DeliveryStop" (id,"deliveryRequestId",type,sequence,address,latitude,longitude,"contactName","contactPhone","updatedAt") VALUES
      ('${randomUUID()}','${deliveryRequestId}','PICKUP',1,'Origen',16.7614,-93.3743,'A','9610000001',now()),
      ('${randomUUID()}','${deliveryRequestId}','DROPOFF',2,'Destino',16.77,-93.36,'B','9610000002',now());
    INSERT INTO "DeliveryPackage" (id,"deliveryRequestId",category,description,quantity,"updatedAt") VALUES ('${randomUUID()}','${deliveryRequestId}','FOOD','Pedido',2,now());
    INSERT INTO "DeliveryFinancialContext" (id,"deliveryRequestId","goodsValue","goodsPaymentMode",currency,"updatedAt") VALUES ('${randomUUID()}','${deliveryRequestId}',450.00,'COURIER_ADVANCE','MXN',now());
    INSERT INTO "ApiIdempotencyRecord" (id,"integrationClientId",key,operation,"requestHash","resourceType","resourceId") VALUES ('${randomUUID()}','${integrationId}','migration-key-001','delivery_requests.create','${hash}','DeliveryRequest','${deliveryRequestId}');
  `,
  ]);
  v12Tables.push(
    'DeliveryStop',
    'DeliveryPackage',
    'DeliveryFinancialContext',
    'ApiIdempotencyRecord',
  );
  const requestColumns = `SELECT json_agg(json_build_object('id', id, 'publicId', "publicId", 'status', status, 'externalReference', "externalReference") ORDER BY id) FROM "DeliveryRequest"`;
  const v15Snapshot = {
    ...fullSnapshot(),
    request: sql(upgradeDb, ['-c', requestColumns]),
  };
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000600_routing_pricing_quotes/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000600_routing_pricing_quotes',
  ]);
  assert.deepEqual(
    { ...fullSnapshot(), request: sql(upgradeDb, ['-c', requestColumns]) },
    v15Snapshot,
  );
  // V1.6 fixtures: zone, versioned plan with a band and an accepted quote must survive V1.6.1.
  const zoneId = randomUUID();
  const planId = randomUUID();
  const bandId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "ServiceZone" (id,code,name,status,currency,boundary,"minLatitude","maxLatitude","minLongitude","maxLongitude","updatedAt") VALUES ('${zoneId}','MIGRATION_ZONE','Migration zone','ACTIVE','MXN','{"type":"Polygon","coordinates":[[[-93.41,16.73],[-93.34,16.73],[-93.34,16.79],[-93.41,16.79],[-93.41,16.73]]]}',16.73,16.79,-93.41,-93.34,now());
    INSERT INTO "RatePlan" (id,"serviceZoneId","serviceType",version,status,"quoteValidityMinutes",currency,"updatedAt") VALUES ('${planId}','${zoneId}','LOCAL_DELIVERY',1,'DRAFT',15,'MXN',now());
    INSERT INTO "RateBand" (id,"ratePlanId","minDistanceMeters","maxDistanceMeters",amount,currency,"updatedAt") VALUES ('${bandId}','${planId}',0,10000,50.00,'MXN',now());
    UPDATE "RatePlan" SET status='ACTIVE', "activatedAt"=now() WHERE id='${planId}';
    INSERT INTO "DeliveryQuote" (id,"publicId","deliveryRequestId","serviceType","serviceZoneId","ratePlanId","rateBandId","distanceMeters","durationSeconds",amount,currency,"routingProvider","routeCalculatedAt",status,"expiresAt","acceptedAt","updatedAt") VALUES ('${randomUUID()}','MQ-000001','${deliveryRequestId}','LOCAL_DELIVERY','${zoneId}','${planId}','${bandId}',4700,780,50.00,'MXN','google',now(),'ACCEPTED',now() + interval '15 minutes',now(),now());
  `,
  ]);
  v12Tables.push(
    'DeliveryRequest',
    'ServiceZone',
    'RatePlan',
    'RateBand',
    'DeliveryQuote',
  );
  // V1.6.1 fixture: an inactive user with password must survive as DISABLED, never INVITED.
  const disabledUserId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `INSERT INTO "User" (id,email,"passwordHash",role,active,"updatedAt") VALUES ('${disabledUserId}','disabled@example.test','${hash}','DRIVER',false,now());`,
  ]);
  const v16Snapshot = fullSnapshot();
  prisma(upgradeDb, ['migrate', 'deploy']);
  // A later migration may add a column (V1.9 adds Vehicle.independentDriverProfileId). That is
  // additive, so the comparison drops keys the older snapshot did not have and still demands that
  // every pre-existing value be byte-identical; the new column is asserted separately below.
  assert.deepEqual(
    sameColumnsAs(fullSnapshot(), v16Snapshot),
    sameColumnsAs(v16Snapshot, v16Snapshot),
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      'SELECT count(*) FROM "Vehicle" WHERE "independentDriverProfileId" IS NOT NULL',
    ]),
    '0',
  );
  for (const [table, rows] of [
    ['ServiceZone', '1'],
    ['RatePlan', '1'],
    ['RateBand', '1'],
    ['DeliveryQuote', '1'],
    ['Vehicle', '1'],
    ['IntegrationClient', '1'],
    ['ProviderMembership', '1'],
    ['Driver', '1'],
  ])
    assert.equal(
      sql(upgradeDb, ['-c', `SELECT count(*) FROM "${table}"`]),
      rows,
    );
  // V1.7 backfill: the pre-existing ACCEPTED quote gets exactly one never-offered EXPIRED dispatch.
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id = d."deliveryQuoteId" WHERE q."publicId" = 'MQ-000001' AND d.status = 'EXPIRED' AND d."deliveryRequestId" = '${deliveryRequestId}' AND d."expiredAt" IS NOT NULL`,
    ]),
    '1',
  );
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "DispatchCandidate"']),
    '0',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "DeliveryQuote" q WHERE q.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM "Dispatch" d WHERE d."deliveryQuoteId" = q.id)`,
    ]),
    '0',
  );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('Dispatch_values_check','DispatchCandidate_values_check','Dispatch_deliveryQuoteId_fkey','Dispatch_deliveryRequestId_fkey','DispatchCandidate_dispatchId_fkey','DispatchCandidate_providerId_fkey','ProviderServiceCoverage_providerId_fkey','ProviderServiceCoverage_serviceZoneId_fkey')",
      ]),
      '8',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('Dispatch_deliveryQuoteId_key','DispatchCandidate_dispatchId_providerId_key','ProviderServiceCoverage_providerId_serviceZoneId_serviceTyp_key') OR (indexname = 'DispatchCandidate_claimed_dispatch_key' AND indexdef LIKE '%WHERE%CLAIMED%')",
      ]),
      '4',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('Dispatch_guard','DispatchCandidate_guard')",
      ]),
      '2',
    );
  }
  // V1.8: assignments are a new history table; the upgrade creates no rows for existing data.
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "DeliveryAssignment"']),
    '0',
  );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('DeliveryAssignment_values_check','DeliveryAssignment_reason_check','DeliveryAssignment_dispatchId_fkey','DeliveryAssignment_providerId_fkey','DeliveryAssignment_driverId_fkey','DeliveryAssignment_vehicleId_fkey','DeliveryAssignment_assignedByUserId_fkey','DeliveryAssignment_endedByUserId_fkey')",
      ]),
      '8',
    );
    // One ACTIVE per dispatch, per driver and per vehicle, enforced by PostgreSQL.
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('DeliveryAssignment_active_dispatch_key','DeliveryAssignment_active_driver_key','DeliveryAssignment_active_vehicle_key') AND indexdef LIKE '%WHERE%ACTIVE%'",
      ]),
      '3',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname = 'DeliveryAssignment_guard'",
      ]),
      '1',
    );
    // A claimed dispatch cannot be released or expired while an assignment is ACTIVE.
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_proc WHERE proname = 'dispatch_guard' AND prosrc LIKE '%DISPATCH_HAS_ACTIVE_ASSIGNMENT%'",
      ]),
      '1',
    );
  }
  // V1.9: independent drivers. The upgrade adds the capability without touching existing data:
  // every V1.8 assignment stays FLEET with its provider, and every vehicle keeps its owner.
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "IndependentDriverProfile"']),
    '0',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "DeliveryAssignment" WHERE mode <> 'FLEET' OR "providerId" IS NULL`,
    ]),
    '0',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      'SELECT count(*) FROM "Vehicle" WHERE "providerId" IS NULL',
    ]),
    '0',
  );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('Vehicle_owner_check','DeliveryAssignment_mode_check','IndependentDriverProfile_values_check','IndependentDriverProfile_driverId_fkey','DeliveryAssignment_independentDriverProfileId_fkey','Vehicle_independentDriverProfileId_fkey','Dispatch_claimedByIndependentDriverId_fkey')",
      ]),
      '7',
    );
    // Ownership is immutable, and an independent identifier is unique within its driver.
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('Driver_owner_guard','Vehicle_owner_guard','IndependentDriverProfile_guard')",
      ]),
      '3',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'Vehicle_independent_identifier_key' AND indexdef LIKE '%WHERE%'",
      ]),
      '1',
    );
    // Exactly one claim owner while CLAIMED, and per-mode ownership inside the assignment guard.
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname = 'Dispatch_values_check' AND pg_get_constraintdef(oid) LIKE '%claimedByIndependentDriverId%'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_proc WHERE proname = 'delivery_assignment_guard' AND prosrc LIKE '%independent profile must be APPROVED%'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_proc WHERE proname = 'dispatch_guard' AND prosrc LIKE '%APPROVED independent driver%'",
      ]),
      '1',
    );
  }
  assert.equal(
    sql(upgradeDb, [
      '-c',
      'SELECT count(*) FROM "User" WHERE "passwordHash" IS NULL',
    ]),
    '0',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "User" WHERE id='${disabledUserId}' AND active = false AND "passwordHash"='${hash}'`,
    ]),
    '1',
  );
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "UserInvitation"']),
    '0',
  );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('User_active_password_check','UserInvitation_values_check','UserInvitation_userId_fkey','UserInvitation_providerId_fkey','UserInvitation_createdByUserId_fkey','UserInvitation_revokedByUserId_fkey')",
      ]),
      '6',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE (indexname = 'UserInvitation_pending_user_key' AND indexdef LIKE '%WHERE%PENDING%') OR indexname = 'UserInvitation_tokenHash_key'",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname = 'UserInvitation_immutable'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'passwordHash'",
      ]),
      'YES',
    );
  }
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT "serviceType" FROM "DeliveryRequest" WHERE id='${deliveryRequestId}'`,
    ]),
    'LOCAL_DELIVERY',
  );
  // Exactly the V1.6 pricing fixtures inserted above: the V1.6.1 upgrade adds no pricing rows.
  for (const table of ['ServiceZone', 'RatePlan', 'RateBand', 'DeliveryQuote'])
    assert.equal(
      sql(upgradeDb, ['-c', `SELECT count(*) FROM "${table}"`]),
      '1',
    );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('RatePlan_active_zone_service_key','DeliveryQuote_offered_request_key','DeliveryQuote_accepted_request_key') AND indexdef LIKE '%WHERE%'",
      ]),
      '3',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('RateBand_draft_only','RatePlan_immutable','DeliveryQuote_immutable')",
      ]),
      '3',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_sequences WHERE sequencename = 'DeliveryQuote_publicId_seq'",
      ]),
      '1',
    );
  }
  for (const [table, rows] of [
    ['DeliveryRequest', '1'],
    ['DeliveryStop', '2'],
    ['DeliveryPackage', '1'],
    ['DeliveryFinancialContext', '1'],
    ['ApiIdempotencyRecord', '1'],
  ])
    assert.equal(
      sql(upgradeDb, ['-c', `SELECT count(*) FROM "${table}"`]),
      rows,
    );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('DeliveryRequest_publicId_check','DeliveryRequest_cancellation_check','DeliveryStop_values_check','DeliveryPackage_values_check','DeliveryFinancialContext_goods_check','ApiIdempotencyRecord_hash_check')",
      ]),
      '6',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_sequences WHERE sequencename = 'DeliveryRequest_publicId_seq'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('ApiIdempotencyRecord_integrationClientId_key_key','DeliveryRequest_publicId_key')",
      ]),
      '2',
    );
  }
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('DriverVehicleAssignment_active_driver_key','DriverVehicleAssignment_active_vehicle_key') AND indexdef LIKE '%WHERE%unassignedAt%IS NULL%'",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('Driver_name_check','Vehicle_identifier_check','Vehicle_year_check','DriverVehicleAssignment_period_check','DriverVehicleAssignment_driverId_providerId_fkey','DriverVehicleAssignment_vehicleId_providerId_fkey')",
      ]),
      '6',
    );
  }
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "DeliveryProvider"']),
    '1',
  );
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "ProviderMembership"']),
    '1',
  );
  const after = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT row_to_json(c) FROM "IntegrationClient" c WHERE id='${integrationId}'`,
    ]),
  );
  assert.deepEqual(after, { ...before, status: 'SUSPENDED' });
  const credentials = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT json_agg(c ORDER BY id) FROM "IntegrationCredential" c WHERE "clientId"='${integrationId}'`,
    ]),
  );
  assert.equal(credentials.length, 2);
  assert.equal(
    credentials.find((c) => c.id === activeId).secretHash === hash,
    true,
  );
  assert.equal(credentials.find((c) => c.id === activeId).status, 'ACTIVE');
  assert.deepEqual(credentials.find((c) => c.id === activeId).scopes, []);
  assert.equal(credentials.find((c) => c.id === revokedId).status, 'REVOKED');
  assert.ok(credentials.find((c) => c.id === revokedId).revokedAt);
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "User" WHERE id='${userId}' AND "passwordHash"='${hash}'`,
    ]),
    '1',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "RefreshToken" WHERE id='${refreshId}' AND "tokenHash"='${hash}'`,
    ]),
    '1',
  );
  prisma(upgradeDb, ['migrate', 'deploy']);

  // V1.10: credit accounts. Verified in a dedicated database brought to V1.9 first, so the
  // migration runs over real V1.9 data (providers and independent profiles in every state).
  sql('postgres', ['-c', `CREATE DATABASE "${v19Db}"`]);
  const upToV19 = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => name <= '20260918001000_independent_drivers');
  for (const name of upToV19) {
    sql(v19Db, ['-f', `prisma/migrations/${name}/migration.sql`]);
    prisma(v19Db, ['migrate', 'resolve', '--applied', name]);
  }
  assert.equal(
    sql(v19Db, [
      '-c',
      `SELECT count(*) FROM information_schema.tables WHERE table_name = 'CreditAccount'`,
    ]),
    '0',
  );
  const v19Admin = randomUUID();
  const v19Providers = [randomUUID(), randomUUID()];
  const v19Profiles = {
    approved: [randomUUID(), randomUUID(), randomUUID()],
    suspended: [randomUUID(), randomUUID(), randomUUID()],
    pending: [randomUUID(), randomUUID(), randomUUID()],
  };
  const profileSql = ([userId, driverId, profileId], state) => {
    const approved =
      state === 'pending'
        ? `NULL, NULL`
        : `now() - interval '2 days', '${v19Admin}'`;
    const suspended =
      state === 'suspended'
        ? `now() - interval '1 day', '${v19Admin}'`
        : `NULL, NULL`;
    const status =
      state === 'approved'
        ? 'APPROVED'
        : state === 'suspended'
          ? 'SUSPENDED'
          : 'PENDING';
    return `
      INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${userId}','${state}-${userId}@example.test','${hash}','DRIVER',now());
      INSERT INTO "Driver" (id,"providerId","userId",name,status,"updatedAt") VALUES ('${driverId}','${v19Providers[0]}','${userId}','${state}','ACTIVE',now());
      INSERT INTO "IndependentDriverProfile" (id,"driverId",status,"approvedAt","approvedByUserId","suspendedAt","suspendedByUserId","updatedAt")
        VALUES ('${profileId}','${driverId}','${status}',${approved},${suspended},now());`;
  };
  sql(v19Db, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${v19Admin}','v19-admin@example.test','${hash}','SUPER_ADMIN',now());
    ${v19Providers
      .map(
        (id, i) =>
          `INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES ('${id}','V19 provider ${i}','V19_PROVIDER_${i}','FLEET','${i ? 'SUSPENDED' : 'ACTIVE'}',5,5,now());`,
      )
      .join('\n')}
    ${profileSql(v19Profiles.approved, 'approved')}
    ${profileSql(v19Profiles.suspended, 'suspended')}
    ${profileSql(v19Profiles.pending, 'pending')}
  `,
  ]);
  const v19Tables = [
    'User',
    'DeliveryProvider',
    'Driver',
    'IndependentDriverProfile',
  ];
  const v19Snapshot = () =>
    Object.fromEntries(
      v19Tables.map((table) => [
        table,
        sql(v19Db, ['-c', `SELECT json_agg(t ORDER BY id) FROM "${table}" t`]),
      ]),
    );
  const beforeCredits = v19Snapshot();
  prisma(v19Db, ['migrate', 'deploy']);
  // The credit migration adds tables only: every pre-existing row is byte-identical.
  assert.deepEqual(v19Snapshot(), beforeCredits);
  // One zero-balance account per provider, whatever its status; none invented as a recharge.
  assert.equal(
    sql(v19Db, [
      '-c',
      `SELECT count(*) FROM "CreditAccount" a JOIN "DeliveryProvider" p ON p.id = a."providerId" WHERE a."ownerType" = 'PROVIDER' AND a.balance = 0`,
    ]),
    '2',
  );
  // Accounts belong to the capability once it has been approved: APPROVED and
  // SUSPENDED-after-approval get one, a profile never approved does not.
  assert.equal(
    sql(v19Db, [
      '-c',
      `SELECT count(*) FROM "CreditAccount" WHERE "independentDriverProfileId" IN ('${v19Profiles.approved[2]}','${v19Profiles.suspended[2]}') AND balance = 0 AND "ownerType" = 'INDEPENDENT_DRIVER'`,
    ]),
    '2',
  );
  assert.equal(
    sql(v19Db, [
      '-c',
      `SELECT count(*) FROM "CreditAccount" WHERE "independentDriverProfileId" = '${v19Profiles.pending[2]}'`,
    ]),
    '0',
  );
  assert.equal(sql(v19Db, ['-c', 'SELECT count(*) FROM "CreditAccount"']), '4');
  assert.equal(
    sql(v19Db, ['-c', 'SELECT count(*) FROM "CreditLedgerEntry"']),
    '0',
  );
  // After the migration the triggers take over: a new provider and a newly approved profile get
  // their account at once, and re-approval never creates a second one.
  sql(v19Db, [
    '-c',
    `
    INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES (gen_random_uuid(),'V110 provider','V110_PROVIDER','FLEET','PENDING',5,5,now());
    UPDATE "IndependentDriverProfile" SET status='APPROVED', "approvedAt"=now(), "approvedByUserId"='${v19Admin}', "suspendedAt"=NULL, "suspendedByUserId"=NULL WHERE id IN ('${v19Profiles.pending[2]}','${v19Profiles.suspended[2]}');
  `,
  ]);
  assert.equal(sql(v19Db, ['-c', 'SELECT count(*) FROM "CreditAccount"']), '6');
  assert.equal(
    sql(v19Db, [
      '-c',
      `SELECT count(*) FROM (SELECT "independentDriverProfileId" FROM "CreditAccount" WHERE "independentDriverProfileId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x`,
    ]),
    '0',
  );
  for (const db of [cleanDb, upgradeDb, v19Db]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('CreditAccount_owner_check','CreditAccount_balance_check','CreditLedgerEntry_amount_check','CreditLedgerEntry_type_check','CreditLedgerEntry_text_check','CreditAccount_providerId_fkey','CreditAccount_independentDriverProfileId_fkey','CreditLedgerEntry_creditAccountId_fkey','CreditLedgerEntry_createdByUserId_fkey')",
      ]),
      '9',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('CreditAccount_guard','CreditLedgerEntry_apply','CreditLedgerEntry_guard','CreditLedgerEntry_no_truncate','DeliveryProvider_credit_account','IndependentDriverProfile_credit_account') AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'credit_ledger_guard' AND prosrc LIKE '%current_database()%_test%')",
      ]),
      '6',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('CreditAccount_providerId_key','CreditAccount_independentDriverProfileId_key','CreditLedgerEntry_creditAccountId_idempotencyKey_key','CreditLedgerEntry_sequence_key') AND indexdef LIKE 'CREATE UNIQUE%'",
      ]),
      '4',
    );
  }
  // The upgraded V1.0 -> V1.10 database: its single provider got exactly one empty account.
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "CreditAccount" WHERE "providerId" = '${providerId}' AND balance = 0`,
    ]),
    '1',
  );
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "CreditLedgerEntry"']),
    '0',
  );

  // V1.10-B: credit policies. A dedicated database brought to V1.10-A with real economic history
  // (accounts with RECHARGE/ADMIN_ADJUSTMENT entries) must come out of the V1.10-B migration with
  // every account, balance and ledger entry identical, and with no policy invented by the migration.
  sql('postgres', ['-c', `CREATE DATABASE "${v110aDb}"`]);
  const upToV110A = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => name <= '20260921001200_credit_ledger_purge_test_only');
  for (const name of upToV110A) {
    sql(v110aDb, ['-f', `prisma/migrations/${name}/migration.sql`]);
    prisma(v110aDb, ['migrate', 'resolve', '--applied', name]);
  }
  const v110aAdmin = randomUUID();
  const v110aProvider = randomUUID();
  sql(v110aDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${v110aAdmin}','v110a-admin@example.test','${hash}','SUPER_ADMIN',now());
    INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES ('${v110aProvider}','V110A provider','V110A_PROVIDER','FLEET','ACTIVE',5,5,now());
    INSERT INTO "CreditLedgerEntry" (id,"creditAccountId",type,amount,"balanceBefore","balanceAfter","rechargeMethod","createdByUserId","idempotencyKey","requestHash")
      SELECT gen_random_uuid(), a.id, 'RECHARGE', 500, 0, 500, 'TRANSFER', '${v110aAdmin}', 'v110a-recharge-1', repeat('a', 64)
        FROM "CreditAccount" a WHERE a."providerId" = '${v110aProvider}';
    INSERT INTO "CreditLedgerEntry" (id,"creditAccountId",type,amount,"balanceBefore","balanceAfter",reason,"createdByUserId","idempotencyKey","requestHash")
      SELECT gen_random_uuid(), a.id, 'ADMIN_ADJUSTMENT', -120, 500, 380, 'Ajuste de prueba', '${v110aAdmin}', 'v110a-adjust-1', repeat('b', 64)
        FROM "CreditAccount" a WHERE a."providerId" = '${v110aProvider}';
  `,
  ]);
  const economicSnapshot = () =>
    ['CreditAccount', 'CreditLedgerEntry', 'DeliveryProvider', 'User'].map(
      (table) =>
        sql(v110aDb, [
          '-c',
          `SELECT json_agg(t ORDER BY id) FROM "${table}" t`,
        ]),
    );
  const beforePolicies = economicSnapshot();
  assert.equal(
    sql(v110aDb, [
      '-c',
      `SELECT balance FROM "CreditAccount" WHERE "providerId" = '${v110aProvider}'`,
    ]),
    '380',
  );
  prisma(v110aDb, ['migrate', 'deploy']);
  /**
   * Compares the economy keeping only the columns that existed before the migration: a later
   * version may add a column (V1.10-E adds the refund reference), and that is not a change to the
   * data it preserved. Every value of every previous column must still be identical.
   */
  const sameEconomyAs = (after, before) => {
    const parsed = before.map((json) => JSON.parse(json ?? 'null'));
    const normalize = (rows, previous) =>
      JSON.stringify(
        !previous?.length || !rows?.length
          ? rows
          : rows.map((row) =>
              Object.fromEntries(
                Object.keys(previous[0]).map((key) => [key, row[key]]),
              ),
            ),
      );
    return {
      after: after.map((json, i) =>
        normalize(JSON.parse(json ?? 'null'), parsed[i]),
      ),
      before: parsed.map((rows, i) => normalize(rows, parsed[i])),
    };
  };
  const economy = sameEconomyAs(economicSnapshot(), beforePolicies);
  assert.deepEqual(economy.after, economy.before);
  assert.equal(
    sql(v110aDb, ['-c', 'SELECT count(*) FROM "CreditPolicy"']),
    '0',
  );
  for (const db of [cleanDb, upgradeDb, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_trigger WHERE tgname IN
      ('Dispatch_award_integrity','DispatchCandidate_award_integrity','DeliveryAssignment_award_integrity',
       'CreditLedgerEntry_award_integrity','DispatchCreditSnapshot_award_integrity')
       AND tgdeferrable AND tginitdeferred`,
      ]),
      '5',
    );
    assert.equal(
      sql(db, ['-c', `SELECT count(*) FROM "DispatchPreEnforcementAward"`]),
      '0',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'DeliveryAssignment_independent_award_key'`,
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('CreditPolicy_values_check','CreditPolicy_calculation_check','CreditPolicyRange_values_check','CreditPolicy_createdByUserId_fkey','CreditPolicyRange_creditPolicyId_fkey')",
      ]),
      '5',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('CreditPolicy_serviceType_actorType_version_key','CreditPolicyRange_creditPolicyId_position_key','CreditPolicyRange_creditPolicyId_minDistanceMeters_key') OR (indexname = 'CreditPolicy_active_key' AND indexdef LIKE '%WHERE%ACTIVE%')",
      ]),
      '4',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('CreditPolicy_guard','CreditPolicyRange_guard','CreditPolicy_no_truncate','CreditPolicyRange_no_truncate','CreditPolicy_ranges_check','CreditPolicyRange_ranges_check')",
      ]),
      '6',
    );
  }
  // V1.10-C: dispatch credit snapshots. Dispatches that predate the migration (the upgraded
  // database keeps its V1.7-backfilled EXPIRED dispatch) get no invented, retroactive cost.
  assert.equal(sql(upgradeDb, ['-c', 'SELECT count(*) FROM "Dispatch"']), '1');
  for (const db of [upgradeDb, v19Db, v110aDb])
    assert.equal(
      sql(db, ['-c', 'SELECT count(*) FROM "DispatchCreditSnapshot"']),
      '0',
    );
  for (const db of [cleanDb, upgradeDb, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('DispatchCreditSnapshot_values_check','DispatchCreditSnapshot_dispatchId_fkey','DispatchCreditSnapshot_creditPolicyId_fkey','DispatchCreditSnapshot_appliedRangeId_fkey')",
      ]),
      '4',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'DispatchCreditSnapshot_dispatchId_actorType_key' AND indexdef LIKE 'CREATE UNIQUE%'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('DispatchCreditSnapshot_guard','DispatchCreditSnapshot_no_truncate','Dispatch_credit_snapshots_required')",
      ]),
      '3',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT array_to_string(\"credit_required_actors\"('LOCAL_DELIVERY'), ',')",
      ]),
      'PROVIDER,INDEPENDENT_DRIVER',
    );
  }
  // V1.10-D: credit consumption. The monetization boundary is persisted per Dispatch, every
  // Dispatch that already existed is LEGACY, and no charge is backfilled.
  for (const db of [upgradeDb, v19Db, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM "Dispatch" WHERE "creditMode" <> 'LEGACY'`,
      ]),
      '0',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM "CreditLedgerEntry" WHERE "type" IN ('SERVICE_AWARD', 'SERVICE_REFUND')`,
      ]),
      '0',
    );
  }
  for (const db of [cleanDb, upgradeDb, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('Dispatch_credit_mode_guard','CreditLedgerEntry_service_award_guard')",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'CreditLedgerEntry_service_award_key' AND indexdef LIKE '%WHERE%SERVICE_AWARD%'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname = 'CreditLedgerEntry_award_check'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT column_default FROM information_schema.columns WHERE table_name = 'Dispatch' AND column_name = 'creditMode'`,
      ]),
      `'MONETIZED'::"DispatchCreditMode"`,
    );
  }
  // V1.10-E: refunds compensate an award with a new entry; the migration creates none, and the
  // guarantees that keep a refund tied to its award are in place.
  for (const db of [upgradeDb, v19Db, v110aDb])
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM "CreditLedgerEntry" WHERE "type" = 'SERVICE_REFUND'`,
      ]),
      '0',
    );
  for (const db of [cleanDb, upgradeDb, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_trigger WHERE tgname IN ('CreditLedgerEntry_service_refund_guard','Dispatch_award_refund_required')",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'CreditLedgerEntry_refund_award_key' AND indexdef LIKE '%WHERE%SERVICE_REFUND%'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('CreditLedgerEntry_refund_check','CreditLedgerEntry_reversesEntryId_fkey')",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'CreditRefundReason'`,
      ]),
      '3',
    );
  }
  // V1.11-A: delivery completion. The migration adds the operational close and changes nothing
  // that already happened: no dispatch becomes DELIVERED and no assignment becomes COMPLETED.
  for (const db of [cleanDb, upgradeDb, v19Db, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM "Dispatch" WHERE status = 'DELIVERED' OR "deliveredAt" IS NOT NULL OR "deliveredByUserId" IS NOT NULL`,
      ]),
      '0',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM "DeliveryAssignment" WHERE status = 'COMPLETED'`,
      ]),
      '0',
    );
    // The new states exist in both enums, and the stamp columns are nullable so history stays as
    // it was: an old dispatch simply has no delivery record.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE (t.typname = 'DispatchStatus' AND e.enumlabel = 'DELIVERED') OR (t.typname = 'DeliveryAssignmentStatus' AND e.enumlabel = 'COMPLETED')`,
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'Dispatch' AND column_name IN ('deliveredAt', 'deliveredByUserId') AND is_nullable = 'YES' AND column_default IS NULL`,
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'Dispatch_status_deliveredAt_idx'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname = 'Dispatch_deliveredByUserId_fkey' AND confdeltype = 'r'",
      ]),
      '1',
    );
    // The invariants of the close live in the two constraints the migration rewrote.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conname = 'Dispatch_values_check' AND pg_get_constraintdef(oid) LIKE '%deliveredByUserId%'`,
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conname = 'DeliveryAssignment_values_check' AND pg_get_constraintdef(oid) LIKE '%COMPLETED%'`,
      ]),
      '1',
    );
    // A delivery is not a reversal: the refund trigger must return before demanding one.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_proc WHERE proname = 'dispatch_award_refund_required' AND prosrc LIKE '%DELIVERED%'`,
      ]),
      '1',
    );
  }
  // V1.12-B: the durable B2B event outbox. The migration only creates the table and its
  // guarantees: it records nothing about deliveries that already happened, which is what keeps
  // pre-outbox history legitimate instead of inventing events with fabricated timestamps.
  for (const db of [cleanDb, upgradeDb, v19Db, v110aDb]) {
    assert.equal(sql(db, ['-c', `SELECT count(*) FROM "B2bOutboxEvent"`]), '0');
    // At most one delivery.completed per dispatch, as a partial unique index so future event
    // types that legitimately repeat need no redesign.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'B2bOutboxEvent_delivery_completed_key' AND indexdef LIKE '%WHERE%DELIVERY_COMPLETED%'`,
      ]),
      '1',
    );
    // Ownership and subject are verified by PostgreSQL through composite foreign keys, not
    // trusted from the service layer.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conrelid = '"B2bOutboxEvent"'::regclass AND contype = 'f' AND cardinality(conkey) = 2`,
      ]),
      '2',
    );
    // Immutable and undeletable, like the ledger and the credit snapshots.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_trigger WHERE tgrelid = '"B2bOutboxEvent"'::regclass AND tgname IN ('B2bOutboxEvent_guard', 'B2bOutboxEvent_no_truncate')`,
      ]),
      '2',
    );
    // The enforcement boundary is the transition itself: a deferred constraint trigger that
    // only ever fires for deliveries completed from now on, with no flag added to Dispatch.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_trigger WHERE tgname = 'Dispatch_b2b_delivery_completed_required' AND tgdeferrable AND tginitdeferred`,
      ]),
      '1',
    );
    // The payload is the public contract and says the delivery happened.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conname = 'B2bOutboxEvent_values_check' AND pg_get_constraintdef(oid) LIKE '%b2b_delivery_completed_payload_ok%'`,
      ]),
      '1',
    );
  }
  // V1.12-C: webhook transport. The migration only creates the configuration and the attempt
  // history: no endpoint is invented, no event is delivered retroactively, and no HTTP request
  // is made while migrating.
  for (const db of [cleanDb, upgradeDb, v19Db, v110aDb]) {
    assert.equal(
      sql(db, [
        '-c',
        `SELECT (SELECT count(*) FROM "B2bWebhookEndpoint") + (SELECT count(*) FROM "B2bWebhookDeliveryAttempt")`,
      ]),
      '0',
    );
    // One endpoint per IntegrationClient in this version.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'B2bWebhookEndpoint_integrationClientId_key'`,
      ]),
      '1',
    );
    // Ownership of an attempt is verified by PostgreSQL: its event and its endpoint must both
    // belong to the same client, through composite foreign keys.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conrelid = '"B2bWebhookDeliveryAttempt"'::regclass AND contype = 'f' AND cardinality(conkey) = 2`,
      ]),
      '2',
    );
    // Attempts are append-only and an endpoint can never change owner.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_trigger WHERE tgname IN ('B2bWebhookDeliveryAttempt_guard', 'B2bWebhookDeliveryAttempt_no_truncate', 'B2bWebhookEndpoint_guard')`,
      ]),
      '3',
    );
    // A SUCCEEDED attempt is exactly "the endpoint answered 2xx"; a FAILED one always says why.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conname = 'B2bWebhookDeliveryAttempt_values_check' AND pg_get_constraintdef(oid) LIKE '%failureKind%'`,
      ]),
      '1',
    );
  }
  // V1.12-D: reliable delivery. The migration only adds the transport state and the signing
  // columns; it delivers nothing, schedules nothing retroactively and rewrites no attempt.
  for (const db of [cleanDb, upgradeDb, v19Db, v110aDb]) {
    assert.equal(
      sql(db, ['-c', `SELECT count(*) FROM "B2bWebhookDelivery"`]),
      '0',
    );
    // The enforcement boundary of automatic delivery: a column on the endpoint, set to the
    // moment of the migration, so nothing recorded before it is ever sent on its own.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'B2bWebhookEndpoint' AND column_name IN ('deliverFrom', 'secretCiphertext', 'secretSetAt')`,
      ]),
      '3',
    );
    // One transport state per event, and both of its owners verified by composite keys.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'B2bWebhookDelivery_eventId_key'`,
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conrelid = '"B2bWebhookDelivery"'::regclass AND contype = 'f' AND cardinality(conkey) = 2`,
      ]),
      '2',
    );
    // The attempt ordinal is unique per event, and partial because V1.12-C attempts have none.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'B2bWebhookDeliveryAttempt_ordinal_key' AND indexdef LIKE '%WHERE%attemptNumber%'`,
      ]),
      '1',
    );
    // A secret is stored encrypted or not at all, and the state machine cannot hold an
    // impossible combination.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_constraint WHERE conname IN ('B2bWebhookEndpoint_secret_check', 'B2bWebhookDelivery_values_check')`,
      ]),
      '2',
    );
    // A delivery state cannot change what it is about, be reopened after delivery or be deleted.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_trigger WHERE tgname IN ('B2bWebhookDelivery_guard', 'B2bWebhookDelivery_no_truncate')`,
      ]),
      '2',
    );

    // V1.12-E: the listing walks every client's events newest first, with a stable tiebreak.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_indexes WHERE indexname = 'B2bOutboxEvent_occurredAt_id_idx'`,
      ]),
      '1',
    );
    // V1.12-E narrowed the guard: an exhausted handover may be put back in the queue by an
    // administrator, while a delivered one still never reopens and the count still never falls.
    assert.equal(
      sql(db, [
        '-c',
        `SELECT count(*) FROM pg_proc WHERE proname = 'b2b_webhook_delivery_guard'
            AND prosrc LIKE '%a delivered handover cannot be reopened%'
            AND prosrc LIKE '%the attempt count cannot go backwards%'
            AND prosrc NOT LIKE '%an exhausted handover is not rescheduled%'`,
      ]),
      '1',
    );
  }
  console.log(
    `PASS: clean migrations (${cleanDb}) and V1.0 -> V1.1 -> V1.2 -> V1.4 -> V1.5 -> V1.6 -> V1.6.1 -> V1.7 -> V1.8 -> V1.9 -> V1.10 upgrade (${upgradeDb}), V1.9 data -> V1.10 (${v19Db}) and V1.10-A ledger -> V1.10-B -> V1.10-C -> V1.10-D -> V1.10-E -> V1.11-A -> V1.12-B -> V1.12-C -> V1.12-D -> V1.12-E (${v110aDb}); IDs, hashes, users, sessions, revocations, providers, memberships, drivers, vehicles, assignments, delivery requests, service zones, rate plans/bands, quotes and inactive accounts (as DISABLED) preserved; legacy ACCEPTED quotes backfilled with an EXPIRED dispatch; one empty credit account per provider and per ever-approved independent profile, with no ledger entry; V1.10-A accounts, balances and ledger unchanged by V1.10-B and no credit policy created by migration; no credit snapshot backfilled for pre-V1.10-C dispatches; every pre-V1.10-D dispatch marked LEGACY with no award charged; no refund created by migration; no dispatch delivered nor assignment completed by migration; no B2B outbox event created by migration, with its partial unique index, composite ownership keys, immutability triggers and deferred enforcement present; no webhook endpoint or delivery attempt created by migration, with their ownership keys and append-only triggers present; no webhook delivery state created by migration, with the delivery boundary, the encrypted-secret check, the attempt ordinal and the delivery guards present; no operational state created by migration, with the listing index present and the delivery guard narrowed so an administrator can put an exhausted handover back in the queue while a delivered one still never reopens; V1.4-V1.12 constraints, triggers, indexes and sequences present. Verification databases retained.`,
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? `Migration preservation assertion failed: ${error.message}`
      : error.message,
  );
  process.exitCode = 1;
}
