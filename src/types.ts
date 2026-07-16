export type SourceKind =
  | "accountable-expenses"
  | "accountable-invoices"
  | "bank-fyrst"
  | "paypal-business"
  | "bank-n26"
  | "bank-dkb-ignored"
  | "etsy-sales"
  | "etsy-sold-orders"
  | "etsy-transfers"
  | "etsy-statement"
  | "ebay-orders"
  | "ebay-ledger"
  | "shopify-orders"
  | "shopify-billing"
  | "printful-orders"
  | "printful-wallet"
  | "gelato"
  | "unknown";

export type RecordCategory =
  | "document-expense"
  | "document-income"
  | "tax-payment"
  | "cash-movement"
  | "order"
  | "order-detail"
  | "sale"
  | "buyer-fee"
  | "fee"
  | "refund"
  | "payout"
  | "wallet-funding"
  | "wallet-charge"
  | "transfer"
  | "unknown";

export type Direction = "in" | "out" | "neutral";
export type Disposition = "active" | "test" | "private" | "ignored" | "resolved";
export type ReviewStatus = "manual-cleared" | "open-note" | "warning" | "data-error";
export type DecisionKind =
  | "record-review"
  | "link-accepted"
  | "link-rejected"
  | "manual-link"
  | "disposition";

export interface SourceImport {
  id: string;
  fileName: string;
  fileSize: number;
  fingerprint: string;
  contentHash?: string;
  kind: SourceKind;
  label: string;
  shop?: string;
  sheetName?: string;
  headerRow: number;
  rowCount: number;
  dateMin?: string;
  dateMax?: string;
  warnings: string[];
  ignored: boolean;
}

export type MetadataValue = string | number | boolean | null;

export interface NormalizedRecord {
  id: string;
  sourceId: string;
  sourceKind: SourceKind;
  sourceFile: string;
  sourceRow: number;
  shop?: string;
  category: RecordCategory;
  direction: Direction;
  date?: string;
  dueDate?: string;
  paymentDate?: string;
  amount: number;
  settlementAmount?: number;
  feeAmount?: number;
  currency: string;
  counterparty: string;
  reference: string;
  relatedReferences: string[];
  description: string;
  disposition: Disposition;
  dispositionReason?: string;
  metadata: Record<string, MetadataValue>;
}

export type LinkType =
  | "document-payment"
  | "document-order"
  | "platform-evidence"
  | "platform-settlement"
  | "payout-bank"
  | "paypal-related"
  | "paypal-bank-bridge"
  | "account-batch"
  | "foreign-exchange"
  | "internal-transfer"
  | "wallet-bridge"
  | "group-payment"
  | "manual";

export interface MatchLink {
  id: string;
  fromId: string;
  toId: string;
  type: LinkType;
  confidence: number;
  amountDifference: number;
  dateDifference?: number;
  rule: string;
  reason: string;
  automatic: boolean;
  rejected?: boolean;
}

export interface MatchCandidate extends MatchLink {
  automatic: false;
}

