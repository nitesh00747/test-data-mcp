/**
 * End-to-end test of the MCP server, talking to it exactly like Claude Code does:
 * start it as a child process and speak MCP over stdio with the official client.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startApp } from '../demo-app/server.ts';
import { TestDataClient } from '../src/core/test-data.ts';

let app: Awaited<ReturnType<typeof startApp>>;
let client: Client;

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;
const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

function serverTransport(env: Record<string, string>) {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server.ts'],
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: 'pipe',
  });
}

before(async () => {
  app = await startApp({ port: 0 });
  client = new Client({ name: 'mcp-test', version: '1.0.0' });
  await client.connect(serverTransport({ TEST_DATA_BASE_URL: app.url }));
});
after(async () => {
  await client.close();
  await app.close();
});

test('lists its tools, resources and prompts', async () => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['add_to_cart', 'cleanup_test_data', 'create_order', 'create_test_user', 'get_test_user', 'list_test_data']);
  const cleanup = (await client.listTools()).tools.find((t) => t.name === 'cleanup_test_data')!;
  assert.equal(cleanup.annotations?.destructiveHint, true, 'destructive tools say so, so clients can ask first');

  const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
  assert.deepEqual(resources, ['test-data://guide', 'test-data://products']);
  const products = await client.readResource({ uri: 'test-data://products' });
  assert.match(String((products.contents[0] as { text: string }).text), /backpack/);

  const prompt = await client.getPrompt({ name: 'test_with_fresh_data', arguments: { scenario: 'checkout with an expired card' } });
  assert.match(JSON.stringify(prompt.messages), /expired card/);
});

test('create_test_user builds a user an agent can log in as', async () => {
  const r = await call('create_test_user', { label: 'agent', cart: ['backpack', { productId: 'coffee-mug', qty: 2 }], orders: 2, card: 'expired' });
  assert.ok(!r.isError, text(r));
  const u = r.structuredContent as { id: string; username: string; password: string; cartItems: number; orderIds: string[] };
  assert.match(u.username, /^agent_mcp/);
  assert.equal(u.cartItems, 3);
  assert.equal(u.orderIds.length, 2);
  assert.match(text(r), new RegExp(`password: ${u.password}`));

  const login = await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: u.password }) });
  assert.equal(login.status, 200);

  assert.match(text(await call('add_to_cart', { user_id: u.id, items: ['t-shirt'] })), /4 item/);
  assert.match(text(await call('create_order', { user_id: u.id, status: 'cancelled', days_ago: 30 })), /cancelled/);
  assert.match(text(await call('get_test_user', { user_id: u.id })), /"orders": 3/);
});

test('bad input comes back as a readable tool error, not a crash', async () => {
  const unknownUser = await call('add_to_cart', { user_id: 'nope', items: ['backpack'] });
  assert.equal(unknownUser.isError, true);
  assert.match(text(unknownUser), /404|no user/);

  // Schema validation: an unknown product id is rejected before the tool runs
  const badProduct = (await client.callTool({ name: 'add_to_cart', arguments: { user_id: 'x', items: ['spaceship'] } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
  assert.equal(badProduct.isError, true);
});

test('list and cleanup only touch this session\'s data', async () => {
  const listed = text(await call('list_test_data'));
  assert.match(listed, /agent_mcp/);
  assert.match(text(await call('cleanup_test_data')), /Deleted [1-9]\d* test user/);
  assert.equal(text(await call('list_test_data')), 'No test data found.');
  const demo = await fetch(`${app.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'demo123' }) });
  assert.equal(demo.status, 200, 'seed user still there');
});

test('#1 two agent sessions never collide', async () => {
  const second = new Client({ name: 'mcp-test-2', version: '1.0.0' });
  await second.connect(serverTransport({ TEST_DATA_BASE_URL: app.url }));
  try {
    const a = await call('create_test_user', { label: 'twin' });
    const b = (await second.callTool({ name: 'create_test_user', arguments: { label: 'twin' } })) as ToolResult;
    assert.ok(!a.isError && !b.isError, text(b));
    assert.notEqual(a.structuredContent?.username, b.structuredContent?.username);
    // Each session's default cleanup removes only its own user
    assert.match(text(await call('cleanup_test_data')), /Deleted 1 /);
    assert.match(text((await second.callTool({ name: 'cleanup_test_data', arguments: {} })) as ToolResult), /Deleted 1 /);
  } finally {
    await second.close();
  }
});

test('#4 an agent can\'t wipe another run\'s data in use', async () => {
  const playwrightRun = new TestDataClient({ baseUrl: app.url, owner: 'playwright-w0', groupId: 'pw-inflight' });
  const inUse = await playwrightRun.createUser();

  // "all" is no longer an option
  const all = (await client.callTool({ name: 'cleanup_test_data', arguments: { scope: 'all' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
  assert.equal(all.isError, true);
  // "abandoned" needs at least 60 minutes
  const tooSoon = (await client.callTool({ name: 'cleanup_test_data', arguments: { scope: 'abandoned', older_than_minutes: 5 } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
  assert.equal(tooSoon.isError, true);

  for (const scope of ['session', 'my_sessions', 'abandoned']) {
    assert.ok(!(await call('cleanup_test_data', { scope })).isError);
  }
  assert.ok(await playwrightRun.getUser(inUse.id), 'the in-flight Playwright user survived every agent cleanup');
  await playwrightRun.cleanup();
});

test('#7 passwords can be kept out of the text the model reads', async () => {
  const quiet = new Client({ name: 'mcp-test-quiet', version: '1.0.0' });
  await quiet.connect(serverTransport({ TEST_DATA_BASE_URL: app.url, TEST_DATA_HIDE_PASSWORDS: 'true' }));
  try {
    const r = (await quiet.callTool({ name: 'create_test_user', arguments: {} })) as ToolResult;
    const pw = String(r.structuredContent?.password);
    assert.ok(pw.length > 0);
    assert.ok(!text(r).includes(pw), 'password not in the text');
    await quiet.callTool({ name: 'cleanup_test_data', arguments: {} });
  } finally {
    await quiet.close();
  }
});

test('the server refuses to start against a host that is not allowed', async () => {
  const c = new Client({ name: 'mcp-test', version: '1.0.0' });
  await assert.rejects(c.connect(serverTransport({ TEST_DATA_BASE_URL: 'https://prod.example.com' })));
});
