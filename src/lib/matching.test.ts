import { describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../types";
import { coverageSummary, reconciliationAxes, runMatching } from "./matching";

function record(overrides: Partial<NormalizedRecord> & Pick<NormalizedRecord, "id" | "category" | "direction" | "amount">): NormalizedRecord {
  return {
    sourceId: overrides.sourceId ?? `s-${overrides.id}`,
    sourceKind: overrides.sourceKind ?? "bank-fyrst",
    sourceFile: overrides.sourceFile ?? "test.csv",
    sourceRow: overrides.sourceRow ?? 2,
    currency: overrides.currency ?? "EUR",
    counterparty: overrides.counterparty ?? "",
    reference: overrides.reference ?? "",
    relatedReferences: overrides.relatedReferences ?? [],
    description: overrides.description ?? "",
    disposition: overrides.disposition ?? "active",
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

describe("matching", () => {
  it("matches a tax document to the corresponding bank payment", () => {
    const records = [
      record({ id: "doc", sourceKind: "accountable-expenses", category: "tax-payment", direction: "out", date: "2025-01-10", amount: 248.53, counterparty: "Finanzamt" }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-01-10", amount: 248.53, counterparty: "Finanzamt" }),
    ];
    const result = runMatching(records);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ type: "document-payment", confidence: 100 });
  });

  it("matches a tax payment even when the bank only names the municipality", () => {
    const records = [
      record({ id: "tax-city", sourceKind: "accountable-expenses", category: "tax-payment", direction: "out", date: "2025-07-08", amount: 234.18, counterparty: "Finanzamt" }),
      record({ id: "bank-city", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-07-08", amount: 234.18, counterparty: "Gelsenkirchen" }),
    ];
    expect(runMatching(records).links[0]).toMatchObject({ type: "document-payment" });
  });

  it("uses the configured amount tolerance to influence confidence", () => {
    const records = [
      record({ id: "doc-tolerance", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-03-01", amount: 10, counterparty: "Beispiel GmbH" }),
      record({ id: "bank-tolerance", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-03-01", amount: 10.08, counterparty: "Beispiel GmbH" }),
    ];
    const strict = runMatching(records, 20, 0.02).links[0];
    const tolerant = runMatching(records, 20, 0.1).links[0];
    expect(strict.confidence).toBeLessThan(tolerant.confidence);
    expect(strict.reason).toContain("Betragsabweichung");
    expect(tolerant.reason).toContain("innerhalb der Toleranz");
  });

  it("removes user-classified private payments from the open coverage", () => {
    const privatePayment = record({ id: "private", sourceKind: "bank-n26", category: "cash-movement", direction: "out", amount: 25, disposition: "private" });
    expect(coverageSummary([privatePayment], []).payments).toEqual({ total: 0, resolved: 0, open: 0 });
  });

  it("links platform payouts to exact bank credits", () => {
    const records = [
      record({ id: "payout", sourceKind: "etsy-transfers", category: "payout", direction: "in", date: "2025-05-02", amount: 120.5 }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", date: "2025-05-03", amount: 120.5 }),
    ];
    expect(runMatching(records).links[0]).toMatchObject({ type: "payout-bank", confidence: 98 });
  });

  it("recognizes PayPal bank funding without double counting", () => {
    const records = [
      record({ id: "paypal", sourceKind: "paypal-business", category: "transfer", direction: "in", date: "2025-06-01", amount: 50, description: "Bankgutschrift auf PayPal-Konto" }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-06-01", amount: 50, description: "PayPal Europe" }),
    ];
    expect(runMatching(records).links[0]).toMatchObject({ type: "paypal-bank-bridge" });
    expect(coverageSummary(records, runMatching(records).links).payments).toEqual({ total: 1, resolved: 1, open: 0 });
    expect(coverageSummary(records, runMatching(records).links).bridges).toEqual({ total: 1, resolved: 1, open: 0 });
  });

  it("does not force a weak amount-only match", () => {
    const records = [
      record({ id: "doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-01-01", amount: 20, counterparty: "A" }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-03-01", amount: 20, counterparty: "B" }),
    ];
    const result = runMatching(records);
    expect(result.links).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(coverageSummary(records, result.links).exceptions).toBe(2);
  });

  it("only resolves an Accountable document when its chain reaches a bank", () => {
    const records = [
      record({ id: "doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-01-01", amount: 40, counterparty: "Kunde" }),
      record({ id: "order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-01-01", amount: 40, counterparty: "Kunde" }),
    ];
    const result = runMatching(records);
    expect(result.links.some((link) => link.type === "document-order")).toBe(true);
    expect(coverageSummary(records, result.links).documents.open).toBe(1);
    expect(coverageSummary(records, result.links).orders.open).toBe(1);
  });

  it("uses PayPal related transactions as merchant and currency evidence", () => {
    const records = [
      record({ id: "doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-04-01", amount: 283.72, counterparty: "Printler Group AB" }),
      record({ id: "merchant", sourceKind: "paypal-business", category: "cash-movement", direction: "out", date: "2025-04-02", amount: 3355.26, currency: "SEK", counterparty: "Printler Group AB", reference: "merchant-tx", metadata: { relatedTransaction: "conversion-tx" } }),
      record({ id: "conversion", sourceKind: "paypal-business", category: "transfer", direction: "out", date: "2025-04-02", amount: 283.72, currency: "EUR", counterparty: "PayPal", reference: "conversion-tx", metadata: { relatedTransaction: "merchant-tx" } }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-04-02", amount: 283.72, counterparty: "PayPal" }),
    ];
    const result = runMatching(records);
    expect(result.links.some((link) => link.type === "paypal-related")).toBe(true);
    expect(result.links.some((link) => link.type === "document-payment" && [link.fromId, link.toId].includes("conversion"))).toBe(true);
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });

  it("matches one Accountable document to a unique group of bank payments", () => {
    const records = [
      record({ id: "doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-08-01", amount: 175.7, counterparty: "Google Ads" }),
      record({ id: "n1", sourceKind: "bank-n26", category: "cash-movement", direction: "out", date: "2025-08-02", amount: 10, counterparty: "Google Ads" }),
      record({ id: "n2", sourceKind: "bank-n26", category: "cash-movement", direction: "out", date: "2025-08-03", amount: 50, counterparty: "Google Ads" }),
      record({ id: "n3", sourceKind: "bank-n26", category: "cash-movement", direction: "out", date: "2025-08-04", amount: 115.7, counterparty: "Google Ads" }),
    ];
    const result = runMatching(records);
    expect(result.links.filter((link) => link.type === "group-payment")).toHaveLength(3);
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });

  it("recognizes a longer platform trading name that contains the same distinctive words", () => {
    const records = [
      record({ id: "doc-art", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-04-15", amount: 459.2, counterparty: "Art Heroes (We Make It Work B.V.)" }),
      record({ id: "paypal-art", sourceKind: "paypal-business", category: "cash-movement", direction: "in", date: "2025-04-15", amount: 459.2, counterparty: "Werk aan de Muur / Art Heroes" }),
    ];
    const result = runMatching(records);
    expect(result.links[0]).toMatchObject({ type: "document-payment" });
    expect(result.links[0].reason).toContain("Gegenpartei");
  });

  it("keeps Etsy marketplace sales tax out of invoice revenue while tracing the net payout", () => {
    const records = [
      record({ id: "etsy-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-02-26", amount: 28.47, counterparty: "Käuferin" }),
      record({ id: "etsy-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-02-26", amount: 28.47, counterparty: "Käuferin", reference: "3613434191", relatedReferences: ["3613434191"], shop: "Form", metadata: { sellerRevenue: 28.47, marketplaceSalesTaxIncludedInSellerRevenue: false } }),
      record({ id: "etsy-sale", sourceKind: "etsy-statement", category: "sale", direction: "in", date: "2025-02-26", amount: 28.47, reference: "3613434191", relatedReferences: ["3613434191"], shop: "Form", metadata: { payoutContribution: 28.47 } }),
      record({ id: "etsy-fee", sourceKind: "etsy-statement", category: "fee", direction: "out", date: "2025-02-26", amount: 3.19, shop: "Form", metadata: { payoutContribution: -3.19 } }),
      record({ id: "etsy-tax", sourceKind: "etsy-statement", category: "fee", direction: "out", date: "2025-02-26", amount: 1.61, shop: "Form", description: "Sales tax paid by buyer", metadata: { payoutContribution: -1.61 } }),
      record({ id: "etsy-payout", sourceKind: "etsy-statement", category: "payout", direction: "in", date: "2025-02-26", amount: 23.67, shop: "Form" }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", date: "2025-02-27", amount: 23.67, counterparty: "Etsy" }),
    ];
    const result = runMatching(records);
    expect(result.links.some((link) => link.rule === "etsy-exact-payout-batch")).toBe(true);
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
    expect(coverageSummary(records, result.links).orders.open).toBe(0);
    expect(records.find((entry) => entry.id === "etsy-order")?.amount).toBe(28.47);
  });

  it("uses Accountable payment dates when the invoice date is outside the tolerance", () => {
    const records = [
      record({ id: "albin-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-03-11", paymentDate: "2025-04-17", amount: 400, counterparty: "Éditions Albin Michel" }),
      record({ id: "albin-bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", date: "2025-04-17", amount: 400, counterparty: "ALBIN MICHEL" }),
    ];
    const result = runMatching(records);
    expect(result.links[0]).toMatchObject({ type: "document-payment", dateDifference: 0 });
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });

  it("traces PayPal credits through a running-balance batch to one bank payout", () => {
    const records = [
      record({ id: "red-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-04-02", amount: 225.71, counterparty: "Redbubble Inc." }),
      record({ id: "art-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-04-15", amount: 459.2, counterparty: "Art Heroes (We Make It Work B.V.)" }),
      record({ id: "red-paypal", sourceKind: "paypal-business", category: "cash-movement", direction: "in", date: "2025-04-15", amount: 225.71, counterparty: "Redbubble Inc.", metadata: { gross: 225.71, net: 225.71, balance: 225.71, time: "00:53:55" } }),
      record({ id: "art-paypal", sourceKind: "paypal-business", category: "cash-movement", direction: "in", date: "2025-04-15", amount: 459.2, counterparty: "Werk aan de Muur / Art Heroes", metadata: { gross: 459.2, net: 459.2, balance: 684.91, time: "17:01:24" } }),
      record({ id: "paypal-withdrawal", sourceKind: "paypal-business", category: "transfer", direction: "out", date: "2025-04-16", amount: 684.91, counterparty: "PayPal", description: "Allgemeine Abbuchung – Bankkonto", metadata: { gross: -684.91, net: -684.91, balance: 0, time: "01:24:48" } }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", date: "2025-04-16", amount: 684.91, counterparty: "PayPal Europe", description: "ABBUCHUNG VOM PAYPAL-KONTO" }),
    ];
    const result = runMatching(records);
    expect(result.links.filter((link) => link.rule === "paypal-running-balance-batch")).toHaveLength(2);
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
    expect(reconciliationAxes(records, result.links).get("art-doc")?.accountReason).toContain("FYRST");
  });

  it("accepts a Gelato expense paid from a balanced PayPal balance without a duplicate bank debit", () => {
    const records = [
      record({ id: "gelato-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-04-24", amount: 68.85, counterparty: "Gelato" }),
      record({ id: "gelato-order", sourceKind: "gelato", category: "wallet-charge", direction: "out", date: "2025-04-24", amount: 68.85, counterparty: "Gelato", reference: "G-250424150841" }),
      record({ id: "gelato-paypal", sourceKind: "paypal-business", category: "cash-movement", direction: "out", date: "2025-04-24", amount: 68.85, counterparty: "Gelato ASA", metadata: { gross: -68.85, net: -68.85, balance: 3531.35, time: "15:14:07" } }),
    ];
    const result = runMatching(records);
    const axes = reconciliationAxes(records, result.links).get("gelato-doc");
    expect(axes).toMatchObject({ businessEvidence: "confirmed", paymentEvidence: "confirmed", accountEvidence: "confirmed" });
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });

  it("matches Printler EUR invoices to unique SEK PayPal receipts without inventing an exact EUR leg", () => {
    const records = [
      record({ id: "printler-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-02-03", amount: 283.72, currency: "EUR", counterparty: "Printler Group AB" }),
      record({ id: "printler-paypal", sourceKind: "paypal-business", category: "cash-movement", direction: "in", date: "2025-02-05", amount: 3355.26, currency: "SEK", counterparty: "Printler Group AB", metadata: { gross: 3355.26, net: 3355.26, balance: 3355.26 } }),
    ];
    const result = runMatching(records);
    expect(result.links[0]).toMatchObject({ type: "foreign-exchange", rule: "printler-paypal-fx-window", confidence: 93 });
    expect(result.links[0].reason).toContain("EUR-Gegenseite fehlt");
  });

  it("shows a confirmed order link separately from an open payment account", () => {
    const records = [
      record({ id: "buyer-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-12-30", amount: 74.04, counterparty: "Andrew Dye" }),
      record({ id: "buyer-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-12-30", amount: 74.04, counterparty: "Andrew Dye" }),
    ];
    const result = runMatching(records);
    expect(reconciliationAxes(records, result.links).get("buyer-doc")).toMatchObject({
      businessEvidence: "confirmed",
      paymentEvidence: "open",
      accountEvidence: "open",
    });
  });

  it("uses an exact unique full-year merchant match when Accountable has a clearly wrong date", () => {
    const records = [
      record({ id: "late-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-12-09", amount: 1800.1, counterparty: "Printler Group AB" }),
      record({ id: "early-bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-07-24", amount: 1800.1, counterparty: "PayPal Europe", description: "Ihr Einkauf bei Printler Group AB" }),
    ];
    const result = runMatching(records);
    expect(result.links[0]).toMatchObject({ rule: "unique-yearly-exact-merchant-payment", confidence: 91 });
    expect(result.links[0].reason).toContain("Datumsabweichung");
  });

  it("accepts Printful orders paid from a cent-exact balanced provider wallet", () => {
    const records = [
      record({ id: "printful-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-05-01", amount: 20, counterparty: "Printful" }),
      record({ id: "printful-order", sourceKind: "printful-orders", category: "wallet-charge", direction: "out", date: "2025-05-01", amount: 20, counterparty: "Printful", reference: "PF-1" }),
      record({ id: "printful-funding", sourceKind: "printful-wallet", category: "wallet-funding", direction: "out", date: "2025-04-30", amount: 20, counterparty: "Printful" }),
    ];
    const result = runMatching(records);
    expect(reconciliationAxes(records, result.links).get("printful-doc")).toMatchObject({
      businessEvidence: "confirmed",
      paymentEvidence: "confirmed",
      accountEvidence: "confirmed",
    });
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });
});
