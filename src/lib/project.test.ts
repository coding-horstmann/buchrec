import { describe, expect, it } from "vitest";
import type { ParsedFileResult, SourceImport } from "../types";
import { createProject, mergeParsedFiles } from "./project";

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
