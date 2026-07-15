import type { BuchrecProject, NormalizedRecord, SourceImport, SourceKind } from "../types";
import { createProject, synchronousMatch } from "./project";

function source(id: string, kind: SourceKind, label: string): SourceImport {
  return { id, fileName: `${id}.csv`, fileSize: 100, fingerprint: id, kind, label, headerRow: 0, rowCount: 2, warnings: [], ignored: false };
}

function record(overrides: Partial<NormalizedRecord> & Pick<NormalizedRecord, "id" | "sourceId" | "sourceKind" | "category" | "direction" | "amount">): NormalizedRecord {
  return {
    sourceFile: `${overrides.sourceId}.csv`, sourceRow: 2, date: "2025-03-12", currency: "EUR", counterparty: "Beispiel GmbH", reference: "BEISPIEL-1001",
    relatedReferences: ["BEISPIEL-1001"], description: "Synthetischer Testdatensatz", disposition: "active", metadata: {}, ...overrides,
  };
}

export function createDemoProject(): BuchrecProject {
  const base = createProject();
  base.settings = { ...base.settings, year: 2025 };
  const sources = [
    source("accountable-ausgaben-demo", "accountable-expenses", "Accountable · Ausgaben"),
    source("accountable-rechnungen-demo", "accountable-invoices", "Accountable · Rechnungen"),
    source("fyrst-demo", "bank-fyrst", "FYRST"),
    source("shopify-demo", "shopify-orders", "Shopify · Bestellungen"),
  ];
  const records = [
    record({ id: "expense-demo", sourceId: sources[0].id, sourceKind: sources[0].kind, category: "document-expense", direction: "out", amount: 49.99 }),
    record({ id: "invoice-demo", sourceId: sources[1].id, sourceKind: sources[1].kind, category: "document-income", direction: "in", amount: 89, counterparty: "Erika Beispiel", reference: "SHOP-1001", relatedReferences: ["SHOP-1001"] }),
    record({ id: "payment-demo", sourceId: sources[2].id, sourceKind: sources[2].kind, category: "cash-movement", direction: "out", amount: 49.99 }),
    record({ id: "order-demo", sourceId: sources[3].id, sourceKind: sources[3].kind, category: "order", direction: "in", amount: 89, counterparty: "Erika Beispiel", reference: "SHOP-1001", relatedReferences: ["SHOP-1001"], shop: "Beispielshop" }),
    record({ id: "test-order-demo", sourceId: sources[3].id, sourceKind: sources[3].kind, category: "order", direction: "in", amount: 0, counterparty: "Testkunde", reference: "SHOP-TEST", relatedReferences: ["SHOP-TEST"], disposition: "test", dispositionReason: "0-Euro-Bestellung", shop: "Beispielshop" }),
  ];
  return synchronousMatch({ ...base, name: "Synthetischer Browser-Test", sources, records });
}
