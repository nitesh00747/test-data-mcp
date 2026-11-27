import { TestDataClient } from '../src/core/test-data.ts';

/** Safety net after the run: delete anything this run's workers left behind (e.g. after a crash). */
export default async function globalTeardown() {
  const groupId = process.env.TEST_DATA_GROUP_ID;
  if (!groupId) return;
  const client = new TestDataClient({ owner: 'teardown', groupId });
  const removed = await client.cleanup('group').catch((e: Error) => {
    console.warn(`global teardown: cleanup failed: ${e.message}`);
    return 0;
  });
  if (removed) console.log(`global teardown: removed ${removed} leftover test user(s) from run ${groupId}`);
}
