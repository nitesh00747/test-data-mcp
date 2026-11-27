/** Server-rendered pages. Elements carry data-test attributes so tests have stable locators. */
import { PRODUCTS, isExpired, type Store, type User } from './store.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const price = (n: number) => `$${n.toFixed(2)}`;

const layout = (title: string, body: string, user?: User, store?: Store) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Practice Shop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1d1d1b; }
  header { display: flex; gap: 16px; align-items: center; padding: 12px 24px; background: #1d1d1b; color: #fff; }
  header a { color: #fff; } header .spacer { flex: 1; }
  main { max-width: 760px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border: 1px solid #e2e0d8; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .error { background: #fde8e4; color: #8a1c0c; border: 1px solid #f2b8ab; padding: 10px 12px; border-radius: 8px; }
  .notice { background: #e4f4ea; color: #145a32; border: 1px solid #a9dcbc; padding: 10px 12px; border-radius: 8px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #1d1d1b; background: #fff; cursor: pointer; }
  button.primary { background: #1d1d1b; color: #fff; }
  input { font: inherit; padding: 8px; width: 100%; box-sizing: border-box; margin: 4px 0 12px; }
</style></head><body>
<header><strong>Practice Shop</strong><span class="spacer"></span>
${
  user && store
    ? `<a href="/shop" data-test="nav-shop">Shop</a>
<a href="/cart" data-test="nav-cart">Cart (<span data-test="cart-count">${user.cart.reduce((s, l) => s + l.qty, 0)}</span>)</a>
<a href="/orders" data-test="nav-orders">Orders</a>
<span data-test="signed-in-as">${esc(user.name)}</span>
<a href="/logout" data-test="logout">Log out</a>`
    : ''
}
</header><main>${body}</main></body></html>`;

export const loginPage = (error?: string) =>
  layout(
    'Log in',
    `<div class="card" style="max-width:360px;margin:40px auto">
  <h1>Log in</h1>
  ${error ? `<p class="error" role="alert" data-test="error">${esc(error)}</p>` : ''}
  <form method="post" action="/login" aria-label="Log in">
    <label>Username <input name="username" data-test="username" autocomplete="username"></label>
    <label>Password <input name="password" type="password" data-test="password" autocomplete="current-password"></label>
    <button class="primary" type="submit" data-test="login-button">Log in</button>
  </form>
</div>`,
  );

export const shopPage = (user: User, store: Store) =>
  layout(
    'Shop',
    `<h1 data-test="title">Products</h1>
${PRODUCTS.map(
  (p) => `<div class="card row" data-test="product" data-product-id="${p.id}">
  <span data-test="product-name">${esc(p.name)}</span>
  <span data-test="product-price">${price(p.price)}</span>
  <form method="post" action="/cart/add"><input type="hidden" name="productId" value="${p.id}">
    <button type="submit" data-test="add-${p.id}">Add to cart</button></form>
</div>`,
).join('\n')}`,
    user,
    store,
  );

export const cartPage = (user: User, store: Store, error?: string) => {
  const card = `Card ending ${user.card.last4}, expires ${user.card.expiry}${isExpired(user.card.expiry) ? ' (expired)' : ''}`;
  return layout(
    'Cart',
    `<h1 data-test="title">Your cart</h1>
${error ? `<p class="error" role="alert" data-test="error">${esc(error)}</p>` : ''}
${
  user.cart.length === 0
    ? `<p data-test="cart-empty">Your cart is empty.</p>`
    : user.cart
        .map((l) => {
          const p = store.product(l.productId);
          return `<div class="card row" data-test="cart-line" data-product-id="${p.id}">
  <span data-test="line-name">${esc(p.name)}</span><span data-test="line-qty">x ${l.qty}</span>
  <span data-test="line-price">${price(p.price * l.qty)}</span>
  <form method="post" action="/cart/remove"><input type="hidden" name="productId" value="${p.id}">
    <button type="submit" data-test="remove-${p.id}">Remove</button></form>
</div>`;
        })
        .join('\n') +
      `<div class="card row"><strong>Total</strong><strong data-test="cart-total">${price(store.cartTotal(user.cart))}</strong></div>
<p data-test="payment-card">${esc(card)}</p>
<form method="post" action="/checkout"><button class="primary" type="submit" data-test="checkout">Place order</button></form>`
}`,
    user,
    store,
  );
};

export const ordersPage = (user: User, store: Store, placed?: string) => {
  const orders = store.ordersFor(user.id);
  return layout(
    'Orders',
    `<h1 data-test="title">Your orders</h1>
${placed ? `<p class="notice" role="status" data-test="order-placed">Thank you! Order ${esc(placed)} is placed.</p>` : ''}
${
  orders.length === 0
    ? `<p data-test="no-orders">You have no orders yet.</p>`
    : orders
        .map(
          (o) => `<div class="card row" data-test="order" data-order-id="${o.id}">
  <span data-test="order-id">${o.id}</span><span data-test="order-date">${o.createdAt.slice(0, 10)}</span>
  <span data-test="order-status">${o.status}</span><span data-test="order-total">${price(o.total)}</span>
</div>`,
        )
        .join('\n')
}`,
    user,
    store,
  );
};
