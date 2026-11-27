import { test, expect } from './fixtures.ts';

test.describe('Checkout', () => {
  test('a shopper with items in the cart places an order', async ({ page, makeUser, loginAs }) => {
    const shopper = await makeUser({ cart: ['rain-jacket'] });
    await loginAs(shopper);
    await page.getByTestId('nav-cart').click();
    await page.getByTestId('checkout').click();

    await expect(page).toHaveURL(/\/orders\?placed=ORD-/);
    await expect(page.getByTestId('order-placed')).toContainText('is placed');
    await expect(page.getByTestId('order')).toHaveCount(1);
    await expect(page.getByTestId('order-total')).toHaveText('$89.00');
    await expect(page.getByTestId('cart-count')).toHaveText('0');
  });

  test('an expired card is declined and the cart is kept', async ({ page, makeUser, loginAs }) => {
    // Without a test data API this state is hard to reach: you'd need a real expired card on file
    const shopper = await makeUser({ card: 'expired', cart: ['t-shirt'] });
    await loginAs(shopper);
    await page.getByTestId('nav-cart').click();
    await expect(page.getByTestId('payment-card')).toContainText('(expired)');
    await page.getByTestId('checkout').click();

    await expect(page.getByTestId('error')).toHaveText('Payment declined: card ending 4242 has expired.');
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
  });
});
