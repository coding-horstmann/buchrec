import { describe, expect, it } from "vitest";
import type { MatchLink, NormalizedRecord } from "../types";
import { buildPlatformSummaries, buildSettlementBatches } from "./ledger";

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
});
