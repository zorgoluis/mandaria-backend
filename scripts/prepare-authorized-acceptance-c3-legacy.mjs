import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Local history only. Does not checkout, download, migrate, or rebuild the active dist.
const revision = '3e9e194a3fba78536802123d32edc4c82ac68bc7';
const destination = resolve('.tmp/c3/old');
mkdirSync(destination, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0)
    throw Error(`C3 legacy preparation failed: ${command}; no remote fallback`);
}
run('git', ['cat-file', '-e', `${revision}^{commit}`]);
run('git', [
  'archive',
  '--format=tar',
  '--output=.tmp/c3/old.tar',
  revision,
  'src',
  'tsconfig.json',
  'tsconfig.build.json',
  'package.json',
]);
run('tar', ['-xf', '.tmp/c3/old.tar', '-C', destination]);
run(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '-p',
  resolve(destination, 'tsconfig.build.json'),
]);
writeFileSync(
  resolve('.tmp/c3/old-build.json'),
  JSON.stringify(
    {
      revision,
      localHistory: true,
      isolatedOutput: true,
      dependencies:
        'current installed dependencies and Prisma client; no download',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ revision, compiled: true, output: '.tmp/c3/old/dist' }),
);
