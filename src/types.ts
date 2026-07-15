export type SourceKind =
  | "accountable-expenses"
  | "accountable-invoices"
  | "bank-fyrst"
  | "paypal-business"
  | "bank-n26"
  | "bank-dkb-ignored"
  | "etsy-sales"
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
  | "sale"
  | "fee"
  | "refund"
  | "payout"
  | "wallet-funding"
  | "wallet-charge"
  | "transfer"
  | "unknown";

export type Direction = "in" | "out" | "neutral";
export type Disposition = "active" | "test" | "private" | "ignored" | "resolved";

export interface SourceImport {
  id: string;
  fileName: string;
  fileSize: number;
  fingerprint: string;
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

export interface ShopifyRule {
  shop: string;
  mode: "zero-only" | "allow-list";
  genuineCustomers: string[];
}

export interface ProjectSettings {
  year: number;
  dateToleranceDays: number;
  amountTolerance: number;
  testIdentities: string[];
  shopifyRules: ShopifyRule[];
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
}

export interface ParsedFileResult {
  sources: SourceImport[];
  records: NormalizedRecord[];
}

export interface MatchResult {
  links: MatchLink[];
  candidates: MatchCandidate[];
}

export interface CoverageSummary {
  documents: { total: number; resolved: number; open: number };
  payments: { total: number; resolved: number; open: number };
  bridges: { total: number; resolved: number; open: number };
  orders: { total: number; resolved: number; excluded: number; open: number };
  exceptions: number;
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  "accountable-expenses": "Accountable · Ausgaben",
  "accountable-invoices": "Accountable · Rechnungen",
  "bank-fyrst": "FYRST",
  "paypal-business": "Business-PayPal",
  "bank-n26": "N26",
  "bank-dkb-ignored": "DKB · ausgeschlossen",
  "etsy-sales": "Etsy · Verkäufe",
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
