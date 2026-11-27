import { newRunId } from '../src/core/test-data.ts';

/**
 * One id for this whole Playwright run, shared by all its workers (they inherit process.env).
 * Every user the run creates is tagged group:<id>, so teardown removes this run's leftovers only,
 * never another run's (a teammate's, or another CI shard's) data that is still in use.
 */
export default async function globalSetup() {
  process.env.TEST_DATA_GROUP_ID ??= newRunId('pw');
}
