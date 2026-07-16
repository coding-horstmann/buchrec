import * as XLSX from "xlsx";
import { strToU8, zipSync } from "fflate";
import type { BuchrecProject, MatchLink, NormalizedRecord } from "../types";
import { buildPlatformSummaries, buildSettlementBatches } from "./ledger";
import { coverageSummary, isReconciliationRecord, reconciliationAxes, reconciliationState } from "./matching";

function recordExport(record: NormalizedRecord) {
  return {
    ID: record.id,
    Quelle: record.sourceFile,
    Zeile: record.sourceRow,
    Typ: record.category,
    Richtung: record.direction,
    Datum: record.date ?? "",
    Zahlungsdatum: record.paymentDate ?? "",
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

function auditWorkbook(project: BuchrecProject): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const coverage = coverageSummary(project.records, project.links);
  const recordMap = new Map(project.records.map((record) => [record.id, record]));
  const state = reconciliationState(project.records, project.links);
  const axes = reconciliationAxes(project.records, project.links);
  const platformSummaries = buildPlatformSummaries(project.records, project.links, project.settings.year);
  const batches = buildSettlementBatches(project.records, project.links);
  const overview = [
    { Kennzahl: "Accountable-Dokumente", Gesamt: coverage.documents.total, Geklärt: coverage.documents.resolved, Offen: coverage.documents.open },
    { Kennzahl: "Beleg-/Bestellnachweis", Gesamt: coverage.documentEvidence.total, Geklärt: coverage.documentEvidence.resolved, Offen: coverage.documentEvidence.open },
    { Kennzahl: "Zahlungsnachweis", Gesamt: coverage.paymentEvidence.total, Geklärt: coverage.paymentEvidence.resolved, Offen: coverage.paymentEvidence.open },
    { Kennzahl: "Kontenabstimmung", Gesamt: coverage.accountEvidence.total, Geklärt: coverage.accountEvidence.resolved, Offen: coverage.accountEvidence.open },
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
    SHA256: source.contentHash ?? "Bei älterem Projektimport nicht vorhanden",
  }));
  const statusAxes = project.records
    .filter(isReconciliationRecord)
    .map((record) => {
      const status = axes.get(record.id);
      return {
        ...recordExport(record),
        Beleg_Bestellung: status?.businessEvidence ?? "",
        Beleg_Begründung: status?.businessReason ?? "",
        Zahlungsnachweis: status?.paymentEvidence ?? "",
        Zahlungs_Begründung: status?.paymentReason ?? "",
        Kontenabstimmung: status?.accountEvidence ?? "",
        Konten_Begründung: status?.accountReason ?? "",
      };
    });
  const batchRows = batches.flatMap((batch) =>
    batch.memberIds.map((memberId) => {
      const member = recordMap.get(memberId);
      return {
        Sammel_ID: batch.id,
        Konto: batch.account,
        Bezeichnung: batch.label,
        Datum: batch.date ?? "",
        Währung: batch.currency,
        Sammelbetrag: batch.amount,
        Positionen: batch.memberCount,
        Regel: batch.rule,
        Rechnerisch_bestätigt: batch.verified ? "Ja" : "Nein",
        Mitglied_Quelle: member?.sourceFile ?? "",
        Mitglied_Zeile: member?.sourceRow ?? "",
        Mitglied_Typ: member?.category ?? "",
        Mitglied_Gegenpartei: member?.counterparty ?? "",
        Mitglied_Referenz: member?.reference ?? "",
        Mitglied_Betrag: member?.amount ?? "",
      };
    }),
  );
  const procedure = [
    { Abschnitt: "Zweck", Beschreibung: "Nachvollziehbarer Zahlungsabgleich zwischen Accountable, Plattformen, PayPal und Bankkonten." },
    { Abschnitt: "Datenhaltung", Beschreibung: "Finanzdaten werden ausschließlich im Browser verarbeitet und lokal gespeichert." },
    { Abschnitt: "Originaldateien", Beschreibung: "Originalexporte bleiben unverändert aufzubewahren. Dieser Bericht enthält Dateiname, Größe und SHA-256-Prüfsumme." },
    { Abschnitt: "Belegnachweis", Beschreibung: "Beleg ↔ Bestellung beziehungsweise Anbieterauftrag wird unabhängig vom späteren Zahlungsweg bewertet." },
    { Abschnitt: "Zahlungsnachweis", Beschreibung: "Bank, PayPal, Plattformkonto und Anbieter-Wallet sind getrennte Zahlungskonten." },
    { Abschnitt: "PayPal", Beschreibung: "PayPal wird pro Währung über den laufenden Guthabenstand abgestimmt. Sammelabbuchungen enthalten alle zugehörigen Bewegungen." },
    { Abschnitt: "Etsy", Beschreibung: "Käuferzahlung, Marketplace Sales Tax, Verkäuferumsatz, Gebühren, Erstattungen, Auszahlung und Carry werden je Shop getrennt." },
    { Abschnitt: "Jahresrand", Beschreibung: "Nicht ausgezahlte Plattformbeträge werden als Carry fortgeschrieben und nicht künstlich einer Bankzahlung zugeordnet." },
    { Abschnitt: "Fremdwährung", Beschreibung: "Printler-SEK-Zahlungen werden über Händler und Zeitfenster verbunden; der abgeleitete Kurs bleibt als Einschränkung sichtbar." },
    { Abschnitt: "Manuelle Entscheidungen", Beschreibung: "Manuelle Verbindungen und Klassifizierungen bleiben mit Begründung im Projekt und Prüfbericht erhalten." },
    { Abschnitt: "Einschränkung", Beschreibung: "Der Bericht unterstützt die Nachprüfung, ersetzt aber weder Originalbelege noch eine steuerliche Beurteilung." },
  ];
  const exceptions = project.records.filter(
    (record) => record.disposition === "active" && isReconciliationRecord(record) && state.open.has(record.id),
  );

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(overview), "Übersicht");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sources), "Quellen");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(project.sources.map((source) => ({
      Datei: source.fileName,
      Größe_Bytes: source.fileSize,
      SHA256: source.contentHash ?? "Bei älterem Projektimport nicht vorhanden",
      Importtyp: source.kind,
      Shop: source.shop ?? "",
    }))),
    "Dateiprüfsummen",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(project.records.filter((record) => record.category.startsWith("document") || record.category === "tax-payment").map(recordExport)),
    "Accountable",
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(project.records.map(recordExport)), "Alle Daten");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(project.links.map((link) => linkExport(link, recordMap))), "Zuordnungen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(statusAxes), "Statusachsen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(platformSummaries), "Kontenabgleich");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(batchRows), "Sammelgruppen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(procedure), "Verfahrensdoku");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exceptions.map(recordExport)), "Ausnahmen");
  return workbook;
}

