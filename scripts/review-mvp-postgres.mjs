// Windows: disposable loopback-only PostgreSQL cluster, never the installed service.
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const bin = 'C:/Program Files/PostgreSQL/18/bin';
const directory = resolve('.tmp/mvp/pg-isolated');
const root = resolve('.tmp/mvp');
const resume = process.argv[2] === 'resume';
if (!directory.startsWith(root + '\\') || (existsSync(join(directory, 'PG_VERSION')) && !resume)) throw Error('Fresh workspace cluster required');
mkdirSync(root, { recursive: true });
const env = { ...process.env, TEST_DATABASE_URL: 'postgresql://mvp_review@127.0.0.1:55439/mandaria_mvp_20261001_test', NODE_ENV: 'test' };
delete env.DATABASE_URL;
const evidence = resume ? JSON.parse(readFileSync('docs/checks/mvp-closure-postgres.json', 'utf8')) : { scope: 'Disposable PostgreSQL 18 cluster on loopback:55439; installed service untouched', database: 'mandaria_mvp_20261001_test', attempts: [] };
const save = () => writeFileSync('docs/checks/mvp-closure-postgres.json', JSON.stringify(evidence, null, 2) + '\n');
function run(label, binary, args, display = args.join(' ')) {
  const startedAt = new Date().toISOString();
  const log = `docs/checks/mvp-closure-pg-${label}${resume ? '-attempt-' + (evidence.attempts.length + 1) : ''}.txt`;
  const fd = openSync(log, 'w');
  let r;
  try { r = spawnSync(binary, args, { env: label === 'migrate' ? { ...env, DATABASE_URL: env.TEST_DATABASE_URL } : env, encoding: 'utf8', timeout: 360000, stdio: ['ignore', fd, fd] }); } finally { closeSync(fd); }
  writeFileSync(log, (readFileSync(log, 'utf8') + (r.error ? String(r.error) : '')).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]'));
  evidence.attempts.push({ label, command: `${binary.endsWith('node.exe') ? 'node' : binary} ${display}`, startedAt, endedAt: new Date().toISOString(), exit: r.status, signal: r.signal, log });
  save(); console.log(JSON.stringify(evidence.attempts.at(-1)));
  return r.status === 0;
}
let initialized = false;
try {
  if (!resume && !run('init', join(bin, 'initdb.exe'), ['-D', directory, '-U', 'mvp_review', '-A', 'trust', '--encoding=UTF8', '--locale=C'])) throw Error('Initialization failed');
  initialized = true;
  if (!run('start', join(bin, 'pg_ctl.exe'), ['-D', directory, '-l', join(root, 'pg-isolated.log'), '-o', '-h 127.0.0.1 -p 55439', '-w', 'start'])) throw Error('Start failed');
  if (!evidence.attempts.some(a => a.label === 'create' && a.exit === 0) && !run('create', join(bin, 'createdb.exe'), ['-h', '127.0.0.1', '-p', '55439', '-U', 'mvp_review', 'mandaria_mvp_20261001_test'])) throw Error('Create failed');
  if (!evidence.attempts.some(a => a.label === 'migrate' && a.exit === 0) && !run('migrate', process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma.config.ts'])) throw Error('Migration failed');
  if (!run('version', join(bin, 'psql.exe'), ['-X','-w','-h','127.0.0.1','-p','55439','-U','mvp_review','-d','mandaria_mvp_20261001_test','-c','SELECT current_database(), version();'])) throw Error('Version failed');
  const first = run('threads', process.execPath, ['scripts/review-mvp-local.mjs', 'threads']);
  if (!first) {
    // Single bounded alternative; unchanged whole test file and assertions.
    const last = JSON.parse(readFileSync('docs/checks/mvp-closure-local.json','utf8')).attempts.at(-1);
    const report = existsSync(last.report) ? JSON.parse(readFileSync(last.report,'utf8')) : null;
    const assertions = report?.testResults.flatMap(f=>f.assertionResults) ?? [];
    if (assertions.some(a=>a.status==='failed')) throw Error('Assertion failure: inspect, do not blindly retry');
    if (!run('forks-diagnostic', process.execPath, ['scripts/review-mvp-local.mjs','forks'])) throw Error('Bounded diagnostic did not complete');
  }
} catch (error) {
  console.error(String(error)); process.exitCode = 1;
} finally {
  if (initialized && !run('stop', join(bin, 'pg_ctl.exe'), ['-D', directory, '-m', 'fast', '-w', 'stop'])) process.exitCode = 1;
}
