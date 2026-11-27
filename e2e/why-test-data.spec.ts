/**
 * Two small experiments that show why a test data server is worth having.
 * Read the annotations in the HTML report (npm run test:report) for the numbers.
 */
import { test, expect } from './fixtures.ts';

test.describe('Why test data matters', () => {
  test('setup speed: building a 3-item cart through the API vs through the UI', async ({ page, makeUser, loginAs }) => {
    const viaApi = Date.now();
    await makeUser({ cart: ['backpack', 'bike-light', 't-shirt'] });
    const apiMs = Date.now() - viaApi;

    const plain = await makeUser();
    const viaUi = Date.now();
    await loginAs(plain);
    for (const id of ['backpack', 'bike-light', 't-shirt']) await page.getByTestId(`add-${id}`).click();
    await expect(page.getByTestId('cart-count')).toHaveText('3');
    const uiMs = Date.now() - viaUi;

    test.info().annotations.push({ type: 'setup time', description: `API: ${apiMs} ms, UI: ${uiMs} ms` });
    console.log(`3-item cart setup  API: ${apiMs} ms  UI: ${uiMs} ms`);
    expect(apiMs).toBeLessThan(uiMs);
  });

  // These run at the same time (fullyParallel). Each changes its cart and checks the exact count.
  // With one shared login they'd see each other's items and fail at random: classic flaky tests.
  // With a fresh user each, they can't interfere.
  for (const [n, product] of [[1, 'backpack'], [2, 'bike-light'], [3, 'coffee-mug'], [4, 'water-bottle']] as const) {
    test(`parallel isolation ${n}: my cart only ever holds my items`, async ({ page, user, loginAs }) => {
      await loginAs(user);
      await page.getByTestId(`add-${product}`).click();
      await page.getByTestId(`add-${product}`).click();
      await page.getByTestId('nav-cart').click();
      await expect(page.getByTestId('cart-line')).toHaveCount(1);
      await expect(page.getByTestId('line-qty')).toHaveText('x 2');
    });
  }
});
