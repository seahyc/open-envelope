export interface BankAlertHint {
  id: string;
  domains: string[];
  boost: number;
}

export const BANK_ALERT_HINTS: BankAlertHint[] = [
  { id: 'ocbc', domains: ['ocbc.com', 'ocbc.com.sg', 'notify.ocbc.com'], boost: 0.08 },
  { id: 'dbs', domains: ['dbs.com', 'dbs.com.sg', 'posb.com.sg'], boost: 0.08 },
  { id: 'uob', domains: ['uob.com.sg', 'uobgroup.com'], boost: 0.08 },
  { id: 'citi', domains: ['citibank.com.sg', 'citibank.com', 'citi.com'], boost: 0.05 },
  { id: 'hsbc', domains: ['hsbc.com.sg', 'hsbc.com'], boost: 0.05 },
  { id: 'sc', domains: ['sc.com', 'standardchartered.com'], boost: 0.05 },
  { id: 'maybank', domains: ['maybank.com', 'maybank.com.sg', 'maybank2u.com.sg'], boost: 0.05 },
  { id: 'trust', domains: ['trustbank.sg'], boost: 0.05 },
  { id: 'gxs', domains: ['gxs.com.sg'], boost: 0.05 },
];
