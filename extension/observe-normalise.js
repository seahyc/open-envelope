/**
 * Queued follow-on (docs/ux/context-signals.md §17): normalise order-list JSON
 * the shop page already fetched. The extension must never call shop APIs itself.
 * Pinduoduo is not covered.
 */

const TAOBAO_HOST = /taobao\.com|tmall\.com|tmall\.hk/i;
const PINDUODUO_HOST = /pinduoduo\.com|yangkeduo\.com|pddpic\.com/i;

export function pageIsObservableOrderList(href) {
  const host = safeHost(href);
  if (!host) return false;
  if (PINDUODUO_HOST.test(host)) return false;
  if (TAOBAO_HOST.test(host) && /bought|itemlist|trade/i.test(href)) return true;
  if (host.includes('lazada') && /order/i.test(href)) return true;
  if (host.includes('shopee') && /purchase|order/i.test(href)) return true;
  return false;
}

export function merchantForPage(href) {
  const host = safeHost(href);
  if (PINDUODUO_HOST.test(host)) return null;
  if (TAOBAO_HOST.test(host)) return 'taobao';
  if (host.includes('lazada')) return 'lazada';
  if (host.includes('shopee')) return 'shopee';
  return null;
}

export function normaliseObservedOrderList(payload, href = '') {
  const merchant = merchantForPage(href);
  if (!merchant) return [];
  if (merchant === 'taobao') return fromTaobao(payload, merchant);
  if (merchant === 'lazada') return fromLazada(payload, merchant);
  if (merchant === 'shopee') return fromShopee(payload, merchant);
  return [];
}

function fromTaobao(payload, merchant) {
  const mains = payload?.data?.mainOrders ?? payload?.mainOrders ?? [];
  return mains.flatMap((order) => {
    const orderId = String(order.id || order.orderId || '').trim();
    if (!orderId) return [];
    const items = (order.subOrders ?? []).map((item) => {
      const qty = Number(item.quantity ?? 1) || 1;
      const yuan = parseYuan(item.price);
      const line = yuan == null ? null : Math.round(yuan * 100);
      return {
        name: String(item.title || item.itemTitle || 'item'),
        qty,
        unit_cents: line == null ? null : Math.round(line / qty),
        line_cents: line,
      };
    });
    const totalYuan = parseYuan(order.payInfo?.actualFee) ?? items.reduce((sum, item) => sum + (item.line_cents ?? 0) / 100, 0);
    return [{
      merchant,
      order_id: orderId,
      placed_at: order.payTime || order.createTime || null,
      currency: order.payInfo?.currency || 'CNY',
      total_cents: totalYuan == null ? null : Math.round(Number(totalYuan) * 100),
      items,
    }];
  });
}

function fromLazada(payload, merchant) {
  const orders = payload?.data?.orders ?? payload?.orders ?? [];
  return orders.flatMap((order) => {
    const orderId = String(order.orderNumber || order.order_id || '').trim();
    if (!orderId) return [];
    const currency = order.grandTotal?.currency || 'SGD';
    const items = (order.items ?? []).map((item) => {
      const qty = Number(item.quantity ?? 1) || 1;
      const yuan = Number(item.price);
      const line = Number.isFinite(yuan) ? Math.round(yuan * 100) : null;
      return {
        name: String(item.name || 'item'),
        qty,
        unit_cents: line == null ? null : Math.round(line / qty),
        line_cents: line,
      };
    });
    const total = order.grandTotal?.amount;
    return [{
      merchant,
      order_id: orderId,
      placed_at: order.createdAt || null,
      currency,
      total_cents: Number.isFinite(Number(total)) ? Math.round(Number(total) * 100) : null,
      items,
    }];
  });
}

function fromShopee(payload, merchant) {
  const orders = payload?.data?.order_list ?? payload?.order_list ?? [];
  return orders.flatMap((order) => {
    const orderId = String(order.order_id || '').trim();
    if (!orderId) return [];
    const items = (order.item_list ?? []).map((item) => ({
      name: String(item.item_name || 'item'),
      qty: Number(item.amount ?? 1) || 1,
      unit_cents: Number.isFinite(Number(item.item_price)) ? Number(item.item_price) : null,
      line_cents: Number.isFinite(Number(item.item_price)) ? Number(item.item_price) * (Number(item.amount ?? 1) || 1) : null,
    }));
    return [{
      merchant,
      order_id: orderId,
      placed_at: order.create_time ? order.create_time * 1000 : null,
      currency: order.currency || 'SGD',
      total_cents: Number.isFinite(Number(order.total_price)) ? Number(order.total_price) : null,
      items,
    }];
  });
}

function parseYuan(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[¥￥,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function safeHost(href) {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return '';
  }
}
