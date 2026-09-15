import 'dotenv/config';

export function testDatabaseUrl(): string {
  const source = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) throw new Error('Configure DATABASE_URL or TEST_DATABASE_URL');
  const url = new URL(source);
  if (!process.env.TEST_DATABASE_URL) url.pathname = '/mandaria_test';
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.pathname.endsWith('_test')
  ) {
    throw new Error('Test database name must end in _test');
  }
  if (process.env.DATABASE_URL) {
    const main = new URL(process.env.DATABASE_URL);
    if (
      main.hostname === url.hostname &&
      (main.port || '5432') === (url.port || '5432') &&
      main.pathname === url.pathname
    ) {
      throw new Error('Test database must differ from DATABASE_URL');
    }
  }
  return url.toString();
}
