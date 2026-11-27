import { test, expect } from './fixtures.ts';

test.describe('Login', () => {
  test('a fresh user logs in and lands on the shop', async ({ page, user, loginAs }) => {
    await loginAs(user);
    await expect(page).toHaveURL(/\/shop$/);
    await expect(page.getByTestId('title')).toHaveText('Products');
    await expect(page.getByTestId('signed-in-as')).toHaveText(user.name);
  });

  test('a locked account is refused with a clear message', async ({ page, makeUser, loginAs }) => {
    // The interesting state (locked) is built through the API, not by an admin clicking around
    const locked = await makeUser({ label: 'locked', status: 'locked' });
    await loginAs(locked);
    await expect(page).toHaveURL(/\/\?error=/);
    await expect(page.getByTestId('error')).toHaveText('This account is locked.');
  });

  test('a wrong password is refused', async ({ page, user, loginAs }) => {
    await loginAs({ ...user, password: 'not-the-password' });
    await expect(page.getByTestId('error')).toHaveText('Username or password is incorrect.');
  });
});
