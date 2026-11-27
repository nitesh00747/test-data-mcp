import { test, expect } from './fixtures.ts';

test.describe('Cart', () => {
  test('a cart prepared through the API shows its items and total', async ({ page, makeUser, loginAs }) => {
    const shopper = await makeUser({ cart: ['backpack', { productId: 'coffee-mug', qty: 2 }] });
    await loginAs(shopper);

    await expect(page.getByTestId('cart-count')).toHaveText('3');
    await page.getByTestId('nav-cart').click();
    await expect(page.getByTestId('cart-line')).toHaveCount(2);
    await expect(page.locator('[data-product-id="coffee-mug"]').getByTestId('line-qty')).toHaveText('x 2');
    await expect(page.getByTestId('cart-total')).toHaveText('$68.49'); // 49.99 + 2 x 9.25
  });

  test('adding and removing in the UI updates the cart', async ({ page, user, loginAs }) => {
    await loginAs(user);
    await page.getByTestId('add-bike-light').click();
    await page.getByTestId('add-water-bottle').click();
    await expect(page.getByTestId('cart-count')).toHaveText('2');

    await page.getByTestId('nav-cart').click();
    await page.getByTestId('remove-bike-light').click();
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
    await expect(page.getByTestId('line-name')).toHaveText('Water Bottle');
  });
});
