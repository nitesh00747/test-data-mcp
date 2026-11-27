/**
 * The test data "factory": the one place that knows how to build data in the app under test.
 *
 * Playwright fixtures call it directly; the MCP server wraps it in tools so AI agents can call it.
 * Keeping it in one layer means tests and agents always get data built the same way.
 *
 * Three rules it enforces:
 *   1. Unique: every user gets a name nobody else has, so parallel tests never share data.
 *   2. Tagged: everything it creates carries tags (test-data, run:<id>, owner:<who>), so it can
 *      find and delete its own data later, even after a crash, and never touch anything else.
 *   3. Safe target: it refuses to run against hosts that aren't explicitly allowed (no prod).
 */
import { randomBytes } from 'node:crypto';

export const TEST_DATA_TAG = 'test-data';
export const PRODUCT_IDS = ['backpack', 'bike-light', 't-shirt', 'rain-jacket', 'coffee-mug', 'water-bottle'] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];

export type CartItem = ProductId | { productId: ProductId; qty?: number };
export type OrderSpec = { items?: CartItem[]; status?: 'placed' | 'shipped' | 'cancelled'; daysAgo?: number };

/** What kind of user to build. Everything is optional: {} gives a plain active user. */
export type UserRecipe = {
  /** Readable prefix for the username, e.g. "checkout" -> checkout_k3f9_1 */
  label?: string;
  name?: string;
  status?: 'active' | 'locked';
  /** "expired" gives a card that fails at checkout */
  card?: 'valid' | 'expired';
  /** Items already in the cart, e.g. ["backpack", { productId: "coffee-mug", qty: 2 }] */
  cart?: CartItem[];
  /** Order history: a count (one mug each, a day apart) or a list of orders */
  orders?: number | OrderSpec[];
};

export type TestUser = {
  id: string;
  username: string;
  password: string;
  name: string;
  status: 'active' | 'locked';
  cardExpiry: string;
  cartItems: number;
  orderIds: string[];
  tags: string[];
};

export type TestDataOptions = {
  baseUrl?: string;
  adminKey?: string;
  /** Who is creating data, e.g. "playwright-worker-2" or "mcp". Shown in tags and names. */
  owner: string;
  /** Groups everything created in one run, for cleanup. Generated if not given. */
  runId?: string;
  /** Hosts this client may talk to. Default: localhost only, plus TEST_DATA_ALLOWED_HOSTS. */
  allowedHosts?: string[];
};

export class TestDataError extends Error {}

const VALID_EXPIRY = '12/39';
const EXPIRED_EXPIRY = '01/20';

