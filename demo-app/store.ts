/**
 * In-memory data for the Practice Shop demo app.
 *
 * The app is the "system under test". It exists so the test data server has a real API to call,
 * and so everything runs locally and in CI with no outside dependency. Restarting the app empties it.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export type Product = { id: string; name: string; price: number };
export type CartLine = { productId: string; qty: number };
export type OrderStatus = 'placed' | 'shipped' | 'cancelled';
export type Order = { id: string; userId: string; lines: CartLine[]; total: number; status: OrderStatus; createdAt: string };
export type Card = { last4: string; expiry: string }; // expiry as MM/YY
export type User = {
  id: string;
  username: string;
  password: string;
  name: string;
  status: 'active' | 'locked';
  card: Card;
  cart: CartLine[];
  /** Labels set by whoever created the user. Test data uses them to find and clean up its own users. */
  tags: string[];
  createdAt: string;
  /** Last time anyone logged in as this user or changed its data. "Abandoned" cleanup goes by this. */
  lastUsedAt: string;
};

/** How long a login lasts. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const PRODUCTS: Product[] = [
  { id: 'backpack', name: 'Travel Backpack', price: 49.99 },
  { id: 'bike-light', name: 'Bike Light', price: 12.5 },
  { id: 't-shirt', name: 'Cotton T-Shirt', price: 18 },
  { id: 'rain-jacket', name: 'Rain Jacket', price: 89 },
  { id: 'coffee-mug', name: 'Coffee Mug', price: 9.25 },
  { id: 'water-bottle', name: 'Water Bottle', price: 15 },
];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const money = (n: number) => Math.round(n * 100) / 100;

/** True when an MM/YY expiry date is before the current month. */
export function isExpired(expiry: string, now = new Date()): boolean {
  const m = /^(\d{2})\/(\d{2})$/.exec(expiry);
  if (!m) return true;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
}

export class Store {
  private users = new Map<string, User>();
  private orders = new Map<string, Order>();
  private sessions = new Map<string, { userId: string; expiresAt: number }>();

  constructor() {
    this.seed();
  }

  /** A couple of permanent users, so the app is usable by hand. Test data never touches these. */
  private seed() {
    this.createUser({ username: 'demo', password: 'demo123', name: 'Demo Shopper', tags: ['seed'] });
    this.createUser({ username: 'locked_demo', password: 'demo123', name: 'Locked Shopper', status: 'locked', tags: ['seed'] });
  }

  product(id: string): Product {
    const p = PRODUCTS.find((x) => x.id === id);
    if (!p) throw new HttpError(400, `Unknown product "${id}". Known: ${PRODUCTS.map((x) => x.id).join(', ')}`);
    return p;
  }

  // ---------- users ----------

