import { describe, it, expect } from 'vitest';
import { OfxAdapter } from './ofx-adapter';

describe('OfxAdapter', () => {
  it('should parse OFX transactions', async () => {
    const adapter = new OfxAdapter();

    const ofx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20240115120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>4111111111111111
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240101
<DTEND>20240131
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115
<TRNAMT>-45.67
<FITID>2024011501
<NAME>Generic Coffee Shop
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240116
<TRNAMT>3000.00
<FITID>2024011601
<NAME>Acme Corp Payroll
</STMTTRN>
<STMTTRN>
<TRNTYPE>FEE
<DTPOSTED>20240117
<TRNAMT>-5.00
<FITID>2024011701
<NAME>Monthly Service Fee
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

    const buffer = Buffer.from(ofx);
    const observations = await adapter.parse(buffer);

    expect(observations).toHaveLength(3);
    
    expect(observations[0]).toMatchObject({
      accountHint: '4111111111111111',
      amountCents: -4567,
      currency: 'USD',
      merchantText: 'Generic Coffee Shop',
      reference: '2024011501',
      kind: 'purchase',
    });

    expect(observations[1]).toMatchObject({
      amountCents: 300000,
      merchantText: 'Acme Corp Payroll',
      kind: 'deposit',
    });

    expect(observations[2]).toMatchObject({
      amountCents: -500,
      merchantText: 'Monthly Service Fee',
      kind: 'fee',
    });
  });
});
