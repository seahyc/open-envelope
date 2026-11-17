import PDFDocument from 'pdfkit';
import { writeFileSync } from 'fs';
import { join } from 'path';

function generateDbsAccountStatement(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

    doc.fontSize(16).text('DBS BANK', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text('ACCOUNT STATEMENT', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(10);
    doc.text('Account: 123-45678-9');
    doc.text('Statement Period: 01 JAN 2024 to 31 JAN 2024');
    doc.text('Opening Balance: 5,000.00');
    doc.text('Closing Balance: 4,211.00');
    doc.moveDown();

    doc.text('Date           Description                           Withdrawal    Deposit       Balance');
    doc.text('─'.repeat(85));
    
    const transactions = [
      { date: '05 JAN', desc: 'FAIRPRICE FINEST', withdrawal: '78.90', deposit: '0.00', balance: '4,921.10' },
      { date: '10 JAN', desc: 'SALARY DEPOSIT', withdrawal: '0.00', deposit: '3,000.00', balance: '7,921.10' },
      { date: '15 JAN', desc: 'NTUC INCOME\nPREMIUM PAYMENT', withdrawal: '150.00', deposit: '0.00', balance: '7,771.10' },
      { date: '20 JAN', desc: 'ATM WITHDRAWAL', withdrawal: '200.00', deposit: '0.00', balance: '7,571.10' },
      { date: '25 JAN', desc: 'GRAB 123456', withdrawal: '12.50', deposit: '0.00', balance: '7,558.60' }
    ];

  transactions.forEach(tx => {
    const line = `${tx.date.padEnd(15)}${tx.desc.split('\n')[0]!.padEnd(40)}${tx.withdrawal.padStart(12)}${tx.deposit.padStart(14)}${tx.balance.padStart(14)}`;
    doc.text(line);
    if (tx.desc.includes('\n')) {
      const secondLine = ' '.repeat(15) + tx.desc.split('\n')[1];
      doc.text(secondLine);
    }
  });

    doc.end();
  });
}

function generateDbsCardStatement(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

  doc.fontSize(16).text('DBS CREDIT CARD', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text('STATEMENT OF ACCOUNT', { align: 'center' });
  doc.moveDown();
  
  doc.fontSize(10);
  doc.text('Card ending: 6789');
  doc.text('Statement Period: 01 JAN 2024 to 31 JAN 2024');
  doc.text('Previous Balance: 1,234.56');
  doc.text('New Balance: 1,313.46');
  doc.moveDown();

  doc.text('Transaction Date    Description                        Amount');
  doc.text('─'.repeat(70));
  
  const transactions = [
    { date: '05 JAN', desc: 'FAIRPRICE FINEST', amount: '78.90' },
    { date: '12 JAN', desc: 'AMAZON WEB SERVICES\nMONTHLY SUBSCRIPTION', amount: '25.00' },
    { date: '18 JAN', desc: 'NETFLIX.COM', amount: '19.98' }
  ];

  transactions.forEach(tx => {
    const line = `${tx.date.padEnd(20)}${tx.desc.split('\n')[0]!.padEnd(35)}${tx.amount.padStart(15)}`;
    doc.text(line);
    if (tx.desc.includes('\n')) {
      const secondLine = ' '.repeat(20) + tx.desc.split('\n')[1];
      doc.text(secondLine);
    }
  });

    doc.end();
  });
}

function generateOcbc360Statement(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

  doc.fontSize(16).text('OCBC BANK', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text('360 ACCOUNT STATEMENT', { align: 'center' });
  doc.moveDown();
  
  doc.fontSize(10);
  doc.text('Account Number: 501-234567-001');
  doc.text('Statement Period: 01 DEC 2023 to 31 DEC 2023');
  doc.text('Opening Balance: 10,000.00');
  doc.text('Closing Balance: 9,850.00');
  doc.moveDown();

  doc.text('Date           Description                           Withdrawal    Deposit       Balance');
  doc.text('─'.repeat(85));
  
  const transactions = [
    { date: '05 DEC', desc: 'COLD STORAGE', withdrawal: '50.00', deposit: '0.00', balance: '9,950.00' },
    { date: '15 DEC', desc: 'NTUC FAIRPRICE\nGROCERIES', withdrawal: '100.00', deposit: '0.00', balance: '9,850.00' }
  ];

  transactions.forEach(tx => {
    const line = `${tx.date.padEnd(15)}${tx.desc.split('\n')[0]!.padEnd(40)}${tx.withdrawal.padStart(12)}${tx.deposit.padStart(14)}${tx.balance.padStart(14)}`;
    doc.text(line);
    if (tx.desc.includes('\n')) {
      const secondLine = ' '.repeat(15) + tx.desc.split('\n')[1];
      doc.text(secondLine);
    }
  });

    doc.end();
  });
}

function generateOcbcCardStatement(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));

  doc.fontSize(16).text('OCBC CREDIT CARD', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text('STATEMENT', { align: 'center' });
  doc.moveDown();
  
  doc.fontSize(10);
  doc.text('Card Number: 4111 2222 3333 2345');
  doc.text('Statement Period: 01 DEC 2023 to 31 DEC 2023');
  doc.text('Previous Balance: 500.00');
  doc.text('New Balance: 589.98');
  doc.moveDown();

  doc.text('Transaction Date    Description                        Amount');
  doc.text('─'.repeat(70));
  
  const transactions = [
    { date: '05 DEC', desc: 'COURTS SINGAPORE', amount: '89.98 CR' }
  ];

  transactions.forEach(tx => {
    const line = `${tx.date.padEnd(20)}${tx.desc.padEnd(35)}${tx.amount.padStart(15)}`;
    doc.text(line);
  });

    doc.end();
  });
}

const fixturesDir = join(process.cwd(), 'fixtures', 'singapore');

(async () => {
  writeFileSync(join(fixturesDir, 'dbs-account-statement.pdf'), await generateDbsAccountStatement());
  console.log('Generated: dbs-account-statement.pdf');

  writeFileSync(join(fixturesDir, 'dbs-card-statement.pdf'), await generateDbsCardStatement());
  console.log('Generated: dbs-card-statement.pdf');

  writeFileSync(join(fixturesDir, 'ocbc-360-statement.pdf'), await generateOcbc360Statement());
  console.log('Generated: ocbc-360-statement.pdf');

  writeFileSync(join(fixturesDir, 'ocbc-card-statement.pdf'), await generateOcbcCardStatement());
  console.log('Generated: ocbc-card-statement.pdf');
})().catch(console.error);