function download(bytes: Uint8Array, fileName: string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportAuditWorkbook(project: BuchrecProject): void {
  const workbook = auditWorkbook(project);
  XLSX.writeFile(workbook, `buchrec-pruefung-${project.settings.year}.xlsx`, { compression: true });
}

export function buildAuditPackage(project: BuchrecProject): Uint8Array {
  const workbook = auditWorkbook(project);
  const workbookBytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }));
  const summaries = buildPlatformSummaries(project.records, project.links, project.settings.year);
  const batches = buildSettlementBatches(project.records, project.links);
  const manifest = {
    format: "buchrec-audit-package",
    version: 1,
    generatedAt: new Date().toISOString(),
    year: project.settings.year,
    browserOnly: true,
    sources: project.sources.map((source) => ({
      fileName: source.fileName,
      fileSize: source.fileSize,
      sha256: source.contentHash ?? null,
      kind: source.kind,
      shop: source.shop ?? null,
      warnings: source.warnings,
    })),
    rules: project.settings,
    platformSummaries: summaries,
    batches,
    project,
  };
  const readme = [
    "buchrec-Prüfpaket",
    "",
    "1. Original-CSV-/Excel-Dateien unverändert zusammen mit diesem Paket aufbewahren.",
    "2. pruefbericht.xlsx enthält Statusachsen, Kontenfortschreibung, Sammelgruppen und Ausnahmen.",
    "3. projekt.json enthält den vollständigen lokalen Arbeitsstand einschließlich manueller Entscheidungen.",
    "4. manifest.json enthält Dateiprüfsummen und maschinenlesbare Kontrollen.",
    "5. Das Paket unterstützt die Nachvollziehbarkeit, ersetzt aber keine steuerliche Prüfung.",
  ].join("\n");
  return zipSync({
    "pruefbericht.xlsx": workbookBytes,
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "projekt.json": strToU8(JSON.stringify(project, null, 2)),
    "VERFAHRENSDOKUMENTATION.txt": strToU8(readme),
  }, { level: 6 });
}

export function exportAuditPackage(project: BuchrecProject): void {
  const archive = buildAuditPackage(project);
  download(archive, `buchrec-pruefpaket-${project.settings.year}.zip`, "application/zip");
}
