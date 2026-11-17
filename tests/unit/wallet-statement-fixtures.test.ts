import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const dir = join(process.cwd(), 'fixtures/context');

function csv(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function dataRows(raw: string): string[] {
  const start = raw.indexOf('交易号,') >= 0 ? raw.indexOf('交易号,') : raw.indexOf('交易时间,');
  expect(start).toBeGreaterThanOrEqual(0);
  return raw
    .slice(start)
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('---') && !line.includes('列表结束'));
}

describe('wallet statement fixtures (public formats, synthetic)', () => {
  it('models Alipay export columns including 商品说明, CNY amount, status, and order numbers', () => {
    const raw = csv('alipay-taobao.csv');
    expect(raw).toMatch(/商品说明/);
    expect(raw).toMatch(/金额（元）/);
    expect(raw).toMatch(/交易状态/);
    expect(raw).toMatch(/商家订单号/);
    const [header, ...rows] = dataRows(raw);
    expect(header).toMatch(/^交易号,/);
    const taobao = rows.find((row) => row.includes('不锈钢保温杯'));
    const pdd = rows.find((row) => row.includes('拼多多') && row.includes('抽纸'));
    const closed = rows.find((row) => row.includes('交易关闭'));
    expect(taobao).toMatch(/TB20261012001/);
    expect(taobao).toMatch(/89\.00/);
    expect(taobao).toMatch(/交易成功/);
    expect(pdd).toMatch(/PDD20261013088/);
    expect(pdd).toMatch(/29\.90/);
    expect(closed).toBeTruthy();
    expect(raw).not.toMatch(/@gmail\.com|nric|passport/i);
  });

  it('models WeChat Pay bill columns 交易时间, 交易对方, 商品, 金额', () => {
    const raw = csv('wechat-pay-bill.csv');
    const [header, ...rows] = dataRows(raw);
    expect(header).toMatch(/^交易时间,交易类型,交易对方,商品,收\/支,金额\(元\)/);
    expect(rows.some((row) => row.includes('拼多多') && row.includes('¥29.90'))).toBe(true);
    expect(rows.some((row) => row.includes('淘宝') && row.includes('¥89.00'))).toBe(true);
    expect(raw).not.toMatch(/@gmail\.com|nric|passport/i);
  });
});
