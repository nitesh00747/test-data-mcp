/**
 * Tests for the test data library, against a real Practice Shop started on a random port.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_ADMIN_KEY, sameKey, startApp, testDataApiEnabled } from '../demo-app/server.ts';
import { mcpOwner } from '../src/mcp/server.ts';
import globalSetup from '../e2e/global-setup.ts';
import { TestDataClient, TestDataError, UserTracker, assertSafeTarget, newRunId } from '../src/core/test-data.ts';

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

// ---------- review fixes ----------

const admin = { 'x-admin-key': DEFAULT_ADMIN_KEY, 'content-type': 'application/json' };

test('#2 the client never follows a redirect, so the admin key cannot leak to another host', async () => {
  let leakedKey: string | undefined;
  const elsewhere = createServer((req, res) => {
    leakedKey = req.headers['x-admin-key'] as string | undefined;
    res.end('{}');
  }).listen(0, '127.0.0.2');
  await new Promise((r) => elsewhere.once('listening', r));
  const port = (elsewhere.address() as { port: number }).port;
  const redirector = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.2:${port}/steal` });
    res.end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => redirector.once('listening', r));
  try {
    const c = new TestDataClient({ baseUrl: `http://127.0.0.1:${(redirector.address() as { port: number }).port}`, owner: 'x' });
    await assert.rejects(c.createUser(), /redirect/);
    assert.equal(leakedKey, undefined);
  } finally {
    elsewhere.close();
    redirector.close();
  }
});

test('#3 the app itself refuses to delete users that are not test data', async () => {
  const real = app.store.createUser({ username: `real_${newRunId()}`, tags: [] });
  const res = await fetch(`${app.url}/api/test-data/users/${real.id}`, { method: 'DELETE', headers: admin });
  assert.equal(res.status, 403);
  assert.ok(app.store.user(real.id), 'real user still exists');
  const seed = app.store.findUsers('seed')[0];
  assert.equal((await fetch(`${app.url}/api/test-data/users/${seed.id}`, { method: 'DELETE', headers: admin })).status, 403);
});

test('#8 the test data API turns itself off when exposed with the public default key', async () => {
  assert.equal(testDataApiEnabled('127.0.0.1', DEFAULT_ADMIN_KEY, {}).enabled, true);
  assert.equal(testDataApiEnabled('0.0.0.0', DEFAULT_ADMIN_KEY, {}).enabled, false);
  assert.equal(testDataApiEnabled('0.0.0.0', 'a-real-secret', {}).enabled, true);
  assert.equal(testDataApiEnabled('127.0.0.1', DEFAULT_ADMIN_KEY, { ENABLE_TEST_DATA_API: 'false' }).enabled, false);

  const exposed = await startApp({ port: 0, host: '0.0.0.0', env: {} });
  try {
    assert.equal(exposed.testDataApi, false);
    const res = await fetch(`${exposed.url}/api/test-data/users`, { method: 'POST', headers: admin, body: '{}' });
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${exposed.url}/api/health`)).status, 200, 'the shop itself still works');
  } finally {
    await exposed.close();
  }
});

test('#1 run ids are random, so two clients never collide', async () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newRunId('mcp')));
  assert.equal(ids.size, 1000);
  const a = new TestDataClient({ baseUrl: app.url, owner: 'mcp' });
  const b = new TestDataClient({ baseUrl: app.url, owner: 'mcp' });
  assert.notEqual(a.runId, b.runId);
  await a.createUser({ label: 'same' });
  await b.createUser({ label: 'same' }); // used to fail with 409 when ids repeated
  await a.cleanup();
  await b.cleanup();
});

test('#4 #5 cleanup scopes never reach another run\'s fresh data', async () => {
  const groupA = newRunId('pw');
  const w0 = new TestDataClient({ baseUrl: app.url, owner: 'playwright-w0', groupId: groupA });
  const w1 = new TestDataClient({ baseUrl: app.url, owner: 'playwright-w1', groupId: groupA });
  const otherRun = new TestDataClient({ baseUrl: app.url, owner: 'playwright-w0', groupId: newRunId('pw') });
  const agent = new TestDataClient({ baseUrl: app.url, owner: 'mcp' });
  const [a0, a1, other, mine] = await Promise.all([w0.createUser(), w1.createUser(), otherRun.createUser(), agent.createUser()]);
  const exists = (id: string) => w0.getUser(id).then(() => true, () => false);

  // group: this Playwright run's workers only
  const teardown = new TestDataClient({ baseUrl: app.url, owner: 'teardown', groupId: groupA });
  assert.equal(await teardown.cleanup('group'), 2);
  assert.deepEqual([await exists(a0.id), await exists(a1.id), await exists(other.id)], [false, false, true]);

  // owner: every session of this owner, nobody else's
  const anotherAgentSession = new TestDataClient({ baseUrl: app.url, owner: 'mcp' });
  assert.equal(await anotherAgentSession.cleanup('owner'), 1);
  assert.equal(await exists(mine.id), false);
  assert.equal(await exists(other.id), true);

  // stale: only data older than the cutoff, and the cutoff can't be tiny
  await assert.rejects(agent.cleanup({ olderThanMinutes: 1 }), /at least 15/);
  assert.equal(await agent.cleanup({ olderThanMinutes: 60 }), 0, 'fresh data is never "abandoned"');
  app.store.user(other.id).lastUsedAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  assert.equal(await agent.cleanup({ olderThanMinutes: 120 }), 1);
  assert.equal(await exists(other.id), false);

  assert.throws(() => (agent as unknown as { requireGroup(): string }).requireGroup(), /no groupId/);
});

test('#9 the tracker ignores users already gone but reports real failures', async () => {
  const tracker = new UserTracker(client);
  const u = tracker.track(await client.createUser());
  const gone = tracker.track(await client.createUser());
  await client.deleteUser(gone.id); // deleted elsewhere first: fine
  tracker.track({ id: app.store.findUsers('seed')[0].id }); // can't be deleted: must be reported
  const problems = await tracker.dispose();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not test data/);
  await assert.rejects(client.getUser(u.id), (e: TestDataError) => e.status === 404);
});

test('#6 bad input gets a 400 with a reason, not a 500', async () => {
  const u = await client.createUser();
  for (const body of [{ daysAgo: 'soon' }, { daysAgo: -1 }, { daysAgo: 1.5 }, { items: 'mug' }, { items: [{ productId: 'coffee-mug', qty: 0 }] }]) {
    const res = await fetch(`${app.url}/api/test-data/users/${u.id}/orders`, { method: 'POST', headers: admin, body: JSON.stringify(body) });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(((await res.json()) as { error: string }).error);
  }
});

// ---------- second review ----------

test('N1 each person\'s agent has its own owner, so "my sessions" cleanup spares teammates', async () => {
  assert.equal(mcpOwner({ TEST_DATA_OWNER: 'mcp-ci' }), 'mcp-ci');
  assert.match(mcpOwner({}), /^mcp-.+/);
  const alice = new TestDataClient({ baseUrl: app.url, owner: 'mcp-alice' });
  const bob = new TestDataClient({ baseUrl: app.url, owner: 'mcp-bob' });
  const hers = await alice.createUser();
  await bob.createUser();
  assert.equal(await bob.cleanup('owner'), 1);
  assert.ok(await alice.getUser(hers.id), "Alice's user survived Bob's cleanup");
  await alice.cleanup();
});

test('N2 "abandoned" goes by last use, so old data still in use is kept', async () => {
  const sweeper = new TestDataClient({ baseUrl: app.url, owner: 'sweeper' });
  const explorer = new TestDataClient({ baseUrl: app.url, owner: 'mcp-explorer' });
  const inUse = await explorer.createUser();
  const forgotten = await explorer.createUser();
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  for (const id of [inUse.id, forgotten.id]) Object.assign(app.store.user(id), { createdAt: threeHoursAgo, lastUsedAt: threeHoursAgo });

  // Someone logs in as the first user just now: that counts as use
  const login = await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: inUse.username, password: inUse.password }) });
  assert.equal(login.status, 200);

  assert.equal(await sweeper.cleanup({ olderThanMinutes: 120 }), 1);
  assert.ok(await explorer.getUser(inUse.id), 'recently used user kept');
  await assert.rejects(explorer.getUser(forgotten.id), (e: TestDataError) => e.status === 404);
  await explorer.cleanup();
});

test('N3 everything the test data API creates is tagged test-data, and "seed" is reserved', async () => {
  const bad = await fetch(`${app.url}/api/test-data/users`, { method: 'POST', headers: admin, body: JSON.stringify({ tags: ['seed'] }) });
  assert.equal(bad.status, 400);
  const untagged = await fetch(`${app.url}/api/test-data/users`, { method: 'POST', headers: admin, body: JSON.stringify({ tags: ['whatever'] }) });
  const u = (await untagged.json()) as { id: string; tags: string[] };
  assert.deepEqual(u.tags, ['test-data', 'whatever']);
  assert.equal((await fetch(`${app.url}/api/test-data/users/${u.id}`, { method: 'DELETE', headers: admin })).status, 200, 'so it can always be cleaned up');
});

test('N4 every Playwright run gets a fresh group id, even if one was set from outside', async () => {
  const before = process.env.TEST_DATA_GROUP_ID;
  process.env.TEST_DATA_GROUP_ID = 'shared-by-mistake';
  const warn = console.warn;
  console.warn = () => {};
  try {
    await globalSetup();
    const first = process.env.TEST_DATA_GROUP_ID;
    await globalSetup();
    assert.notEqual(first, 'shared-by-mistake');
    assert.notEqual(process.env.TEST_DATA_GROUP_ID, first);
  } finally {
    console.warn = warn;
    if (before === undefined) delete process.env.TEST_DATA_GROUP_ID;
    else process.env.TEST_DATA_GROUP_ID = before;
  }
});

test('N5 logins expire, and the admin key check is constant-time', async () => {
  const u = await client.createUser();
  const { token } = (await (await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: u.password }) })).json()) as { token: string };
  const cart = () => fetch(`${app.url}/api/cart`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await cart()).status, 200);
  app.store.expireSession(token);
  assert.equal((await cart()).status, 401);

  assert.equal(sameKey('local-admin-key', 'local-admin-key'), true);
  assert.equal(sameKey('local-admin-ke', 'local-admin-key'), false, 'different length: no throw, just false');
  assert.equal(sameKey(undefined, 'local-admin-key'), false);
  assert.equal(sameKey(['local-admin-key'], 'local-admin-key'), false);
});

test('cleanup', async () => {
  await client.cleanup();
});
