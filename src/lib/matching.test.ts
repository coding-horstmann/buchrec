import { describe, expect, it } from "vitest";
import type { NormalizedRecord } from "../types";
import { coverageSummary, runMatching } from "./matching";

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
});
