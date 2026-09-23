/** Real B/C backends + current backend against an isolated PostgreSQL database; no reset.
 * Requires the historical commits locally, PostgreSQL CREATEDB, and psql (PSQL_PATH override).
 * Keeps its database and sanitized evidence for inspection; never prints environment values.
 */
import 'dotenv/config';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const dir = '.tmp/check-v110d';
mkdirSync(dir, { recursive: true });
function command(binary, args, name, env = process.env) {
  const result = spawnSync(binary, args, {
    env,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (name)
    writeFileSync(
      `${dir}/${name}.log`,
      (result.stdout ?? '') + (result.stderr ?? ''),
    );
  if (result.status !== 0)
    throw new Error(`${name ?? binary} failed; inspect its local log`);
  return result.stdout;
}
for (const [version, ref] of [
  ['b', '7881efb'],
  ['c', 'a4daeb56fd15d533e8c7a2ccd6838e495fa90b34'],
]) {
  const target = `${dir}/previous-${version}`;
  const files = command('git', [
    'ls-tree',
    '-r',
    '--name-only',
    ref,
    'src',
    'prisma/schema.prisma',
  ])
    .trim()
    .split('\n');
  for (const file of files) {
    mkdirSync(dirname(`${target}/${file}`), { recursive: true });
    writeFileSync(
      `${target}/${file}`,
      command('git', ['show', `${ref}:${file}`]),
    );
  }
  const schema = `${target}/prisma/schema.prisma`;
  writeFileSync(
    schema,
    readFileSync(schema, 'utf8').replace(
      'provider = "prisma-client-js"',
      'provider = "prisma-client-js"\n  output = "../node_modules/@prisma/client"',
    ),
  );
  writeFileSync(`${target}/package.json`, JSON.stringify({ type: 'module' }));
  const config = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
  config.compilerOptions.rootDir = './src';
  config.compilerOptions.outDir = './dist';
  config.include = ['src'];
  config.exclude = ['src/openapi.cli.ts'];
  writeFileSync(`${target}/tsconfig.json`, JSON.stringify(config));
  command(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'generate', '--schema', schema],
    `boundary-${version}-generate`,
  );
  command(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', `${target}/tsconfig.json`],
    `boundary-${version}-build`,
  );
}
const db = `mandaria_boundary_${Date.now()}_test`;
const prisma = new PrismaClient();
try {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
} finally {
  await prisma.$disconnect();
}
writeFileSync(`${dir}/migration-database.json`, JSON.stringify({ db }));
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${db}`;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  TEST_DATABASE_URL: url.toString(),
};
mkdirSync(`${dir}/migrations-b`, { recursive: true });
for (const name of readdirSync('prisma/migrations')) {
  if (name < '20260922001400' || name === 'migration_lock.toml')
    cpSync(`prisma/migrations/${name}`, `${dir}/migrations-b/${name}`, {
      recursive: true,
    });
}
writeFileSync(
  `${dir}/prisma-b.config.ts`,
  `import 'dotenv/config';import {defineConfig} from 'prisma/config';export default defineConfig({schema:${JSON.stringify(resolve('prisma/schema.prisma'))},migrations:{path:${JSON.stringify(resolve(`${dir}/migrations-b`))}}});`,
);
command(
  process.execPath,
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    `${dir}/prisma-b.config.ts`,
  ],
  'boundary-b-deploy',
  env,
);
writeFileSync(
  `${dir}/vitest.boundary.config.ts`,
  `import {defineConfig} from 'vitest/config';export default defineConfig({test:{include:['test/migrations/award-boundary.check.ts'],testTimeout:180000,hookTimeout:180000,fileParallelism:false}});`,
);
command(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    `${dir}/vitest.boundary.config.ts`,
    '--reporter=json',
    `--outputFile=${dir}/migration-results.json`,
  ],
  'boundary-run',
  env,
);
console.log(
  `PASS: authentic B/C/current boundary. Database ${db} retained; evidence in ${dir}/migration-evidence.json.`,
);
