import { extractOrdersFromHtml, pageIsOrderHistory } from './extract.js';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url) return;
  const cfg = await chrome.storage.sync.get(['origin', 'token']);
  if (!cfg.origin || !cfg.token) {
    chrome.runtime.openOptionsPage();
    return;
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ html: document.documentElement.outerHTML, href: location.href }),
  });
  if (!result || !pageIsOrderHistory(result.href, result.html)) {
    console.warn('Not an order-history page');
    return;
  }
  const orders = extractOrdersFromHtml(result.html, result.href);
  const ingestUrl = `${String(cfg.origin).replace(/\/$/, '')}/api/ingest/orders`;
  await fetch(ingestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ orders }),
  });
});