export function defaultAllowedHosts(env = process.env): string[] {
  const extra = (env.TEST_DATA_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return ['localhost', '127.0.0.1', '::1', ...extra];
}

/** Refuse anything but an allowed host: test data tools must never point at production. */
export function assertSafeTarget(baseUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TestDataError(`Not a valid URL: ${baseUrl}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowedHosts.includes(host)) {
    throw new TestDataError(
      `Refusing to create test data on "${host}". Allowed hosts: ${allowedHosts.join(', ')}. ` +
        'Add a test environment to TEST_DATA_ALLOWED_HOSTS if you really mean it.',
    );
  }
  return url;
}

const toLine = (i: CartItem) => (typeof i === 'string' ? { productId: i, qty: 1 } : { productId: i.productId, qty: i.qty ?? 1 });

export class TestDataClient {
  readonly baseUrl: string;
  readonly runId: string;
  readonly owner: string;
  readonly tags: string[];
  private readonly adminKey: string;
  private counter = 0;

  constructor(opts: TestDataOptions) {
    this.baseUrl = assertSafeTarget(
      opts.baseUrl ?? process.env.TEST_DATA_BASE_URL ?? 'http://127.0.0.1:3100',
      opts.allowedHosts ?? defaultAllowedHosts(),
    ).origin;
    this.adminKey = opts.adminKey ?? process.env.ADMIN_KEY ?? 'local-admin-key';
    this.owner = opts.owner.replace(/[^\w-]/g, '-');
    this.runId = opts.runId ?? randomBytes(3).toString('hex');
    this.tags = [TEST_DATA_TAG, `run:${this.runId}`, `owner:${this.owner}`];
  }

  // ---------- HTTP ----------

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { 'x-admin-key': this.adminKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new TestDataError(`Can't reach the app at ${this.baseUrl} (${(e as Error).message}). Is it running? Try: npm run app`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new TestDataError(`${method} ${path} failed (${res.status}): ${data?.error ?? text}`);
    return data as T;
  }

  /** A readable, unique username: label_run_counter, e.g. checkout_k3f9a1_3 */
  private username(label = 'user'): string {
    const clean = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'user';
    return `${clean}_${this.runId}_${++this.counter}`;
  }

  // ---------- builders ----------

  /** Build a user, and optionally their cart and order history, in a few API calls. */
  async createUser(recipe: UserRecipe = {}): Promise<TestUser> {
    const created = await this.call<{ id: string; username: string; password: string; name: string; status: 'active' | 'locked'; card: { expiry: string } }>(
      'POST',
      '/api/test-data/users',
      {
        username: this.username(recipe.label),
        name: recipe.name,
        status: recipe.status ?? 'active',
        cardExpiry: recipe.card === 'expired' ? EXPIRED_EXPIRY : VALID_EXPIRY,
        tags: this.tags,
      },
    );
    const user: TestUser = {
      id: created.id,
      username: created.username,
      password: created.password,
      name: created.name,
      status: created.status,
      cardExpiry: created.card.expiry,
      cartItems: 0,
      orderIds: [],
      tags: this.tags,
    };
    if (recipe.cart?.length) user.cartItems = await this.addToCart(user.id, recipe.cart);
    if (recipe.orders) {
      const specs: OrderSpec[] =
        typeof recipe.orders === 'number'
          ? Array.from({ length: recipe.orders }, (_, i) => ({ items: ['coffee-mug'], status: 'shipped', daysAgo: i + 1 }))
          : recipe.orders;
      for (const spec of specs) user.orderIds.push((await this.createOrder(user.id, spec)).id);
    }
    return user;
  }

  /** Put items in a user's cart. Returns the number of items now in the cart. */
  async addToCart(userId: string, items: CartItem[]): Promise<number> {
    const res = await this.call<{ cart: { qty: number }[] }>('POST', `/api/test-data/users/${userId}/cart`, { items: items.map(toLine) });
    return res.cart.reduce((s, l) => s + l.qty, 0);
  }

  /** Add an order to a user's history (no checkout needed). */
  async createOrder(userId: string, spec: OrderSpec = {}): Promise<{ id: string; total: number; status: string }> {
    return this.call('POST', `/api/test-data/users/${userId}/orders`, {
      items: (spec.items ?? ['coffee-mug']).map(toLine),
      status: spec.status ?? 'placed',
      daysAgo: spec.daysAgo ?? 0,
    });
  }

  async getUser(userId: string): Promise<Record<string, unknown>> {
    return this.call('GET', `/api/test-data/users/${userId}`);
  }

  /** Users this run created ("run"), or every test-data user from any run ("all"). */
  async listUsers(scope: 'run' | 'all' = 'run'): Promise<{ id: string; username: string; tags: string[]; orders: number }[]> {
    const tag = scope === 'run' ? `run:${this.runId}` : TEST_DATA_TAG;
    return this.call('GET', `/api/test-data/users?tag=${encodeURIComponent(tag)}`);
  }

  /** Delete one user, but only if it is test data. */
  async deleteUser(userId: string): Promise<void> {
    const u = (await this.getUser(userId)) as { tags?: string[] };
    if (!u.tags?.includes(TEST_DATA_TAG)) throw new TestDataError(`User ${userId} is not test data; refusing to delete it.`);
    await this.call('DELETE', `/api/test-data/users/${userId}`);
  }

  /** Delete this run's data ("run"), or all test data from every run ("all"). Returns how many users went. */
  async cleanup(scope: 'run' | 'all' = 'run'): Promise<number> {
    const users = await this.listUsers(scope);
    for (const u of users) await this.call('DELETE', `/api/test-data/users/${u.id}`);
    return users.length;
  }
}
