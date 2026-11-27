/**
 * Tests for the test data library, against a real Practice Shop started on a random port.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../demo-app/server.ts';
import { TestDataClient, TestDataError, assertSafeTarget } from '../src/core/test-data.ts';

let app: Awaited<ReturnType<typeof startApp>>;
let client: TestDataClient;

before(async () => {
  app = await startApp({ port: 0 });
  client = new TestDataClient({ baseUrl: app.url, owner: 'unit' });
});
after(() => app.close());

async function login(username: string, password: string) {
  return fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
}

test('a plain user can log in with the returned credentials', async () => {
  const u = await client.createUser();
  const res = await login(u.username, u.password);
  assert.equal(res.status, 200);
  assert.ok(u.tags.includes('test-data') && u.tags.includes(`run:${client.runId}`));
});

test('usernames are unique and readable', async () => {
  const [a, b] = await Promise.all([client.createUser({ label: 'Checkout Flow' }), client.createUser({ label: 'Checkout Flow' })]);
  assert.notEqual(a.username, b.username);
  assert.match(a.username, new RegExp(`^checkout_flow_${client.runId}_\\d+$`));
});

test('recipes build cart, orders, locked accounts and expired cards', async () => {
  const shopper = await client.createUser({ cart: ['backpack', { productId: 'coffee-mug', qty: 2 }], orders: 3 });
  assert.equal(shopper.cartItems, 3);
  assert.equal(shopper.orderIds.length, 3);
  const detail = (await client.getUser(shopper.id)) as { cart: unknown[]; orderList: { status: string }[] };
  assert.equal(detail.cart.length, 2);
  assert.ok(detail.orderList.every((o) => o.status === 'shipped'));

  const locked = await client.createUser({ status: 'locked' });
  assert.equal((await login(locked.username, locked.password)).status, 403);

  const expired = await client.createUser({ card: 'expired', cart: ['t-shirt'] });
  const { token } = (await (await login(expired.username, expired.password)).json()) as { token: string };
  const checkout = await fetch(`${app.url}/api/checkout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(checkout.status, 402);
});

test('cleanup removes only this run, never other runs or seed users', async () => {
  const other = new TestDataClient({ baseUrl: app.url, owner: 'someone-else' });
  const theirs = await other.createUser();
  const mine = new TestDataClient({ baseUrl: app.url, owner: 'cleanup-test' });
  await mine.createUser();
  await mine.createUser({ orders: 2 });

  assert.equal(await mine.cleanup('run'), 2);
  assert.equal((await mine.listUsers('run')).length, 0);
  assert.ok(await other.getUser(theirs.id), 'the other run keeps its data');
  assert.equal((await login('demo', 'demo123')).status, 200, 'seed user untouched');
  await other.cleanup();
});

test('deleteUser refuses users that are not test data', async () => {
  const seed = app.store.findUsers('seed')[0];
  await assert.rejects(client.deleteUser(seed.id), /not test data/);
});

test('it refuses to point at hosts that are not allowed', () => {
  assert.throws(() => assertSafeTarget('https://shop.example.com', ['localhost']), TestDataError);
  assert.throws(() => new TestDataClient({ baseUrl: 'https://prod.example.com', owner: 'x' }), /Refusing to create test data/);
  assert.doesNotThrow(() => new TestDataClient({ baseUrl: 'https://qa.example.com', owner: 'x', allowedHosts: ['qa.example.com'] }));
});

test('a wrong admin key or a stopped app gives a clear error', async () => {
  const wrongKey = new TestDataClient({ baseUrl: app.url, owner: 'x', adminKey: 'nope' });
  await assert.rejects(wrongKey.createUser(), /403.*x-admin-key/);
  const nobody = new TestDataClient({ baseUrl: 'http://127.0.0.1:9', owner: 'x' });
  await assert.rejects(nobody.createUser(), /Can't reach the app/);
});

test('cleanup', async () => {
  await client.cleanup();
});
