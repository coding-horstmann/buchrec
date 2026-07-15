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
    expect(runMatching(records).links[0]).toMatchObject({ type: "internal-transfer" });
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
});
