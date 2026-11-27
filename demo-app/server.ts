/**
 * Practice Shop: a tiny web shop to test against (Node's built-in http, no framework).
 *
 *   UI         /  (login)   /shop   /cart   /orders
 *   API        /api/login  /api/products  /api/cart  /api/checkout  /api/orders
 *   Test data  /api/test-data/...   (needs the x-admin-key header)
 *
 * Real teams usually get a "test data API" like /api/test-data from their developers, or build one
 * on top of the database. It is what makes fast, isolated test setup possible.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { HttpError, PRODUCTS, Store, isExpired, publicUser, type OrderStatus, type User } from './store.ts';
import { cartPage, loginPage, ordersPage, shopPage } from './views.ts';

export const DEFAULT_ADMIN_KEY = 'local-admin-key';

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; store: Store; adminKey: string; testDataApi: boolean };

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const html = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const redirect = (res: ServerResponse, to: string, cookie?: string) => {
  res.writeHead(303, { location: to, ...(cookie ? { 'set-cookie': cookie } : {}) });
  res.end();
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 100_000) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

const cookieToken = (req: IncomingMessage) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
const bearerToken = (req: IncomingMessage) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];

function apiUser(ctx: Ctx): User {
  const u = ctx.store.userForToken(bearerToken(ctx.req) ?? cookieToken(ctx.req));
  if (!u) throw new HttpError(401, 'log in first');
  return u;
}

/** Compare keys in constant time (hashing first makes the lengths equal), so timing reveals nothing. */
export function sameKey(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const h = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(h(given), h(expected));
}

function requireAdmin(ctx: Ctx) {
  if (!sameKey(ctx.req.headers['x-admin-key'], ctx.adminKey)) throw new HttpError(403, 'test data API needs a valid x-admin-key header');
}

const str = (v: unknown, name: string, required = false): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  return v;
};

// ---------------- routes ----------------

