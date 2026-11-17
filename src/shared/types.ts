export type DocumentHash = string;

export interface RawDocument {
  hash: DocumentHash;
  filename: string;
  mimeType: string;
  uploadedAt: number;
  sizeBytes: number;
}

export type ObservationKind = 
  | 'purchase' 
  | 'refund' 
  | 'fee' 
  | 'interest' 
  | 'transfer' 
  | 'giro' 
  | 'withdrawal' 
  | 'deposit';

export interface Observation {
  id: string;
  documentHash: DocumentHash;
  accountHint: string;
  amountCents: number;
  currency: string;
  fxAmountCents?: number;
  fxCurrency?: string;
  timestamp: number;
  merchantText: string;
  reference?: string;
  kind: ObservationKind;
  adapterName: string;
  isStatement?: boolean;
  parseConfidence?: number;
  parseMethod?: string;
  createdAt: number;
}

export type AccountGroup = 'budget' | 'credit' | 'tracking';

export interface Account {
  id: string;
  name: string;
  aliases: string[];
  group: AccountGroup;
  openedAt?: number;
  closedAt?: number;
  createdAt: number;
}

export type TransactionState = 'pending' | 'posted' | 'reconciled';

export interface Transaction {
  id: string;
  accountId: string;
  amountCents: number;
  currency: string;
  fxAmountCents?: number;
  fxCurrency?: string;
  timestamp: number;
  merchantText: string;
  state: TransactionState;
  category?: string;
  envelopeId?: string;
  linkedTransactionId?: string;
  observationIds: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StatementPeriod {
  id: string;
  accountId: string;
  startDate: number;
  endDate: number;
  openingBalanceCents: number;
  closingBalanceCents: number;
  documentHash?: DocumentHash;
  reconciledAt?: number;
  discrepancyCents?: number;
  status?: 'balanced' | 'unbalanced';
  createdAt: number;
}

export interface MerchantRule {
  id: string;
  pattern: string;
  category: string;
  envelopeId?: string;
  createdAt: number;
}

export interface Envelope {
  id: string;
  name: string;
  owner: 'shared' | 'alex' | 'sam';
  monthlyTargetCents?: number;
  color?: string;
  createdAt: number;
}

export interface BudgetAllocation {
  id: string;
  envelopeId: string;
  month: string;
  allocatedCents: number;
  createdAt: number;
}

export interface AdapterConfig {
  name: string;
  type: 'csv' | 'ofx' | 'email' | 'pdf';
  config: Record<string, unknown>;
}

export interface ImportResult {
  documentHash: DocumentHash;
  observationsCreated: number;
  observationsDuplicate: number;
  transactionsCreated: number;
  transactionsMerged: number;
  errors: string[];
  adapterName?: string;
  hasStatementPeriod?: boolean;
}
