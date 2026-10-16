import 'reflect-metadata';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const backend = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const web = resolve(
  backend,
  '../../driver-verification-web/mandaria-frontend',
);
const pg = 'C:/Program Files/PostgreSQL/18/bin';
export function snapshot(root) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  const files = git('ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean);
  return {
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    status: git('status', '--short'),
    files: Object.fromEntries(
      files.map((p) => [
        p,
        createHash('sha256')
          .update(readFileSync(join(root, p)))
          .digest('hex'),
      ]),
    ),
  };
}
async function port() {
  const s = netServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
export async function environment(
  evidenceDirectory = 'documentary-integrated',
) {
  const temp = mkdtempSync(join(tmpdir(), 'mandaria-doc-integrated-'));
  const data = join(temp, 'pgdata'),
    database = 'documentary_integration_test';
  const pgPort = await port(),
    apiPort = await port(),
    proxyPort = await port(),
    webPort = await port(),
    storePort = await port();
  const origin = (n) => 'http://127.0.0.1:' + n;
  const dbPassword = randomBytes(24).toString('hex');
  const databaseUrl = `postgresql://postgres:${dbPassword}@127.0.0.1:${pgPort}/${database}`;
  const config = join(
    backend,
    '.tmp',
    'documentary-integrated-prisma.config.ts',
  );
  mkdirSync(join(backend, '.tmp'), { recursive: true });
  const output = join(backend, '.tmp', evidenceDirectory);
  mkdirSync(output, { recursive: true });
  const report = {
    started: new Date().toISOString(),
    versions: {
      node: process.version,
      backend: snapshot(backend),
      web: snapshot(web),
    },
    topology: {
      temp,
      data,
      database,
      pgPort,
      api: origin(apiPort),
      apiProxy: origin(proxyPort),
      web: origin(webPort),
      storage: origin(storePort),
    },
    checks: [],
    handoffs: [],
    errors: [],
    stopped: false,
  };
  const save = () =>
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  save();
  function run(exe, args, env = {}) {
    const r = spawnSync(exe, args, {
      cwd: temp,
      windowsHide: true,
      encoding: 'utf8',
      ...(exe.endsWith('pg_ctl.exe') ? { stdio: 'ignore' } : {}),
      env: { ...process.env, ...env },
    });
    if (r.status !== 0)
      throw new Error(
        'Process failed: ' + exe.split(/[\\/]/).pop() + '; exit ' + r.status,
      );
    return r.stdout;
  }
  let app,
    db,
    vite,
    storageServer,
    proxy,
    pgStarted = false;
  const originalCwd = process.cwd();
  const close = async () => {
    await vite?.close();
    await app?.close();
    for (const s of [proxy, storageServer])
      if (s?.listening) {
        s.closeAllConnections();
        await new Promise((r) => s.close(r));
      }
    await db?.$disconnect();
    if (pgStarted) {
      run(join(pg, 'pg_ctl.exe'), ['-D', data, '-m', 'fast', '-w', 'stop']);
      pgStarted = false;
    }
    process.chdir(originalCwd);
    report.stopped = true;
    save();
  };
  try {
    const pwfile = join(temp, 'pg-password');
    writeFileSync(pwfile, dbPassword, { mode: 0o600 });
    run(join(pg, 'initdb.exe'), [
      '-D',
      data,
      '-U',
      'postgres',
      '--auth=scram-sha-256',
      '--pwfile',
      pwfile,
      '--encoding=UTF8',
      '--locale=C',
    ]);
    unlinkSync(pwfile);
    run(join(pg, 'pg_ctl.exe'), [
      '-D',
      data,
      '-l',
      join(temp, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${pgPort}`,
      '-w',
      'start',
    ]);
    pgStarted = true;
    run(
      join(pg, 'createdb.exe'),
      ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', database],
      { PGPASSWORD: dbPassword },
    );
    const identity = run(
      join(pg, 'psql.exe'),
      [
        '-X',
        '-At',
        '-h',
        '127.0.0.1',
        '-p',
        String(pgPort),
        '-U',
        'postgres',
        '-d',
        database,
        '-c',
        "SELECT current_database()||'|'||host(inet_server_addr())||'|'||inet_server_port()||'|'||current_setting('data_directory')",
      ],
      { PGPASSWORD: dbPassword },
    )
      .trim()
      .split('|');
    assert.equal(identity[0], database);
    assert.equal(identity[1], '127.0.0.1');
    assert.equal(Number(identity[2]), pgPort);
    assert.equal(resolve(identity[3]), resolve(data));
    const migrations = readdirSync(join(backend, 'prisma/migrations')).filter(
      (x) => /^\d/.test(x),
    );
    assert.equal(migrations.length, 33);
    assert(migrations.includes('20261013000100_driver_verification'));
    writeFileSync(
      config,
      `import {defineConfig} from 'prisma/config';export default defineConfig({schema:${JSON.stringify(join(backend, 'prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(backend, 'prisma/migrations'))}}});`,
    );
    run(
      process.execPath,
      [
        join(backend, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        config,
      ],
      { DATABASE_URL: databaseUrl },
    );
    report.topology.migrations = 33;
    report.topology.identityVerified = true;
    save();
    // Do not load repository .env or inherit external provider credentials.
    process.chdir(temp);
    for (const k of Object.keys(process.env))
      if (
        /^(GOOGLE_|RESEND_|VERIFICATION_SPACES_|AWS_|BOOTSTRAP_|PREQUOTE_|PARTNER_APPLICATIONS_NOTIFY|INTEGRATION_|JWT_)/.test(
          k,
        )
      )
        delete process.env[k];
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      DRIVER_VERIFICATION_LOCAL_ENABLED: 'true',
      MAIL_PROVIDER: 'local_outbox',
      LOCAL_MAIL_OUTBOX_DIR: join(temp, 'outbox'),
      MANDARIA_WEB_URL: origin(webPort),
      ROUTING_PROVIDER: 'local_fake',
      CORS_ORIGINS: origin(webPort),
      TRUST_PROXY_HOPS: '0',
      DISPATCH_SEARCH_POLL_SECONDS: '0',
      AUTOMATIC_DISPATCH_SEARCH_ENABLED: 'false',
      B2B_WEBHOOK_POLL_SECONDS: '0',
      PORT: String(apiPort),
    });
    for (const k of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'INTEGRATION_JWT_SECRET',
    ])
      process.env[k] = randomBytes(48).toString('hex');
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    const objects = new Map(),
      tickets = new Map();
    let denyNextUpload = false,
      mailFail = false;
    const messages = [];
    storageServer = httpServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', origin(webPort));
      res.setHeader('Access-Control-Allow-Methods', 'PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      const ticket = tickets.get(req.url?.slice(1));
      if (
        req.method !== 'PUT' ||
        !ticket ||
        ticket.expires < Date.now() ||
        denyNextUpload
      ) {
        denyNextUpload = false;
        res.writeHead(403).end();
        return;
      }
      if (req.headers.authorization || req.headers.cookie) {
        res.writeHead(400).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 10 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c);
      }
      objects.set(ticket.key, Buffer.concat(chunks));
      res.writeHead(200).end();
    });
    await new Promise((r) => storageServer.listen(storePort, '127.0.0.1', r));
    const storage = {
      async uploadUrl(key) {
        const id = randomBytes(32).toString('hex');
        tickets.set(id, { key, expires: Date.now() + 300000 });
        return origin(storePort) + '/' + id;
      },
      async read(key) {
        if (!objects.has(key)) throw new Error('missing');
        return objects.get(key);
      },
      async write(key, body) {
        objects.set(key, Buffer.from(body));
      },
      async remove(key) {
        objects.delete(key);
      },
    };
    const { LocalOutboxMailProvider } = await import(
      pathToFileURL(join(backend, 'dist/mail/local-outbox-mail.provider.js'))
    );
    const outbox = new LocalOutboxMailProvider(join(temp, 'outbox'));
    const mail = {
      name: 'local_capture',
      async sendDriverVerification(m) {
        if (mailFail) throw new Error('controlled local failure');
        messages.push(structuredClone(m));
        await outbox.sendDriverVerification(m);
      },
      async sendUserInvitation(m) {
        messages.push(structuredClone(m));
        await outbox.sendUserInvitation(m);
      },
      async sendPartnerApplicationNotice(m) {
        messages.push(structuredClone(m));
        await outbox.sendPartnerApplicationNotice(m);
      },
    };
    const { Test } = await import('@nestjs/testing');
    const { AppModule } = await import(
      pathToFileURL(join(backend, 'dist/app.module.js'))
    );
    const { setup } = await import(
      pathToFileURL(join(backend, 'dist/setup.js'))
    );
    const { MAIL_PROVIDER } = await import(
      pathToFileURL(join(backend, 'dist/mail/mail.types.js'))
    );
    const { VERIFICATION_STORAGE } = await import(
      pathToFileURL(join(backend, 'dist/verification/verification-storage.js'))
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_PROVIDER)
      .useValue(mail)
      .overrideProvider(VERIFICATION_STORAGE)
      .useValue(storage)
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    setup(app);
    await app.listen(apiPort, '127.0.0.1');
    const { VerificationNotifications } = await import(
      pathToFileURL(
        join(backend, 'dist/verification/verification-notifications.js'),
      )
    );
    const notices = app.get(VerificationNotifications);
    notices.onModuleDestroy();
    let lose = null;
    const lost = [];
    let nextCaseRead = 0;
    proxy = httpServer(async (req, res) => {
      if (
        req.method === 'GET' &&
        (req.url || '').startsWith('/api/v1/verification-cases/')
      ) {
        const delay = Math.max(0, nextCaseRead - Date.now());
        nextCaseRead = Date.now() + delay + 850;
        await new Promise((r) => setTimeout(r, delay));
        if (req.destroyed) return;
      }
      const upstream = httpRequest(
        origin(apiPort) + (req.url || '/'),
        { method: req.method, headers: req.headers },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => {
            if (lose && req.method === 'POST' && req.url === lose) {
              lost.push({
                path: lose,
                key: req.headers['idempotency-key'],
                status: r.statusCode,
              });
              lose = null;
              setTimeout(
                () => res.destroy(),
                25000,
              ).unref(); /* Withhold committed response until real Web's 20s timeout. */
            } else {
              res.writeHead(r.statusCode, r.headers);
              res.end(Buffer.concat(chunks));
            }
          });
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r));
    const { createServer } = await import(
      pathToFileURL(join(web, 'node_modules/vite/dist/node/index.js'))
    );
    const react = (
      await import(
        pathToFileURL(
          join(web, 'node_modules/@vitejs/plugin-react/dist/index.js'),
        )
      )
    ).default;
    vite = await createServer({
      root: web,
      configFile: false,
      envDir: false,
      plugins: [react()],
      define: {
        'import.meta.env.VITE_API_URL': JSON.stringify(origin(proxyPort)),
      },
      server: { host: '127.0.0.1', port: webPort, strictPort: true },
    });
    await vite.listen();
    const { chromium, expect } = await import(
      pathToFileURL(join(web, 'node_modules/@playwright/test/index.mjs'))
    );
    save();
    console.log('ISOLATED_READY ' + JSON.stringify(report.topology));
    return {
      report,
      save,
      close,
      db,
      app,
      temp,
      output,
      api: origin(proxyPort) + '/api/v1',
      web: origin(webPort),
      storage,
      objects,
      tickets,
      messages,
      notices,
      chromium,
      expect,
      loseResponse: (path) => {
        lose = '/api/v1' + path;
      },
      lost,
      failMail: (v) => {
        mailFail = v;
      },
      denyUpload: () => {
        denyNextUpload = true;
      },
      databaseUrl,
      run,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