  createUser(input: Partial<Pick<User, 'username' | 'password' | 'name' | 'status' | 'card' | 'tags'>>): User {
    const username = input.username ?? `user_${randomBytes(4).toString('hex')}`;
    if (!/^[\w.-]{3,64}$/.test(username)) throw new HttpError(400, 'username must be 3-64 letters, digits, _ . or -');
    if ([...this.users.values()].some((u) => u.username === username)) {
      throw new HttpError(409, `username "${username}" already exists`);
    }
    const user: User = {
      id: randomUUID(),
      username,
      password: input.password ?? randomBytes(6).toString('base64url'),
      name: input.name ?? 'Test Shopper',
      status: input.status ?? 'active',
      card: input.card ?? { last4: '4242', expiry: '12/39' },
      cart: [],
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  user(id: string): User {
    const u = this.users.get(id);
    if (!u) throw new HttpError(404, `no user with id ${id}`);
    return u;
  }

  /** Record that a user is in use (login, cart or order changes). */
  touch(u: User, now = Date.now()) {
    u.lastUsedAt = new Date(now).toISOString();
  }

  findUsers(tag?: string): User[] {
    return [...this.users.values()].filter((u) => !tag || u.tags.includes(tag));
  }

  deleteUser(id: string) {
    this.user(id);
    this.users.delete(id);
    for (const [oid, o] of this.orders) if (o.userId === id) this.orders.delete(oid);
    for (const [t, sess] of this.sessions) if (sess.userId === id) this.sessions.delete(t);
  }

  // ---------- auth ----------

  login(username: string, password: string): string {
    const u = [...this.users.values()].find((x) => x.username === username);
    if (!u || u.password !== password) throw new HttpError(401, 'Username or password is incorrect.');
    if (u.status === 'locked') throw new HttpError(403, 'This account is locked.');
    const token = randomBytes(16).toString('hex');
    this.sessions.set(token, { userId: u.id, expiresAt: Date.now() + SESSION_TTL_MS });
    this.touch(u);
    this.pruneSessions();
    return token;
  }

  /** The logged-in user for a token, or undefined if the token is unknown or has expired. */
  userForToken(token: string | undefined, now = Date.now()): User | undefined {
    const sess = token ? this.sessions.get(token) : undefined;
    if (!sess) return undefined;
    if (sess.expiresAt <= now) {
      this.sessions.delete(token!);
      return undefined;
    }
    return this.users.get(sess.userId);
  }

  /** Drop expired logins so the session table can't grow forever. */
  private pruneSessions(now = Date.now()) {
    for (const [t, sess] of this.sessions) if (sess.expiresAt <= now) this.sessions.delete(t);
  }

  /** For tests: make a session look older. */
  expireSession(token: string) {
    const sess = this.sessions.get(token);
    if (sess) sess.expiresAt = 0;
  }

  logout(token: string) {
    this.sessions.delete(token);
  }

  // ---------- cart and orders ----------

  addToCart(userId: string, productId: string, qty = 1) {
    const u = this.user(userId);
    this.product(productId);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, 'qty must be 1-99');
    this.touch(u);
    const line = u.cart.find((l) => l.productId === productId);
    if (line) line.qty = Math.min(99, line.qty + qty);
    else u.cart.push({ productId, qty });
  }

  removeFromCart(userId: string, productId: string) {
    const u = this.user(userId);
    this.touch(u);
    u.cart = u.cart.filter((l) => l.productId !== productId);
  }

  cartTotal(lines: CartLine[]): number {
    return money(lines.reduce((s, l) => s + this.product(l.productId).price * l.qty, 0));
  }

  /** Customer checkout: needs a non-empty cart and a card that hasn't expired. */
  checkout(userId: string): Order {
    const u = this.user(userId);
    if (u.cart.length === 0) throw new HttpError(400, 'Your cart is empty.');
    if (isExpired(u.card.expiry)) throw new HttpError(402, `Payment declined: card ending ${u.card.last4} has expired.`);
    const order = this.placeOrder(userId, u.cart, 'placed');
    u.cart = [];
    return order;
  }

  /** Create an order directly (used by checkout, and by the test data API to build order history). */
  placeOrder(userId: string, lines: CartLine[], status: OrderStatus, createdAt = new Date()): Order {
    this.touch(this.user(userId));
    if (lines.length === 0) throw new HttpError(400, 'an order needs at least one line');
    lines.forEach((l) => this.product(l.productId));
    const order: Order = {
      id: `ORD-${randomBytes(3).toString('hex').toUpperCase()}`,
      userId,
      lines: lines.map((l) => ({ ...l })),
      total: this.cartTotal(lines),
      status,
      createdAt: createdAt.toISOString(),
    };
    this.orders.set(order.id, order);
    return order;
  }

  ordersFor(userId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** What the API returns for a user: never the password, except right after creating test data. */
export function publicUser(u: User, store: Store) {
  const { password: _password, ...rest } = u;
  return { ...rest, cardExpired: isExpired(u.card.expiry), orders: store.ordersFor(u.id).length };
}
