/**
 * Test Data MCP server.
 *
 * MCP (Model Context Protocol) lets an AI agent call your code. A server offers three things:
 *   - tools:     actions the agent can take          -> create_test_user, add_to_cart, ...
 *   - resources: read-only data the agent can load    -> test-data://products, test-data://guide
 *   - prompts:   ready-made instructions for a task   -> test_with_fresh_data
 *
 * It talks to the agent over stdio (JSON-RPC on stdin/stdout). That's why nothing here may
 * print to stdout: logs go to stderr, or they would corrupt the protocol.
 *
 * Every tool is a thin wrapper around TestDataClient, the same code the Playwright fixtures use.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PRODUCT_IDS, TestDataClient, TestDataError, newRunId, type CartItem, type CleanupScope } from '../core/test-data.ts';

const log = (...args: unknown[]) => console.error('[test-data-mcp]', ...args);

const productId = z.enum(PRODUCT_IDS).describe('Product id');
const cartItem = z.union([productId, z.object({ productId, qty: z.number().int().min(1).max(99).optional() })]);

/** Turn thrown errors into a tool result the agent can read and react to, instead of a crash. */
async function run<T>(fn: () => Promise<T>, format: (r: T) => string, structured?: (r: T) => Record<string, unknown>) {
  try {
    const result = await fn();
    return {
      content: [{ type: 'text' as const, text: format(result) }],
      ...(structured ? { structuredContent: structured(result) } : {}),
    };
  } catch (e) {
    const message = e instanceof TestDataError ? e.message : `Unexpected error: ${(e as Error).message}`;
    log(message);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
  }
}

/**
 * Whose agent this is: TEST_DATA_OWNER, or "mcp-<your OS username>". Per person, so on a shared
 * test environment one person's "my_sessions" cleanup never removes a teammate's data.
 */
export function mcpOwner(env = process.env): string {
  if (env.TEST_DATA_OWNER) return env.TEST_DATA_OWNER;
  let who = 'unknown';
  try {
    who = userInfo().username || who;
  } catch {
    // no user info in some containers
  }
  return `mcp-${who}`;
}

export type ServerOptions = {
  /** Keep passwords out of the text the model reads; they stay in structuredContent only. */
  hidePasswords?: boolean;
};

