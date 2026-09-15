import 'dotenv/config';
import { spawnSync } from 'node:child_process';
const url = new URL(process.env.DATABASE_URL);
url.pathname = '/mandaria_test';
const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
const args =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run db:migrate && npm run test:e2e']
    : ['run', 'db:migrate'];
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  TEST_DATABASE_URL: url.toString(),
};
let result = spawnSync(command, args, { stdio: 'inherit', env });
if (process.platform !== 'win32' && result.status === 0)
  result = spawnSync('npm', ['run', 'test:e2e'], { stdio: 'inherit', env });
process.exitCode = result.status ?? 1;
