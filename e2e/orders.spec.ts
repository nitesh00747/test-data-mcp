import { test, expect } from './fixtures.ts';

test.describe('Order history', () => {
  test('a returning customer sees their past orders, newest first', async ({ page, makeUser, loginAs }) => {
    const regular = await makeUser({
      label: 'regular',
      orders: [
        { items: ['backpack'], status: 'shipped', daysAgo: 40 },
        { items: ['bike-light', 'coffee-mug'], status: 'cancelled', daysAgo: 10 },
        { items: ['water-bottle'], status: 'placed', daysAgo: 1 },
      ],
    });
    await loginAs(regular);
    await page.getByTestId('nav-orders').click();

    await expect(page.getByTestId('order')).toHaveCount(3);
    await expect(page.getByTestId('order-status')).toHaveText(['placed', 'cancelled', 'shipped']);
    await expect(page.getByTestId('order-total')).toHaveText(['$15.00', '$21.75', '$49.99']);
  });

  test('a new customer sees an empty history', async ({ page, user, loginAs }) => {
    await loginAs(user);
    await page.getByTestId('nav-orders').click();
    await expect(page.getByTestId('no-orders')).toBeVisible();
  });
});