export function createServer(client: TestDataClient, opts: ServerOptions = {}) {
  const server = new McpServer({ name: 'test-data', version: '0.1.0' });

  // ---------------- tools ----------------

  server.registerTool(
    'create_test_user',
    {
      title: 'Create a test user',
      description:
        'Create a fresh, unique shop user for a test, optionally with items in the cart, order history, ' +
        'a locked account or an expired card. Returns the username and password to log in with. ' +
        'Use a new user per test so tests never share data.',
      inputSchema: {
        label: z.string().max(24).optional().describe('Readable prefix for the username, e.g. "checkout"'),
        status: z.enum(['active', 'locked']).optional().describe('"locked" cannot log in'),
        card: z.enum(['valid', 'expired']).optional().describe('"expired" makes checkout fail'),
        cart: z.array(cartItem).optional().describe('Items already in the cart'),
        orders: z.number().int().min(0).max(20).optional().describe('Number of past orders to create'),
      },
      outputSchema: {
        id: z.string(),
        username: z.string(),
        password: z.string(),
        status: z.string(),
        cardExpiry: z.string(),
        cartItems: z.number(),
        orderIds: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      run(
        () => client.createUser(args as Parameters<TestDataClient['createUser']>[0]),
        (u) =>
          [
            opts.hidePasswords
              ? `Created user ${u.username} (id: ${u.id}). The password is in the structured result only.`
              : `Created user ${u.username} (password: ${u.password}, id: ${u.id}). Throwaway test credentials.`,
            `Status: ${u.status}. Card expires ${u.cardExpiry}.`,
            `Cart: ${u.cartItems} item(s). Past orders: ${u.orderIds.length}.`,
            `Log in at ${client.baseUrl}/ with these credentials. Remove it with cleanup_test_data when done.`,
          ].join('\n'),
        (u) => ({ id: u.id, username: u.username, password: u.password, status: u.status, cardExpiry: u.cardExpiry, cartItems: u.cartItems, orderIds: u.orderIds }),
      ),
  );

  server.registerTool(
    'add_to_cart',
    {
      title: 'Add items to a cart',
      description: "Put items in a test user's cart without clicking through the UI.",
      inputSchema: { user_id: z.string().describe('id from create_test_user'), items: z.array(cartItem).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ user_id, items }) => run(() => client.addToCart(user_id, items as CartItem[]), (n) => `Cart now holds ${n} item(s).`),
  );

  server.registerTool(
    'create_order',
    {
      title: 'Add a past order',
      description: "Add an order to a test user's history, e.g. to test the orders page. No checkout needed.",
      inputSchema: {
        user_id: z.string(),
        items: z.array(cartItem).optional().describe('Default: one coffee mug'),
        status: z.enum(['placed', 'shipped', 'cancelled']).optional(),
        days_ago: z.number().int().min(0).max(3650).optional().describe('How long ago it was placed'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ user_id, items, status, days_ago }) =>
      run(
        () => client.createOrder(user_id, { items: items as CartItem[] | undefined, status, daysAgo: days_ago }),
        (o) => `Created order ${o.id}: ${o.status}, total $${o.total.toFixed(2)}.`,
      ),
  );

  server.registerTool(
    'get_test_user',
    {
      title: 'Look up a test user',
      description: 'Show a test user: status, card, cart and orders. Read-only.',
      inputSchema: { user_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ user_id }) => run(() => client.getUser(user_id), (u) => JSON.stringify(u, null, 2)),
  );

  server.registerTool(
    'list_test_data',
    {
      title: 'List test data',
      description: 'List test users created in this session ("run") or by any run ("all"). Read-only.',
      inputSchema: { scope: z.enum(['run', 'all']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ scope }) =>
      run(
        () => client.listUsers(scope ?? 'run'),
        (users) =>
          users.length
            ? users.map((u) => `${u.username}  id=${u.id}  orders=${u.orders}  ${u.tags.filter((t) => t !== 'test-data').join(' ')}`).join('\n')
            : 'No test data found.',
      ),
  );

  server.registerTool(
    'cleanup_test_data',
    {
      title: 'Delete test data',
      description:
        'Delete test users and their orders. "session" (default): what this session created. ' +
        '"my_sessions": what any of your agent sessions created. "abandoned": any test data nobody has ' +
        'used (logged in, changed cart or orders) for older_than_minutes (default 120, at least 60). ' +
        'It can never delete another test run\'s fresh data, real users or seed users.',
      inputSchema: {
        scope: z.enum(['session', 'my_sessions', 'abandoned']).optional(),
        older_than_minutes: z.number().int().min(60).max(100_000).optional().describe('Only for "abandoned"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ scope, older_than_minutes }) => {
      const mapped: CleanupScope =
        scope === 'my_sessions' ? 'owner' : scope === 'abandoned' ? { olderThanMinutes: older_than_minutes ?? 120 } : 'run';
      return run(() => client.cleanup(mapped), (n) => `Deleted ${n} test user(s).`);
    },
  );

  // ---------------- resources ----------------

  server.registerResource(
    'products',
    'test-data://products',
    { title: 'Product catalogue', description: 'Product ids you can put in carts and orders', mimeType: 'application/json' },
    async (uri) => {
      const res = await fetch(`${client.baseUrl}/api/products`, { redirect: 'error' }).catch(() => undefined);
      if (!res?.ok) throw new Error(`Can't load products from ${client.baseUrl}. Is the app running? Try: npm run app`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: await res.text() }] };
    },
  );

  server.registerResource(
    'guide',
    'test-data://guide',
    { title: 'How to use test data', description: 'Rules for using this server in tests', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: [
            '# Test data rules',
            '- Create a new user for every test; never reuse one across tests.',
            '- Build the state you need (cart, orders, locked, expired card) with tools, not by clicking through the UI.',
            '- In Playwright tests, use the `user` / `makeUser` fixtures from e2e/fixtures.ts: they create and clean up automatically.',
            '- Call cleanup_test_data when you finish exploring by hand.',
            `- App under test: ${client.baseUrl}`,
          ].join('\n'),
        },
      ],
    }),
  );

  // ---------------- prompts ----------------

  server.registerPrompt(
    'test_with_fresh_data',
    {
      title: 'Write a test with fresh data',
      description: 'Plan a Playwright test for a scenario, using this server for its setup',
      argsSchema: { scenario: z.string().describe('What to test, e.g. "checkout fails with an expired card"') },
    },
    ({ scenario }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `Write a Playwright test for: ${scenario}\n\n` +
              '1. Read test-data://guide and test-data://products.\n' +
              '2. Decide what data the test needs before it starts (user status, card, cart, orders).\n' +
              '3. Use create_test_user to build exactly that, and check it in the app if useful.\n' +
              '4. Write the test with the makeUser fixture from e2e/fixtures.ts so it builds the same data itself; ' +
              'the UI steps should cover only the behaviour under test.\n' +
              '5. Call cleanup_test_data when finished.',
          },
        },
      ],
    }),
  );

  return server;
}

// Run directly (this is what Claude Code starts, see .mcp.json)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    // A random id per session: a clock-based one repeated every ~28 minutes and made sessions collide.
    const client = new TestDataClient({ owner: mcpOwner(), runId: newRunId('mcp') });
    const transport = new StdioServerTransport();
    await createServer(client, { hidePasswords: process.env.TEST_DATA_HIDE_PASSWORDS === 'true' }).connect(transport);
    log(`ready: app ${client.baseUrl}, run ${client.runId}`);
  } catch (e) {
    log((e as Error).message);
    process.exit(1);
  }
}
