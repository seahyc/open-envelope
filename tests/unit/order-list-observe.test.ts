import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  merchantForPage,
  normaliseObservedOrderList,
  pageIsObservableOrderList,
} from '../../extension/observe-normalise.js';

const dir = join(process.cwd(), 'fixtures/context');

function load(name: string) {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
}

describe('order-list network-observe normaliser', () => {
  it('normalises Taobao bought-items JSON to CNY orders and items', () => {
    const href = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm';
    expect(pageIsObservableOrderList(href)).toBe(true);
    expect(merchantForPage(href)).toBe('taobao');
    const orders = normaliseObservedOrderList(load('taobao-bought-items.json'), href);
    expect(orders).toMatchObject([{
      merchant: 'taobao',
      order_id: 'TB20261012001',
      currency: 'CNY',
      total_cents: 10150,
    }]);
    expect(orders[0]?.items).toEqual([
      { name: '不锈钢保温杯', qty: 1, unit_cents: 8900, line_cents: 8900 },
      { name: '杯刷替换头', qty: 1, unit_cents: 1250, line_cents: 1250 },
    ]);
  });

  it('normalises Lazada and Shopee order-list JSON on toolbar click pages', () => {
    const lazadaHref = 'https://www.lazada.sg/order/history';
    const shopeeHref = 'https://shopee.sg/user/purchase';
    const lazada = normaliseObservedOrderList(load('lazada-order-list.json'), lazadaHref);
    const shopee = normaliseObservedOrderList(load('shopee-order-list.json'), shopeeHref);
    expect(lazada[0]).toMatchObject({
      merchant: 'lazada',
      order_id: 'LZ-20261014-001',
      currency: 'SGD',
      total_cents: 2100,
    });
    expect(shopee[0]).toMatchObject({
      merchant: 'shopee',
      order_id: '220101',
      currency: 'SGD',
      total_cents: 19900,
    });
  });

  it('does not cover Pinduoduo (mobile-only; wallet export is the path)', () => {
    expect(pageIsObservableOrderList('https://mobile.yangkeduo.com/orders.html')).toBe(false);
    expect(merchantForPage('https://www.pinduoduo.com/orders')).toBeNull();
    expect(normaliseObservedOrderList({ data: { mainOrders: [{ id: 'x' }] } }, 'https://www.pinduoduo.com/orders')).toEqual([]);
  });
});
