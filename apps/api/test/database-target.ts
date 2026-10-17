// globalSetup drops schemas. Refuse a cloud/production target even if a shell has leaked its URL.
export function assertLocalTestDatabase(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid TEST_DATABASE_URL'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/(?:^|_)test(?:_|$)/.test(database)) {
    throw new Error('Database tests require a local database with test in its name; refusing to reset this target');
  }
  return input;
}
