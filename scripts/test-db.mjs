import { spawnSync } from 'node:child_process';
const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
for (const script of ['db:test:deploy', 'test:e2e']) {
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm run ${script}`]
      : ['run', script];
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
