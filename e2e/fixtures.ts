/**
 * Playwright fixtures for test data.
 *
 *   testData   one TestDataClient per worker, tagged with the worker, so parallel workers never mix data
 *   user       a fresh, plain user for this test, deleted afterwards
 *   makeUser   build users from a recipe: makeUser({ cart: ['backpack'], card: 'expired' })
 *   loginAs    log in through the UI as a given user
 *
 * Tests describe the data they need; the fixtures build it through the API in milliseconds and
 * remove it when the test ends, pass or fail.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { TestDataClient, type TestUser, type UserRecipe } from '../src/core/test-data.ts';

type TestFixtures = {
  user: TestUser;
  makeUser: (recipe?: UserRecipe) => Promise<TestUser>;
  loginAs: (user: TestUser) => Promise<void>;
};
type WorkerFixtures = { testData: TestDataClient };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  testData: [
    async ({}, use, workerInfo) => {
      const client = new TestDataClient({ owner: `playwright-w${workerInfo.workerIndex}` });
      await use(client);
      await client.cleanup('run'); // anything a test left behind in this worker
    },
    { scope: 'worker' },
  ],

  makeUser: async ({ testData }, use, testInfo) => {
    const created: TestUser[] = [];
    await use(async (recipe = {}) => {
      const u = await testData.createUser({ label: recipe.label ?? testInfo.title.split(' ').slice(0, 3).join('_'), ...recipe });
      created.push(u);
      testInfo.annotations.push({ type: 'test user', description: `${u.username} (${u.id})` });
      return u;
    });
    for (const u of created) await testData.deleteUser(u.id).catch(() => {}); // already gone is fine
  },

  user: async ({ makeUser }, use) => {
    await use(await makeUser());
  },

  loginAs: async ({ page }, use) => {
    await use(async (u: TestUser) => {
      await page.goto('/');
      await page.getByTestId('username').fill(u.username);
      await page.getByTestId('password').fill(u.password);
      await page.getByTestId('login-button').click();
    });
  },
});

export { expect, type Page };
