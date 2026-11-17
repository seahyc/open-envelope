/** This-build HTML snapshot for Shopee/Lazada. Follow-on: extension/observe-normalise.js + §17 (no DOM scrape). */

export function extractOrdersFromHtml(html, href = '') {
  const host = safeHost(href);
  const merchant = host.includes('lazada') ? 'lazada' : host.includes('shopee') ? 'shopee' : guessMerchant(html);
  if (!merchant) return [];
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const orders = [];
  const idMatches = [...plain.matchAll(/order(?:\s*(?:id|no\.?|number|#))[:\s]*([A-Z0-9-]{8,})/gi)];
  const seen = new Set();
  for (const match of idMatches) {
    const orderId = match[1];
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    orders.push({
      merchant,
      order_id: orderId,
      currency: 'SGD',
      total_cents: moneyCentsNear(plain, match.index ?? 0),
      items: itemsNear(plain, match.index ?? 0),
    });
  }
  return orders;
}

function safeHost(href) {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function guessMerchant(html) {
  if (/lazada/i.test(html)) return 'lazada';
  if (/shopee/i.test(html)) return 'shopee';
  return null;
}

function moneyCentsNear(plain, index) {
  const window = plain.slice(Math.max(0, index - 80), index + 240);
  const match = window.match(/(?:S\$|SGD)\s*([\d,]+(?:\.\d{2})?)/i) || window.match(/\$([\d,]+(?:\.\d{2})?)/);
  if (!match?.[1]) return null;
  return Math.round(Number(match[1].replace(/,/g, '')) * 100);
}

function itemsNear(plain, index) {
  const window = plain.slice(index, index + 400);
  const items = [];
  const matches = [...window.matchAll(/item[:\s]+(.+?)(?=\s+item[:\s]|$)/gi)];
  for (const match of matches.slice(0, 8)) {
    const name = match[1].trim();
    if (name) items.push({ name, qty: 1 });
  }
  return items;
}

export function pageIsOrderHistory(href, html) {
  const host = safeHost(href);
  if (host.includes('shopee') && /purchase|order/i.test(href + html.slice(0, 2000))) return true;
  if (host.includes('lazada') && /order|purchase/i.test(href + html.slice(0, 2000))) return true;
  return false;
}
