import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Local history only. Does not checkout, download, migrate, or rebuild the active dist.
const revision = '5978807270c038d9d7e555ad985ee7bfe35718a5';
const destination = resolve('.tmp/b3/old');
mkdirSync(destination, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0)
    throw Error(`B3 legacy preparation failed: ${command}; no remote fallback`);
}
run('git', ['cat-file', '-e', `${revision}^{commit}`]);
run('git', [
  'archive',
  '--format=tar',
  '--output=.tmp/b3/old.tar',
  revision,
  'src',
  'tsconfig.json',
  'tsconfig.build.json',
  'package.json',
]);
run('tar', ['-xf', '.tmp/b3/old.tar', '-C', destination]);
run(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '-p',
  resolve(destination, 'tsconfig.build.json'),
]);
writeFileSync(
  resolve('.tmp/b3/old-build.json'),
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
  JSON.stringify({ revision, compiled: true, output: '.tmp/b3/old/dist' }),
);