async function handle(ctx: Ctx): Promise<void> {
  const { req, res, url, store } = ctx;
  const method = req.method ?? 'GET';
  const path = url.pathname;
  let m: RegExpExecArray | null;

  // ---- health ----
  if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true });

  // ---- customer API ----
  if (method === 'POST' && path === '/api/login') {
    const b = await readBody(req);
    const token = store.login(str(b.username, 'username', true)!, str(b.password, 'password', true)!);
    return json(res, 200, { token });
  }
  if (method === 'GET' && path === '/api/products') return json(res, 200, PRODUCTS);
  if (method === 'GET' && path === '/api/cart') {
    const u = apiUser(ctx);
    return json(res, 200, { lines: u.cart, total: store.cartTotal(u.cart) });
  }
  if (method === 'POST' && path === '/api/cart') {
    const u = apiUser(ctx);
    const b = await readBody(req);
    store.addToCart(u.id, str(b.productId, 'productId', true)!, b.qty === undefined ? 1 : Number(b.qty));
    return json(res, 200, { lines: u.cart, total: store.cartTotal(u.cart) });
  }
  if (method === 'POST' && path === '/api/checkout') return json(res, 201, store.checkout(apiUser(ctx).id));
  if (method === 'GET' && path === '/api/orders') return json(res, 200, store.ordersFor(apiUser(ctx).id));

  // ---- test data API (admin) ----
  if (path.startsWith('/api/test-data/')) {
    if (!ctx.testDataApi) throw new HttpError(404, 'the test data API is turned off on this server');
    requireAdmin(ctx);
    if (method === 'POST' && path === '/api/test-data/users') {
      const b = await readBody(req);
      const status = str(b.status, 'status') ?? 'active';
      if (status !== 'active' && status !== 'locked') throw new HttpError(400, 'status must be active or locked');
      const expiry = str(b.cardExpiry, 'cardExpiry');
      if (expiry && !/^\d{2}\/\d{2}$/.test(expiry)) throw new HttpError(400, 'cardExpiry must be MM/YY');
      // Everything this API creates is test data, whatever the caller sends: so it can always be found
      // and cleaned up through this API, and it can never pose as a permanent seed user.
      const requested = Array.isArray(b.tags) ? b.tags.map(String) : [];
      if (requested.includes('seed')) throw new HttpError(400, 'the "seed" tag is reserved for permanent users');
      const tags = ['test-data', ...requested.filter((t) => t !== 'test-data')];
      const u = store.createUser({
        username: str(b.username, 'username'),
        password: str(b.password, 'password'),
        name: str(b.name, 'name'),
        status,
        card: expiry ? { last4: str(b.cardLast4, 'cardLast4') ?? '4242', expiry } : undefined,
        tags,
      });
      // The password is returned only here, once, so the caller can log in as this user.
      return json(res, 201, { ...publicUser(u, store), password: u.password });
    }
    if (method === 'GET' && path === '/api/test-data/users') {
      return json(res, 200, store.findUsers(url.searchParams.get('tag') ?? undefined).map((u) => publicUser(u, store)));
    }
    if ((m = /^\/api\/test-data\/users\/([\w-]+)$/.exec(path))) {
      const id = m[1];
      if (method === 'GET') {
        const u = store.user(id);
        return json(res, 200, { ...publicUser(u, store), cart: u.cart, orderList: store.ordersFor(id) });
      }
      if (method === 'DELETE') {
        // Enforced here, not only in the client: this API may only ever delete test data.
        if (!store.user(id).tags.includes('test-data')) throw new HttpError(403, 'only users tagged test-data can be deleted through the test data API');
        store.deleteUser(id);
        return json(res, 200, { deleted: id });
      }
    }
    if (method === 'POST' && (m = /^\/api\/test-data\/users\/([\w-]+)\/cart$/.exec(path))) {
      const b = await readBody(req);
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) throw new HttpError(400, 'items must be a non-empty array of { productId, qty }');
      for (const it of items) store.addToCart(m[1], str(it?.productId, 'productId', true)!, it?.qty === undefined ? 1 : Number(it.qty));
      return json(res, 200, { cart: store.user(m[1]).cart });
    }
    if (method === 'POST' && (m = /^\/api\/test-data\/users\/([\w-]+)\/orders$/.exec(path))) {
      const b = await readBody(req);
      const status = (str(b.status, 'status') ?? 'placed') as OrderStatus;
      if (!['placed', 'shipped', 'cancelled'].includes(status)) throw new HttpError(400, 'status must be placed, shipped or cancelled');
      if (b.items !== undefined && !Array.isArray(b.items)) throw new HttpError(400, 'items must be an array of { productId, qty }');
      const items = Array.isArray(b.items) && b.items.length ? b.items : [{ productId: 'coffee-mug', qty: 1 }];
      for (const i of items) {
        const qty = Number(i?.qty ?? 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, 'qty must be 1-99');
      }
      const daysAgo = Number(b.daysAgo ?? 0);
      if (!Number.isInteger(daysAgo) || daysAgo < 0 || daysAgo > 3650) throw new HttpError(400, 'daysAgo must be a whole number from 0 to 3650');
      const when = new Date(Date.now() - daysAgo * 86_400_000);
      const order = store.placeOrder(m[1], items.map((i: { productId?: unknown; qty?: unknown }) => ({ productId: String(i.productId), qty: Number(i.qty ?? 1) })), status, when);
      return json(res, 201, order);
    }
    throw new HttpError(404, `no test data route ${method} ${path}`);
  }

  // ---- UI ----
  const sessionUser = store.userForToken(cookieToken(req));
  if (method === 'GET' && path === '/') return html(res, 200, loginPage(url.searchParams.get('error') ?? undefined));
  if (method === 'POST' && path === '/login') {
    const b = await readBody(req);
    try {
      const token = store.login(String(b.username ?? ''), String(b.password ?? ''));
      return redirect(res, '/shop', `sid=${token}; Path=/; HttpOnly; SameSite=Lax`);
    } catch (e) {
      if (e instanceof HttpError) return redirect(res, `/?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
  }
  if (path === '/logout') {
    const t = cookieToken(req);
    if (t) store.logout(t);
    return redirect(res, '/', 'sid=; Path=/; Max-Age=0');
  }
  if (!sessionUser && ['/shop', '/cart', '/orders', '/cart/add', '/cart/remove', '/checkout'].includes(path)) {
    return redirect(res, `/?error=${encodeURIComponent('Please log in first.')}`);
  }
  const u = sessionUser!;
  if (method === 'GET' && path === '/shop') return html(res, 200, shopPage(u, store));
  if (method === 'POST' && path === '/cart/add') {
    const b = await readBody(req);
    store.addToCart(u.id, String(b.productId ?? ''));
    return redirect(res, '/shop');
  }
  if (method === 'POST' && path === '/cart/remove') {
    const b = await readBody(req);
    store.removeFromCart(u.id, String(b.productId ?? ''));
    return redirect(res, '/cart');
  }
  if (method === 'GET' && path === '/cart') return html(res, 200, cartPage(u, store, url.searchParams.get('error') ?? undefined));
  if (method === 'POST' && path === '/checkout') {
    try {
      const order = store.checkout(u.id);
      return redirect(res, `/orders?placed=${order.id}`);
    } catch (e) {
      if (e instanceof HttpError) return redirect(res, `/cart?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
  }
  if (method === 'GET' && path === '/orders') return html(res, 200, ordersPage(u, store, url.searchParams.get('placed') ?? undefined));

  throw new HttpError(404, `Not found: ${method} ${path}`);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Should this server offer the test data API? Off when ENABLE_TEST_DATA_API=false. Also off when the
 * server listens beyond this machine but still uses the public default key: anyone who read the
 * README could then create and delete users.
 */
export function testDataApiEnabled(host: string, adminKey: string, env = process.env): { enabled: boolean; reason?: string } {
  if (env.ENABLE_TEST_DATA_API === 'false') return { enabled: false, reason: 'ENABLE_TEST_DATA_API=false' };
  if (!LOOPBACK.has(host) && adminKey === DEFAULT_ADMIN_KEY) {
    return { enabled: false, reason: `listening on ${host} with the default admin key; set ADMIN_KEY to enable it` };
  }
  return { enabled: true };
}

export function startApp(opts: { port?: number; host?: string; adminKey?: string; store?: Store; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const store = opts.store ?? new Store();
  const adminKey = opts.adminKey ?? env.ADMIN_KEY ?? DEFAULT_ADMIN_KEY;
  const host = opts.host ?? env.HOST ?? '127.0.0.1';
  const api = testDataApiEnabled(host, adminKey, env);
  if (!api.enabled) console.warn(`Test data API is OFF: ${api.reason}`);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    handle({ req, res, url, store, adminKey, testDataApi: api.enabled }).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (url.pathname.startsWith('/api/')) json(res, status, { error: e.message });
      else html(res, status, `<h1>${status}</h1><p data-test="error">${String(e.message).replace(/</g, '&lt;')}</p>`);
    });
  });
  return new Promise<{ url: string; close: () => Promise<void>; store: Store; testDataApi: boolean }>((resolve) => {
    server.listen(opts.port ?? Number(env.PORT ?? 3100), host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const shownHost = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host;
      resolve({ url: `http://${shownHost}:${port}`, store, testDataApi: api.enabled, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// Run directly: `npm run app`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startApp().then(({ url }) => {
    console.log(`Practice Shop running at ${url}  (log in as demo / demo123)`);
    if (!process.env.ADMIN_KEY) console.log(`Test data API key: ${DEFAULT_ADMIN_KEY} (set ADMIN_KEY to change it)`);
  });
}

export { isExpired };
