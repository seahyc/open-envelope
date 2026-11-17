import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { PdfAdapter } from '../../src/server/adapters/pdf-adapter.js';

function buildPdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font('Courier').fontSize(10);
    for (const line of lines) {
      doc.text(line);
    }
    doc.end();
  });
}

describe('PdfAdapter extracted text', () => {
  it('parses transactions from extracted PDF text, not raw bytes', async () => {
    const adapter = new PdfAdapter('generic', {
      accountHintRegex: 'Account.*?(\\d{4})',
      transactionRegex: '(\\d{2}\\s+[A-Z]{3})\\s+(.+?)\\s+([\\d,.]+)',
      dateGroup: 1,
      merchantGroup: 2,
      amountGroup: 3,
    });

    const pdf = await buildPdf([
      'Account 4321',
      '15 JAN Coffee Shop 12.50',
      '16 JAN Book Store 8.00',
    ]);
    expect(pdf.subarray(0, 4).toString('utf-8')).toBe('%PDF');
    expect(pdf.toString('utf-8')).not.toMatch(/Coffee Shop/);

    const observations = await adapter.parse(pdf);
    expect(observations.length).toBeGreaterThanOrEqual(1);
    expect(observations.some((obs) => obs.merchantText.includes('Coffee'))).toBe(true);
    expect(observations[0]?.accountHint).toBe('4321');
  });
});
