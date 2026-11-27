/**
 * The test data "factory": the one place that knows how to build data in the app under test.
 *
 * Playwright fixtures call it directly; the MCP server wraps it in tools so AI agents can call it.
 * Keeping it in one layer means tests and agents always get data built the same way.
 *
 * Three rules it enforces:
 *   1. Unique: every user gets a name nobody else has, so parallel tests never share data.
 *   2. Tagged: everything it creates carries tags (test-data, run:<id>, owner:<who>, and optionally
 *      group:<id> for a whole test run), so it can find and delete its own data later, even after a
 *      crash, and never touch anything else.
 *   3. Safe target: it refuses to run against hosts that aren't explicitly allowed (no prod), and
 *      never follows redirects, so the admin key can't be sent anywhere else.
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
  /** Groups everything this client creates, for cleanup. Generated if not given. */
  runId?: string;
  /** Optional larger group, e.g. one Playwright run across all its workers. Adds a group:<id> tag. */
  groupId?: string;
  /** Hosts this client may talk to. Default: localhost only, plus TEST_DATA_ALLOWED_HOSTS. */
  allowedHosts?: string[];
};

export class TestDataError extends Error {
  /** HTTP status from the app, when the error came from a response */
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Which test data a cleanup removes. There is deliberately no "everything" option. */
export type CleanupScope =
  | 'run' // created by this client
  | 'group' // created by any client in this client's group (e.g. this Playwright run)
  | 'owner' // created by this owner in any run (e.g. every MCP session)
  | { olderThanMinutes: number }; // any test data older than this: abandoned leftovers

/** A random id. Never derived from the clock: clock-based ids repeat and then collide. */
export const newRunId = (prefix = '') => `${prefix}${randomBytes(4).toString('hex')}`;

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
  readonly groupId?: string;
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
    this.runId = opts.runId ?? newRunId();
    this.groupId = opts.groupId;
    this.tags = [TEST_DATA_TAG, `run:${this.runId}`, `owner:${this.owner}`, ...(opts.groupId ? [`group:${opts.groupId}`] : [])];
  }

  // ---------- HTTP ----------

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        // Never follow a redirect: it could lead off the allow-listed host, taking the admin key with it.
        redirect: 'error',
        headers: { 'x-admin-key': this.adminKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const cause = (e as Error & { cause?: Error }).cause?.message ?? (e as Error).message;
      if (/redirect/i.test(cause)) throw new TestDataError(`${this.baseUrl} answered with a redirect; refusing to follow it (it could leave the allowed hosts).`);
      throw new TestDataError(`Can't reach the app at ${this.baseUrl} (${cause}). Is it running? Try: npm run app`);
    }
    const text = await res.text();
    let data: { error?: string } | undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new TestDataError(`${method} ${path}: expected JSON, got: ${text.slice(0, 120)}`, res.status);
    }
    if (!res.ok) throw new TestDataError(`${method} ${path} failed (${res.status}): ${data?.error ?? text}`, res.status);
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

  /** Read-only: test users of this run ("run"), this group, this owner, or every run ("all"). */
  async listUsers(scope: 'run' | 'group' | 'owner' | 'all' = 'run'): Promise<ListedUser[]> {
    const tag =
      scope === 'run' ? `run:${this.runId}`
      : scope === 'group' ? `group:${this.requireGroup()}`
      : scope === 'owner' ? `owner:${this.owner}`
      : TEST_DATA_TAG;
    return this.call('GET', `/api/test-data/users?tag=${encodeURIComponent(tag)}`);
  }

  private requireGroup(): string {
    if (!this.groupId) throw new TestDataError('This client has no groupId, so there is no group to clean up.');
    return this.groupId;
  }

  /** Delete one user, but only if it is test data. */
  async deleteUser(userId: string): Promise<void> {
    const u = (await this.getUser(userId)) as { tags?: string[] };
    if (!u.tags?.includes(TEST_DATA_TAG)) throw new TestDataError(`User ${userId} is not test data; refusing to delete it.`);
    await this.call('DELETE', `/api/test-data/users/${userId}`);
  }

  /**
   * Delete test data and return how many users went. Scopes: this client's run (default), its group,
   * its owner, or any test data older than N minutes (abandoned leftovers, never data in use).
   */
  async cleanup(scope: CleanupScope = 'run'): Promise<number> {
    let users: ListedUser[];
    if (typeof scope === 'object') {
      if (!(scope.olderThanMinutes >= 15)) throw new TestDataError('olderThanMinutes must be at least 15, so data in use is never removed');
      const cutoff = Date.now() - scope.olderThanMinutes * 60_000;
      users = (await this.listUsers('all')).filter((u) => Date.parse(u.createdAt) < cutoff);
    } else {
      users = await this.listUsers(scope);
    }
    let deleted = 0;
    for (const u of users) {
      try {
        await this.call('DELETE', `/api/test-data/users/${u.id}`);
        deleted++;
      } catch (e) {
        if ((e as TestDataError).status !== 404) throw e; // someone else already removed it
      }
    }
    return deleted;
  }
}

export type ListedUser = { id: string; username: string; tags: string[]; orders: number; createdAt: string };

/**
 * Remembers what a test created and deletes it afterwards. A user that is already gone is fine;
 * any other failure is returned, so the caller can report it instead of silently leaking data.
 */
export class UserTracker {
  private ids: string[] = [];
  constructor(private readonly client: TestDataClient) {}

  track<T extends { id: string }>(user: T): T {
    this.ids.push(user.id);
    return user;
  }

  async dispose(): Promise<string[]> {
    const problems: string[] = [];
    for (const id of this.ids.splice(0)) {
      try {
        await this.client.deleteUser(id);
      } catch (e) {
        if ((e as TestDataError).status !== 404) problems.push(`${id}: ${(e as Error).message}`);
      }
    }
    return problems;
  }
}
