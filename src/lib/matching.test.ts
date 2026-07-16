import { describe, expect, it } from "vitest";
import type { MatchLink, NormalizedRecord } from "../types";
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

  it("assigns repeated Printful amounts globally across the year", () => {
    const dates = [
      ["2025-05-21", "2025-04-23"],
      ["2025-08-06", "2025-07-29"],
      ["2025-09-20", "2025-09-14"],
      ["2025-10-21", "2025-10-14"],
      ["2025-11-22", "2025-10-25"],
      ["2025-11-24", "2025-11-14"],
    ];
    const records = dates.flatMap(([documentDate, chargeDate], index) => [
      record({ id: `printful-doc-${index}`, sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: documentDate, amount: 21.94, counterparty: "Printful" }),
      record({ id: `printful-order-${index}`, sourceKind: "printful-orders", category: "wallet-charge", direction: "out", date: chargeDate, amount: 21.94, counterparty: "Printful", reference: `PF-${index}` }),
    ]);
    const links = runMatching(records).links.filter((link) => link.rule === "provider-document-global-assignment");
    expect(links).toHaveLength(6);
    expect(new Set(links.map((link) => link.fromId)).size).toBe(6);
    expect(new Set(links.map((link) => link.toId)).size).toBe(6);
  });

  it("matches several IONOS documents to one PayPal payment", () => {
    const records = [
      record({ id: "ionos-doc-1", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-06-17", amount: 6, counterparty: "1&1 Ionos Se" }),
      record({ id: "ionos-doc-2", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-06-17", amount: 1.5, counterparty: "1&1 Ionos Se" }),
      record({ id: "ionos-paypal", sourceKind: "paypal-business", category: "cash-movement", direction: "out", date: "2025-06-23", amount: 7.5, counterparty: "1&1 IONOS SE", metadata: { net: -7.5, balance: 0, time: "12:00:00" } }),
    ];
    const result = runMatching(records);
    expect(result.links.filter((link) => link.rule === "multiple-documents-single-payment")).toHaveLength(2);
    expect(coverageSummary(records, result.links).documents.open).toBe(0);
  });

  it("matches an eBay gross fee invoice while keeping corrections separate", () => {
    const records = [
      record({ id: "ebay-fee-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", date: "2025-10-31", amount: 17, counterparty: "Ebay GmbH" }),
      record({ id: "ebay-sale", sourceKind: "ebay-ledger", category: "sale", direction: "in", date: "2025-10-10", amount: 100, feeAmount: 15 }),
      record({ id: "ebay-fee", sourceKind: "ebay-ledger", category: "fee", direction: "out", date: "2025-10-11", amount: 2 }),
      record({ id: "ebay-credit", sourceKind: "ebay-ledger", category: "fee", direction: "in", date: "2025-10-12", amount: 4.72 }),
    ];
    const links = runMatching(records).links.filter((link) => link.rule === "platform-withheld-fees-gross");
    expect(links).toHaveLength(2);
    expect(links.some((link) => link.toId === "ebay-credit")).toBe(false);
  });

  it("assigns repeated PayPal and bank amounts globally one to one", () => {
    const records = [
      record({ id: "paypal-1", sourceKind: "paypal-business", category: "cash-movement", direction: "out", date: "2025-12-15", amount: 83.49, counterparty: "Gelato ASA" }),
      record({ id: "paypal-2", sourceKind: "paypal-business", category: "cash-movement", direction: "out", date: "2025-12-17", amount: 83.49, counterparty: "Gelato ASA" }),
      record({ id: "bank-1", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-12-15", amount: 83.49, counterparty: "PayPal", description: "Gelato ASA" }),
      record({ id: "bank-2", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-12-17", amount: 83.49, counterparty: "PayPal", description: "Gelato ASA" }),
    ];
    const links = runMatching(records).links.filter((link) => link.rule === "paypal-bank-global-assignment");
    expect(links).toHaveLength(2);
    expect(links.map((link) => [link.fromId, link.toId].sort())).toEqual(expect.arrayContaining([
      ["bank-1", "paypal-1"],
      ["bank-2", "paypal-2"],
    ]));
  });

  it("links eBay account debits to their bank debits", () => {
    const records = [
      record({ id: "ebay-debit", sourceKind: "ebay-ledger", category: "transfer", direction: "in", date: "2025-10-20", amount: 16.2, counterparty: "eBay" }),
      record({ id: "bank-debit", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", date: "2025-10-21", amount: 16.2, counterparty: "eBay S.a.r.l." }),
    ];
    expect(runMatching(records).links).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "ebay-debit-bank", confidence: 99 }),
    ]));
  });

  it("links an Etsy buyer-total invoice with a Sales-Tax warning", () => {
    const records = [
      record({ id: "sheryl-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-09-07", amount: 47.23, counterparty: "Sheryl Howard" }),
      record({ id: "sheryl-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-09-07", amount: 42.26, counterparty: "Sheryl Howard", reference: "3793475703", shop: "Form", metadata: { listingAmount: 47.23 } }),
    ];
    const result = runMatching(records);
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "etsy-buyer-total-sales-tax-warning" }),
    ]));
    expect(result.reviews).toEqual([
      expect.objectContaining({ recordId: "sheryl-doc", status: "warning" }),
    ]);
  });

  it("uses Etsy Sold Orders and excludes the Colorado buyer fee from invoice revenue", () => {
    const records = [
      record({ id: "teresa-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-07-16", amount: 23.85, counterparty: "Teresa Cole" }),
      record({ id: "teresa-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-07-15", amount: 24.08, counterparty: "Teresa Cole", reference: "3743707041", shop: "Frida", metadata: { listingAmount: 26.04 } }),
      record({ id: "teresa-detail", sourceKind: "etsy-sold-orders", category: "order-detail", direction: "in", date: "2025-07-15", amount: 23.85, counterparty: "Teresa Cole", reference: "3743707041", shop: "Frida" }),
      record({ id: "teresa-buyer-fee", sourceKind: "etsy-statement", category: "buyer-fee", direction: "out", date: "2025-07-15", amount: 0.23, reference: "3743707041", shop: "Frida" }),
    ];
    const result = runMatching(records);
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromId: "teresa-doc", toId: "teresa-order", rule: "etsy-related-party-exact" }),
    ]));
    expect(result.reviews).toHaveLength(0);
  });

  it("does not let one document resolve unrelated orders in the same payout component", () => {
    const records = [
      record({ id: "doc-a", sourceKind: "accountable-invoices", category: "document-income", direction: "in", amount: 20 }),
      record({ id: "order-a", sourceKind: "etsy-sales", category: "order", direction: "in", amount: 20 }),
      record({ id: "order-b", sourceKind: "etsy-sales", category: "order", direction: "in", amount: 30 }),
      record({ id: "payout", sourceKind: "etsy-statement", category: "payout", direction: "in", amount: 50 }),
    ];
    const links: MatchLink[] = [
      { id: "doc-order", fromId: "doc-a", toId: "order-a", type: "document-order", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
      { id: "order-a-payout", fromId: "order-a", toId: "payout", type: "platform-settlement", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
      { id: "order-b-payout", fromId: "order-b", toId: "payout", type: "platform-settlement", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
    ];
    expect(reconciliationAxes(records, links).get("order-a")?.businessEvidence).toBe("confirmed");
    expect(reconciliationAxes(records, links).get("order-b")?.businessEvidence).toBe("open");
  });

  it("warns when a fully refunded Etsy order has an invoice but no credit note", () => {
    const records = [
      record({ id: "valerie-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-03-28", amount: 21.2, counterparty: "DOSSOU Valérie" }),
      record({ id: "valerie-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-03-24", amount: 21.2, counterparty: "DOSSOU Valérie", reference: "3637984203", shop: "Frida", disposition: "resolved", metadata: { fullyRefunded: true, refundAmount: 21.2 } }),
    ];
    expect(runMatching(records).reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: "valerie-doc",
        status: "warning",
        note: expect.stringContaining("keine passende Stornorechnung"),
      }),
    ]));
  });

  it("keeps an identified zero-value Etsy invoice as a data error", () => {
    const records = [
      record({ id: "leilani-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", date: "2025-07-23", amount: 0, counterparty: "Leilani Moone" }),
      record({ id: "leilani-order", sourceKind: "etsy-sales", category: "order", direction: "in", date: "2025-07-23", amount: 15.11, counterparty: "Leilani Moone", reference: "3750522805", shop: "Form", metadata: { listingAmount: 16.17 } }),
    ];
    const result = runMatching(records);
    expect(result.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "etsy-zero-invoice-data-error" }),
    ]));
    expect(result.reviews).toEqual([
      expect.objectContaining({ recordId: "leilani-doc", status: "data-error" }),
    ]);
    expect(coverageSummary(records, result.links, result.reviews).documents.open).toBe(1);
  });

  it("lets a manual clarification resolve a documented exception without deleting its note", () => {
    const document = record({ id: "cursor-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", amount: 20, counterparty: "Cursor" });
    const review = {
      id: "review",
      recordId: document.id,
      status: "manual-cleared" as const,
      note: "Privater Zahlungsweg ist bekannt.",
      automatic: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const automaticWarning = {
      ...review,
      id: "automatic",
      status: "warning" as const,
      note: "Automatischer Hinweis",
      automatic: true,
    };
    const coverage = coverageSummary([document], [], [automaticWarning, review]);
    expect(coverage.documents).toEqual({ total: 1, resolved: 1, open: 0 });
    expect(coverage.reviews.manualCleared).toBe(1);
    expect(coverage.reviews.warnings).toBe(0);
    expect(coverage.exceptions).toBe(0);
  });
});
