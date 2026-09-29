import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve('.tmp/c2');
mkdirSync(root, { recursive: true });
mkdirSync('docs/checks', { recursive: true });
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
  throw Error('Local PostgreSQL required');
const stateFile = resolve(root, 'databases.json');
let state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : null;
const url = (name) => {
  const u = new URL(source);
  u.pathname = '/' + name;
  return u.toString();
};
const evidenceFile = 'docs/checks/v1.13-c2-evidence.json';
const evidence = existsSync(evidenceFile)
  ? JSON.parse(readFileSync(evidenceFile, 'utf8'))
  : { node: process.version, attempts: [] };
const sanitize = (text) => {
  let s = String(text);
  for (const [k, v] of Object.entries(process.env))
    if (/SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(k) && v && v.length >= 8)
      s = s.split(v).join('[REDACTED]');
  return s
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]');
};
if (process.argv[2] === 'init') {
  if (state) throw Error('Databases already initialized');
  const tag = randomBytes(5).toString('hex');
  state = {
    clean: `mandaria_c2_clean_${tag}_test`,
    upgrade: `mandaria_c2_upgrade_${tag}_test`,
  };
  const admin = new PrismaClient({ datasourceUrl: url('postgres') });
  try {
    for (const name of Object.values(state))
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
  writeFileSync(stateFile, JSON.stringify(state));
  evidence.databases = state;
} else {
  if (!state) throw Error('Initialize isolated test databases first');
  const [label, ...args] = process.argv.slice(2);
  if (!label || !args.length) throw Error('label and node arguments required');
  const index = evidence.attempts.length + 1;
  const log = `docs/checks/v1.13-c2-${index}-${label}.txt`;
  const begin = new Date().toISOString();
  const run = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      TEST_DATABASE_URL: url(state.clean),
      C2_UPGRADE_DATABASE: state.upgrade,
    },
    encoding: 'utf8',
    maxBuffer: 40 * 1024 * 1024,
  });
  writeFileSync(
    log,
    sanitize(
      (run.stdout || '') +
        (run.stderr || '') +
        (run.error ? String(run.error) : ''),
    ),
  );
  evidence.attempts.push({
    label,
    command: ['node', ...args].join(' '),
    startedAt: begin,
    endedAt: new Date().toISOString(),
    exit: run.status,
    signal: run.signal,
    log,
  });
  console.log(
    JSON.stringify({ label, exit: run.status, signal: run.signal, log }),
  );
  process.exitCode = run.status ?? 1;
}
writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
