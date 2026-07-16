import { describe, expect, it } from "vitest";
import type { MatchLink, NormalizedRecord } from "../types";
import { buildPlatformReconciliations, buildPlatformSummaries, buildSettlementBatches } from "./ledger";

function record(overrides: Partial<NormalizedRecord> & Pick<NormalizedRecord, "id" | "sourceKind" | "category" | "direction" | "amount">): NormalizedRecord {
  return {
    sourceId: `source-${overrides.sourceKind}`,
    sourceFile: `${overrides.sourceKind}.csv`,
    sourceRow: 2,
    date: "2025-12-30",
    currency: "EUR",
    counterparty: "",
    reference: "",
    relatedReferences: [],
    description: "",
    disposition: "active",
    metadata: {},
    ...overrides,
  };
}

describe("platform ledgers", () => {
  it("separates Etsy seller revenue, marketplace tax, fees and payout carry", () => {
    const records = [
      record({ id: "sale", sourceKind: "etsy-statement", category: "sale", direction: "in", amount: 80.85, shop: "Form", metadata: { payoutContribution: 80.85 } }),
      record({ id: "tax", sourceKind: "etsy-statement", category: "fee", direction: "out", amount: 6.81, shop: "Form", description: "Sales tax paid by buyer", metadata: { marketplaceTax: true, payoutContribution: -6.81 } }),
      record({ id: "fee", sourceKind: "etsy-statement", category: "fee", direction: "out", amount: 3.53, shop: "Form", description: "Processing fee", metadata: { payoutContribution: -3.53 } }),
      record({ id: "payout", sourceKind: "etsy-statement", category: "payout", direction: "in", amount: 70.51, shop: "Form" }),
    ];
    const annual = buildPlatformSummaries(records, [], 2025).find((summary) => summary.account === "Etsy · Form" && summary.period === "2025");
    expect(annual).toMatchObject({
      sellerRevenue: 74.04,
      marketplaceTax: 6.81,
      fees: 3.53,
      payouts: 70.51,
      carry: 0,
      status: "roll-forward",
    });
  });

  it("keeps Etsy Buyer Fees separate and subtracts fee and tax credits", () => {
    const records = [
      record({ id: "sale", sourceKind: "etsy-statement", category: "sale", direction: "in", amount: 26.04, shop: "Frida", metadata: { payoutContribution: 26.04 } }),
      record({ id: "tax", sourceKind: "etsy-statement", category: "fee", direction: "out", amount: 1.96, shop: "Frida", metadata: { marketplaceTax: true, payoutContribution: -1.96 } }),
      record({ id: "buyer-fee", sourceKind: "etsy-statement", category: "buyer-fee", direction: "out", amount: 0.23, shop: "Frida", metadata: { payoutContribution: -0.23 } }),
      record({ id: "fee", sourceKind: "etsy-statement", category: "fee", direction: "out", amount: 1.55, shop: "Frida", metadata: { payoutContribution: -1.55 } }),
      record({ id: "fee-credit", sourceKind: "etsy-statement", category: "fee", direction: "in", amount: 0.25, shop: "Frida", metadata: { payoutContribution: 0.25 } }),
      record({ id: "payout", sourceKind: "etsy-statement", category: "payout", direction: "in", amount: 22.55, shop: "Frida" }),
    ];
    const annual = buildPlatformSummaries(records, [], 2025).find((summary) => summary.account === "Etsy · Frida" && summary.period === "2025");
    expect(annual).toMatchObject({
      sellerRevenue: 23.85,
      marketplaceTax: 1.96,
      buyerFees: 0.23,
      fees: 1.3,
      carry: 0,
    });
  });

  it("compares only executed Etsy transfers with the bank", () => {
    const records = [
      record({ id: "sale", sourceKind: "etsy-sales", category: "order", direction: "in", amount: 100, shop: "Frida", metadata: { listingAmount: 100 } }),
      record({ id: "statement-payout", sourceKind: "etsy-statement", category: "payout", direction: "in", amount: 100, shop: "Frida" }),
      record({ id: "executed", sourceKind: "etsy-transfers", category: "payout", direction: "in", amount: 60, shop: "Frida" }),
      record({ id: "returned", sourceKind: "etsy-transfers", category: "payout", direction: "in", amount: 40, shop: "Frida", disposition: "ignored", dispositionReason: "Zurückgegebene Auszahlung" }),
      record({ id: "bank", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", amount: 60 }),
    ];
    const links: MatchLink[] = [
      { id: "payout-bank", fromId: "executed", toId: "bank", type: "payout-bank", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
    ];
    const control = buildPlatformReconciliations(records, links, 2025)[0];
    expect(control.paymentAxis).toMatchObject({ expected: 60, actual: 60, difference: 0 });
  });

  it("includes recognizable Etsy bank rows even when their direct payout link is missing", () => {
    const records = [
      record({ id: "sale", sourceKind: "etsy-sales", category: "order", direction: "in", amount: 100, shop: "Form", metadata: { listingAmount: 100 } }),
      record({ id: "executed", sourceKind: "etsy-transfers", category: "payout", direction: "in", amount: 60, shop: "Form" }),
      record({ id: "bank-linked", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", amount: 60, counterparty: "Etsy Payments Ireland Limited", metadata: { iban: "NL03SHOP" } }),
      record({ id: "bank-extra", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", amount: 25, counterparty: "Etsy Payments Ireland Limited", metadata: { iban: "NL03SHOP" } }),
    ];
    const links: MatchLink[] = [
      { id: "payout-bank", fromId: "executed", toId: "bank-linked", type: "payout-bank", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
    ];
    const control = buildPlatformReconciliations(records, links, 2025)[0];
    expect(control.paymentAxis).toMatchObject({ expected: 60, actual: 85, difference: 25, state: "open" });
    expect(control.paymentAxis.detail).toContain("1 ohne direkte Auszahlungsverknüpfung");
  });

  it("reconciles a PayPal currency against its reported balance", () => {
    const records = [
      record({ id: "income", sourceKind: "paypal-business", category: "cash-movement", direction: "in", date: "2025-04-15", amount: 684.91, metadata: { net: 684.91, balance: 684.91, time: "12:00:00" } }),
      record({ id: "withdraw", sourceKind: "paypal-business", category: "transfer", direction: "out", date: "2025-04-16", amount: 684.91, description: "Allgemeine Abbuchung – Bankkonto", metadata: { net: -684.91, balance: 0, time: "01:00:00" } }),
    ];
    const annual = buildPlatformSummaries(records, [], 2025).find((summary) => summary.account === "PayPal" && summary.period === "2025");
    expect(annual).toMatchObject({ openingBalance: 0, calculatedClosing: 0, reportedClosing: 0, residual: 0, status: "balanced" });
  });

  it("exports the composition of a settlement batch", () => {
    const records = [
      record({ id: "credit", sourceKind: "paypal-business", category: "cash-movement", direction: "in", amount: 100 }),
      record({ id: "withdraw", sourceKind: "paypal-business", category: "transfer", direction: "out", amount: 100 }),
    ];
    const links: MatchLink[] = [{
      id: "link",
      fromId: "credit",
      toId: "withdraw",
      type: "account-batch",
      confidence: 100,
      amountDifference: 0,
      rule: "paypal-running-balance-batch",
      reason: "Sammelgruppe",
      automatic: true,
    }];
    expect(buildSettlementBatches(records, links)[0]).toMatchObject({ account: "PayPal", amount: 100, memberCount: 2, verified: true });
  });

  it("separates eBay gross fees, corrections, net fees and bank-funded debits", () => {
    const records = [
      record({ id: "sale", sourceKind: "ebay-ledger", category: "sale", direction: "in", amount: 100, feeAmount: 15, metadata: { payoutId: "P-1" } }),
      record({ id: "refund", sourceKind: "ebay-ledger", category: "refund", direction: "out", amount: 20, feeAmount: -3, metadata: { payoutId: "P-1" } }),
      record({ id: "fee", sourceKind: "ebay-ledger", category: "fee", direction: "out", amount: 2, metadata: { payoutId: "P-1" } }),
      record({ id: "fee-credit", sourceKind: "ebay-ledger", category: "fee", direction: "in", amount: 2, metadata: { payoutId: "P-1" } }),
      record({ id: "debit", sourceKind: "ebay-ledger", category: "transfer", direction: "in", amount: 20, metadata: { payoutId: "P-1" } }),
      record({ id: "payout", sourceKind: "ebay-ledger", category: "payout", direction: "in", amount: 78, metadata: { payoutId: "P-1" } }),
      record({ id: "income-doc", sourceKind: "accountable-invoices", category: "document-income", direction: "in", amount: 80, counterparty: "eBay" }),
      record({ id: "fee-doc", sourceKind: "accountable-expenses", category: "document-expense", direction: "out", amount: 17, counterparty: "Ebay GmbH" }),
      record({ id: "bank-in", sourceKind: "bank-fyrst", category: "cash-movement", direction: "in", amount: 78, counterparty: "eBay" }),
      record({ id: "bank-out", sourceKind: "bank-fyrst", category: "cash-movement", direction: "out", amount: 20, counterparty: "eBay" }),
    ];
    const links: MatchLink[] = [
      { id: "sale-doc", fromId: "sale", toId: "income-doc", type: "document-order", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
      { id: "payout-bank", fromId: "payout", toId: "bank-in", type: "payout-bank", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
      { id: "debit-bank", fromId: "debit", toId: "bank-out", type: "payout-bank", confidence: 100, amountDifference: 0, rule: "test", reason: "test", automatic: true },
    ];
    const control = buildPlatformReconciliations(records, links, 2025)[0];
    expect(control).toMatchObject({
      platform: "eBay",
      sellerRevenue: 80,
      feeCharges: 17,
      feeCorrections: 5,
      fees: 12,
    });
    expect(control.feeDocumentAxis).toMatchObject({ expected: 17, actual: 17, difference: 0 });
    expect(control.paymentAxis).toMatchObject({ expected: 58, actual: 58, difference: 0 });
  });
});