export interface RecordReview {
  id: string;
  recordId: string;
  status: ReviewStatus;
  note: string;
  automatic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionAudit {
  id: string;
  kind: DecisionKind;
  recordIds: string[];
  linkId?: string;
  status?: ReviewStatus | Disposition;
  note: string;
  createdAt: string;
}

export interface ShopifyRule {
  shop: string;
  mode: "zero-only" | "allow-list";
  genuineCustomers: string[];
}

export interface EtsyShopAlias {
  shop: string;
  aliases: string[];
}

export interface ProjectSettings {
  year: number;
  dateToleranceDays: number;
  amountTolerance: number;
  testIdentities: string[];
  shopifyRules: ShopifyRule[];
  etsyShopAliases: EtsyShopAlias[];
}

export interface BuchrecProject {
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
  sources: SourceImport[];
  records: NormalizedRecord[];
  links: MatchLink[];
  candidates: MatchCandidate[];
  reviews: RecordReview[];
  decisions: DecisionAudit[];
}

export interface ParsedFileResult {
  sources: SourceImport[];
  records: NormalizedRecord[];
}

export interface MatchResult {
  links: MatchLink[];
  candidates: MatchCandidate[];
  reviews: RecordReview[];
}

export interface CoverageSummary {
  documents: { total: number; resolved: number; open: number };
  documentEvidence: { total: number; resolved: number; open: number };
  paymentEvidence: { total: number; resolved: number; open: number };
  accountEvidence: { total: number; resolved: number; open: number };
  payments: { total: number; resolved: number; open: number };
  bridges: { total: number; resolved: number; open: number };
  orders: { total: number; resolved: number; excluded: number; open: number };
  reviews: { manualCleared: number; annotatedOpen: number; warnings: number; dataErrors: number };
  exceptions: number;
}

export type EvidenceState = "confirmed" | "open" | "excluded" | "not-applicable";

export interface ReconciliationAxes {
  businessEvidence: EvidenceState;
  paymentEvidence: EvidenceState;
  accountEvidence: EvidenceState;
  businessReason: string;
  paymentReason: string;
  accountReason: string;
}

export interface SettlementBatch {
  id: string;
  account: string;
  label: string;
  date?: string;
  currency: string;
  amount: number;
  memberIds: string[];
  memberCount: number;
  rule: string;
  verified: boolean;
}

export type AccountControlStatus = "balanced" | "roll-forward" | "attention";

export interface PlatformPeriodSummary {
  id: string;
  account: string;
  period: string;
  currency: string;
  inflows: number;
  sellerRevenue: number;
  marketplaceTax: number;
  buyerFees: number;
  fees: number;
  refunds: number;
  charges: number;
  payouts: number;
  openingBalance?: number;
  calculatedClosing?: number;
  reportedClosing?: number;
  residual?: number;
  carry: number;
  status: AccountControlStatus;
  note: string;
}

export type ControlState = "confirmed" | "warning" | "open";

export interface PlatformControlAxis {
  label: string;
  expected: number;
  actual: number;
  difference: number;
  state: ControlState;
  detail: string;
  mode?: "comparison" | "balance";
}

export interface PlatformReconciliation {
  id: string;
  platform: string;
  shop?: string;
  period: string;
  currency: string;
  documentAxis: PlatformControlAxis;
  feeDocumentAxis?: PlatformControlAxis;
  platformAxis: PlatformControlAxis;
  paymentAxis: PlatformControlAxis;
  sellerRevenue: number;
  documentRevenue: number;
  buyerPayments: number;
  marketplaceTax: number;
  buyerFees: number;
  feeCharges: number;
  fees: number;
  feeCorrections: number;
  refunds: number;
  adjustments: number;
  payouts: number;
  carry: number;
}

export interface SingleReconciliationSummary {
  id: string;
  counterparty: string;
  documents: number;
  documentAmount: number;
  payments: number;
  paymentAmount: number;
  resolved: number;
  open: number;
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  "accountable-expenses": "Accountable · Ausgaben",
  "accountable-invoices": "Accountable · Rechnungen",
  "bank-fyrst": "FYRST",
  "paypal-business": "Business-PayPal",
  "bank-n26": "N26",
  "bank-dkb-ignored": "DKB · ausgeschlossen",
  "etsy-sales": "Etsy · Verkäufe",
  "etsy-sold-orders": "Etsy · Sold Orders",
  "etsy-transfers": "Etsy · Überweisungen",
  "etsy-statement": "Etsy · Abrechnung",
  "ebay-orders": "eBay · Bestellungen",
  "ebay-ledger": "eBay · Abrechnung",
  "shopify-orders": "Shopify · Bestellungen",
  "shopify-billing": "Shopify · Gebühren",
  "printful-orders": "Printful · Bestellungen",
  "printful-wallet": "Printful · Geldbörse",
  gelato: "Gelato",
  unknown: "Unbekannte Datei",
};
