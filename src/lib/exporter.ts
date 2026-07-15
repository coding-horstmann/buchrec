import * as XLSX from "xlsx";
import type { BuchrecProject, MatchLink, NormalizedRecord } from "../types";
import { coverageSummary, isReconciliationRecord, reconciliationState } from "./matching";

function recordExport(record: NormalizedRecord) {
  return {
    ID: record.id,
    Quelle: record.sourceFile,
    Zeile: record.sourceRow,
    Typ: record.category,
    Richtung: record.direction,
    Datum: record.date ?? "",
    Betrag: record.amount,
    Währung: record.currency,
    Gegenpartei: record.counterparty,
    Referenz: record.reference,
    Beschreibung: record.description,
    Status: record.disposition,
    Begründung: record.dispositionReason ?? "",
  };
}

function linkExport(link: MatchLink, records: Map<string, NormalizedRecord>) {
  const from = records.get(link.fromId);
  const to = records.get(link.toId);
  return {
    Match_ID: link.id,
    Von_Quelle: from?.sourceFile ?? "",
    Von_Typ: from?.category ?? "",
    Von_Referenz: from?.reference ?? "",
    Zu_Quelle: to?.sourceFile ?? "",
    Zu_Typ: to?.category ?? "",
    Zu_Referenz: to?.reference ?? "",
    Match_Typ: link.type,
    Sicherheit: link.confidence / 100,
    Betragsdifferenz: link.amountDifference,
    Datumsabstand_Tage: link.dateDifference ?? "",
    Regel: link.rule,
    Begründung: link.reason,
    Automatisch: link.automatic ? "Ja" : "Nein",
  };
}

export function exportAuditWorkbook(project: BuchrecProject): void {
  const workbook = XLSX.utils.book_new();
  const coverage = coverageSummary(project.records, project.links);
  const recordMap = new Map(project.records.map((record) => [record.id, record]));
  const state = reconciliationState(project.records, project.links);
  const overview = [
    { Kennzahl: "Accountable-Dokumente", Gesamt: coverage.documents.total, Geklärt: coverage.documents.resolved, Offen: coverage.documents.open },
    { Kennzahl: "Zahlungsbewegungen", Gesamt: coverage.payments.total, Geklärt: coverage.payments.resolved, Offen: coverage.payments.open },
    { Kennzahl: "PayPal-Brücken", Gesamt: coverage.bridges.total, Geklärt: coverage.bridges.resolved, Offen: coverage.bridges.open },
    { Kennzahl: "Bestellungen", Gesamt: coverage.orders.total, Geklärt: coverage.orders.resolved, Offen: coverage.orders.open },
    { Kennzahl: "Test/Ausgeschlossen", Gesamt: coverage.orders.excluded, Geklärt: coverage.orders.excluded, Offen: 0 },
  ];
  const sources = project.sources.map((source) => ({
    Datei: source.fileName,
    Tabelle: source.sheetName ?? "",
    Erkannter_Typ: source.label,
    Shop: source.shop ?? "",
    Zeilen: source.rowCount,
    Von: source.dateMin ?? "",
    Bis: source.dateMax ?? "",
    Ignoriert: source.ignored ? "Ja" : "Nein",
    Warnungen: source.warnings.join(" | "),
  }));
  const exceptions = project.records.filter(
    (record) => record.disposition === "active" && isReconciliationRecord(record) && state.open.has(record.id),
  );

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(overview), "Übersicht");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sources), "Quellen");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(project.records.filter((record) => record.category.startsWith("document") || record.category === "tax-payment").map(recordExport)),
    "Accountable",
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(project.records.map(recordExport)), "Alle Daten");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(project.links.map((link) => linkExport(link, recordMap))), "Zuordnungen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exceptions.map(recordExport)), "Ausnahmen");
  XLSX.writeFile(workbook, `buchrec-pruefung-${project.settings.year}.xlsx`, { compression: true });
}
