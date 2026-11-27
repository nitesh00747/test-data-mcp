import { TestDataClient } from '../src/core/test-data.ts';

/**
 * Safety net after the whole run: delete any test data a Playwright worker left behind
 * (for example after a crash). Only users tagged owner:playwright-* are removed.
 */
export default async function globalTeardown() {
  const client = new TestDataClient({ owner: 'teardown' });
  const leftovers = (await client.listUsers('all').catch(() => [])).filter((u) => u.tags.some((t) => t.startsWith('owner:playwright-')));
  for (const u of leftovers) await client.deleteUser(u.id).catch(() => {});
  if (leftovers.length) console.log(`global teardown: removed ${leftovers.length} leftover test user(s)`);
}
