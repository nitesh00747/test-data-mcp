import { newRunId } from '../src/core/test-data.ts';

/**
 * One id for this whole Playwright run, shared by all its workers (they inherit process.env).
 * Every user the run creates is tagged group:<id>, so teardown removes this run's leftovers only,
 * never another run's (a teammate's, or another CI shard's) data that is still in use.
 */
export default async function globalSetup() {
  // Always a new id. Reusing one set from outside (e.g. the same value on two CI shards) would put
  // two runs in one group, and each run's teardown would delete the other's data.
  if (process.env.TEST_DATA_GROUP_ID) {
    console.warn(`TEST_DATA_GROUP_ID was already set (${process.env.TEST_DATA_GROUP_ID}); using a fresh id instead so runs never share a group.`);
  }
  process.env.TEST_DATA_GROUP_ID = newRunId('pw');
}
