// Synthetic target for tests and local demos: a fake shop whose /api/orders needs a session
// cookie and answers {"is_login": false} without one, or a challenge page when blocked.
//
// A real target has the same shape:
//   shop            stable key reported to OpenEnvelope ("shopee", "lazada", "amazon")
//   cookieAllowed   which seed cookies belong to this shop (everything else is dropped)
//   sync(page, { reason, limit })
//                   open the shop like a person (landing page, then the order list), read
//                   the first page of orders, return { state, detail?, orders } where orders
//                   follow the scripts/import-orders.mjs JSONL contract
import { classifyBlock } from '../sync.mjs';

export function syntheticTarget(origin) {
  const host = new URL(origin).hostname;
  return {
    shop: 'synthetic',
    cookieAllowed: (cookie) => {
      const domain = cookie.url ? new URL(cookie.url).hostname : String(cookie.domain || '').replace(/^\./, '');
      return domain === host;
    },
    async sync(page, { limit }) {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      if (new URL(page.url()).pathname.startsWith('/login')) return { state: 'reauth_needed', detail: 'redirected to login', orders: [] };
      const raw = await page.evaluate(async ({ path }) => {
        const response = await fetch(path, { credentials: 'include' });
        return { status: response.status, contentType: response.headers.get('content-type') || '', text: await response.text() };
      }, { path: `/api/orders?limit=${limit}` });
      const block = classifyBlock(raw);
      if (block) return { ...block, orders: [] };
      if (!raw.contentType.includes('json')) return { state: 'error', detail: `unexpected ${raw.status}`, orders: [] };
      const data = JSON.parse(raw.text);
      if (data.is_login === false) return { state: 'reauth_needed', detail: 'session expired', orders: [] };
      return {
        state: 'ok',
        orders: (data.orders ?? []).map((order) => ({
          shop: order.shop,
          order_id: order.id,
          placed_at: order.date,
          currency: order.currency,
          total_cents: order.total_cents,
          status: order.status,
          buyer_account: null,
          items: order.items.map((item) => ({ title: item.name, qty: item.qty, unit_price_cents: item.price_cents, sku: null, url: null })),
        })),
      };
    },
  };
}
