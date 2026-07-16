import { describe, expect, it } from "vitest";
import type { MatchCandidate, MatchLink, ParsedFileResult, SourceImport } from "../types";
import { canonicalEtsyShop, createProject, filterCandidatesAgainstDecisions, mergeParsedFiles } from "./project";

function parsed(id: string, fileName: string, contentHash: string): ParsedFileResult {
  const source: SourceImport = {
    id,
    fileName,
    fileSize: 10,
    fingerprint: id,
    contentHash,
    kind: "bank-fyrst",
    label: "FYRST",
    headerRow: 0,
    rowCount: 1,
    warnings: [],
    ignored: false,
  };
  return {
    sources: [source],
    records: [{
      id: `record-${id}`,
      sourceId: id,
      sourceKind: "bank-fyrst",
      sourceFile: fileName,
      sourceRow: 2,
      date: "2025-01-01",
      category: "cash-movement",
      direction: "in",
      amount: 10,
      currency: "EUR",
      counterparty: "Test",
      reference: "",
      relatedReferences: [],
      description: "",
      disposition: "active",
      metadata: {},
    }],
  };
}

describe("project imports", () => {
  it("keeps Etsy account aliases on their configured canonical shop", () => {
    const aliases = createProject().settings.etsyShopAliases;
    expect(canonicalEtsyShop("FantasiasFloralesCo", aliases)).toBe("Frida");
    expect(canonicalEtsyShop("FormAndFunctionDE", aliases)).toBe("Form");
  });

  it("removes competing proposals after a manual decision", () => {
    const candidate = (id: string, fromId: string, toId: string): MatchCandidate => ({
      id,
      fromId,
      toId,
      type: "document-payment",
      confidence: 80,
      amountDifference: 0,
      rule: "test",
      reason: "test",
      automatic: false,
    });
    const accepted: MatchLink = { ...candidate("accepted", "doc", "payment-1"), automatic: false };
    expect(filterCandidatesAgainstDecisions([
      candidate("same-doc", "doc", "payment-2"),
      candidate("same-payment", "other-doc", "payment-1"),
      candidate("free", "free-doc", "payment-3"),
    ], [accepted]).map((entry) => entry.id)).toEqual(["free"]);
  });

  it("ignores duplicate files by SHA-256 even when their names differ", () => {
    const project = createProject();
    const first = mergeParsedFiles(project, [parsed("source-a", "erst.csv", "same-hash")]);
    const second = mergeParsedFiles({ ...project, ...first }, [parsed("source-b", "kopie.csv", "same-hash")]);
    expect(second.sources).toHaveLength(1);
    expect(second.records).toHaveLength(1);
    expect(second.sources[0].fileName).toBe("erst.csv");
  });

  it("does not duplicate records when identical files occur in one upload batch", () => {
    const first = parsed("same-source", "erst.csv", "same-hash");
    const duplicate = {
      ...parsed("same-source", "kopie.csv", "same-hash"),
      records: [{ ...first.records[0], sourceFile: "kopie.csv" }],
    };
    const merged = mergeParsedFiles(createProject(), [first, duplicate]);
    expect(merged.sources).toHaveLength(1);
    expect(merged.records).toHaveLength(1);
  });
});
