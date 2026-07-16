import * as XLSX from "xlsx";
import { strToU8, zipSync } from "fflate";
import type { PDFDocument, PDFPage, PDFFont, RGB } from "pdf-lib";
import type { BuchrecProject, MatchLink, NormalizedRecord, RecordReview } from "../types";
import { buildPlatformReconciliations, buildPlatformSummaries, buildSettlementBatches } from "./ledger";
import { coverageSummary, effectiveRecordReviews, isReconciliationRecord, reconciliationAxes, reconciliationState } from "./matching";
import { formatDate, formatMoney } from "./normalize";

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
  const coverage = coverageSummary(project.records, project.links, project.reviews);
  const recordMap = new Map(project.records.map((record) => [record.id, record]));
  const state = reconciliationState(project.records, project.links, project.reviews);
  const axes = reconciliationAxes(project.records, project.links, project.reviews);
  const platformSummaries = buildPlatformSummaries(project.records, project.links, project.settings.year);
  const platformControls = buildPlatformReconciliations(project.records, project.links, project.settings.year);
  const batches = buildSettlementBatches(project.records, project.links);
  const reviewsByRecord = new Map<string, RecordReview[]>();
  for (const review of project.reviews) {
    reviewsByRecord.set(review.recordId, [...(reviewsByRecord.get(review.recordId) ?? []), review]);
  }
  const effectiveReviews = effectiveRecordReviews(project.reviews);
  const overview = [
    { Kennzahl: "Accountable-Dokumente", Gesamt: coverage.documents.total, Geklärt: coverage.documents.resolved, Offen: coverage.documents.open },
    { Kennzahl: "Beleg-/Bestellnachweis", Gesamt: coverage.documentEvidence.total, Geklärt: coverage.documentEvidence.resolved, Offen: coverage.documentEvidence.open },
    { Kennzahl: "Zahlungsnachweis", Gesamt: coverage.paymentEvidence.total, Geklärt: coverage.paymentEvidence.resolved, Offen: coverage.paymentEvidence.open },
    { Kennzahl: "Kontenabstimmung", Gesamt: coverage.accountEvidence.total, Geklärt: coverage.accountEvidence.resolved, Offen: coverage.accountEvidence.open },
    { Kennzahl: "Zahlungsbewegungen", Gesamt: coverage.payments.total, Geklärt: coverage.payments.resolved, Offen: coverage.payments.open },
    { Kennzahl: "PayPal-Brücken", Gesamt: coverage.bridges.total, Geklärt: coverage.bridges.resolved, Offen: coverage.bridges.open },
    { Kennzahl: "Bestellungen", Gesamt: coverage.orders.total, Geklärt: coverage.orders.resolved, Offen: coverage.orders.open },
    { Kennzahl: "Test/Ausgeschlossen", Gesamt: coverage.orders.excluded, Geklärt: coverage.orders.excluded, Offen: 0 },
    { Kennzahl: "Manuell geklärt", Gesamt: coverage.reviews.manualCleared, Geklärt: coverage.reviews.manualCleared, Offen: 0 },
    { Kennzahl: "Warnungen", Gesamt: coverage.reviews.warnings, Geklärt: 0, Offen: coverage.reviews.warnings },
    { Kennzahl: "Datenfehler", Gesamt: coverage.reviews.dataErrors, Geklärt: 0, Offen: coverage.reviews.dataErrors },
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
        Bewertung: effectiveReviews.get(record.id)?.status ?? "",
        Anmerkung: effectiveReviews.get(record.id)?.note ?? "",
        Automatische_Hinweise: (reviewsByRecord.get(record.id) ?? []).filter((review) => review.automatic).map((review) => `${review.status}: ${review.note}`).join(" | "),
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
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(platformControls.flatMap((control) => [
    { Plattform: control.platform, Shop: control.shop ?? "", Periode: control.period, Ebene: control.documentAxis.label, ...control.documentAxis },
    ...(control.feeDocumentAxis ? [{ Plattform: control.platform, Shop: control.shop ?? "", Periode: control.period, Ebene: control.feeDocumentAxis.label, ...control.feeDocumentAxis }] : []),
    { Plattform: control.platform, Shop: control.shop ?? "", Periode: control.period, Ebene: control.platformAxis.label, ...control.platformAxis },
    { Plattform: control.platform, Shop: control.shop ?? "", Periode: control.period, Ebene: control.paymentAxis.label, ...control.paymentAxis },
  ])), "Plattformprüfung");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(batchRows), "Sammelgruppen");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(project.reviews.map((review) => {
    const record = recordMap.get(review.recordId);
    return {
      Status: review.status,
      Anmerkung: review.note,
      Automatisch: review.automatic ? "Ja" : "Nein",
      Erstellt: review.createdAt,
      Geändert: review.updatedAt,
      Quelle: record?.sourceFile ?? "",
      Zeile: record?.sourceRow ?? "",
      Gegenpartei: record?.counterparty ?? "",
      Referenz: record?.reference ?? "",
      Betrag: record?.amount ?? "",
    };
  })), "Bewertungen");
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

function pdfText(value: unknown): string {
  return String(value ?? "")
    .replaceAll("↔", "<->")
    .replaceAll("→", "->")
    .replaceAll("·", " - ")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("…", "...")
    .replaceAll("\u00a0", " ");
}

function wrappedLines(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

interface PdfContext {
  document: PDFDocument;
  font: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
}

const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const PDF_MARGIN = 42;
const PDF_GREEN = { type: "RGB", red: 0.05, green: 0.43, blue: 0.29 } as RGB;
const PDF_INK = { type: "RGB", red: 0.08, green: 0.12, blue: 0.1 } as RGB;
const PDF_MUTED = { type: "RGB", red: 0.38, green: 0.43, blue: 0.4 } as RGB;
const PDF_LINE = { type: "RGB", red: 0.86, green: 0.88, blue: 0.86 } as RGB;
const PDF_WARNING = { type: "RGB", red: 0.72, green: 0.34, blue: 0.08 } as RGB;

function newPdfPage(context: PdfContext): void {
  context.page = context.document.addPage([PDF_WIDTH, PDF_HEIGHT]);
  context.y = PDF_HEIGHT - PDF_MARGIN;
}

function ensurePdfSpace(context: PdfContext, height: number): void {
  if (context.y - height < PDF_MARGIN + 20) newPdfPage(context);
}

function drawPdfText(
  context: PdfContext,
  text: string,
  options: { size?: number; width?: number; bold?: boolean; color?: RGB; gap?: number } = {},
): void {
  const size = options.size ?? 9;
  const font = options.bold ? context.bold : context.font;
  const width = options.width ?? PDF_WIDTH - PDF_MARGIN * 2;
  const lines = wrappedLines(font, text, size, width);
  const lineHeight = size * 1.35;
  ensurePdfSpace(context, lines.length * lineHeight + (options.gap ?? 0));
  for (const line of lines) {
    context.page.drawText(line, {
      x: PDF_MARGIN,
      y: context.y - size,
      size,
      font,
      color: options.color ?? PDF_INK,
    });
    context.y -= lineHeight;
  }
  context.y -= options.gap ?? 0;
}

function drawPdfSection(context: PdfContext, title: string): void {
  ensurePdfSpace(context, 38);
  context.y -= 7;
  drawPdfText(context, title, { size: 15, bold: true, gap: 8 });
  context.page.drawLine({
    start: { x: PDF_MARGIN, y: context.y + 3 },
    end: { x: PDF_WIDTH - PDF_MARGIN, y: context.y + 3 },
    thickness: 0.8,
    color: PDF_LINE,
  });
  context.y -= 7;
}

function drawPdfMetric(context: PdfContext, label: string, value: string, detail: string): void {
  ensurePdfSpace(context, 36);
  context.page.drawText(pdfText(label), { x: PDF_MARGIN, y: context.y - 9, size: 9, font: context.bold, color: PDF_INK });
  const valueWidth = context.bold.widthOfTextAtSize(pdfText(value), 10);
  context.page.drawText(pdfText(value), { x: PDF_WIDTH - PDF_MARGIN - valueWidth, y: context.y - 9, size: 10, font: context.bold, color: PDF_GREEN });
  context.page.drawText(pdfText(detail), { x: PDF_MARGIN, y: context.y - 24, size: 7.5, font: context.font, color: PDF_MUTED });
  context.y -= 36;
}

export async function buildAuditPdf(project: BuchrecProject): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const context: PdfContext = {
    document,
    font,
    bold,
    page: document.addPage([PDF_WIDTH, PDF_HEIGHT]),
    y: PDF_HEIGHT - PDF_MARGIN,
  };
  const coverage = coverageSummary(project.records, project.links, project.reviews);
  const controls = buildPlatformReconciliations(project.records, project.links, project.settings.year);
  const state = reconciliationState(project.records, project.links, project.reviews);
  const reviewsByRecord = new Map<string, RecordReview[]>();
  for (const review of project.reviews) {
    reviewsByRecord.set(review.recordId, [...(reviewsByRecord.get(review.recordId) ?? []), review]);
  }
  const effectiveReviews = effectiveRecordReviews(project.reviews);

  drawPdfText(context, "buchrec", { size: 11, bold: true, color: PDF_GREEN, gap: 12 });
  drawPdfText(context, `Prüfbericht ${project.settings.year}`, { size: 26, bold: true, gap: 6 });
  drawPdfText(context, `Erzeugt am ${new Date().toLocaleString("de-DE")} aus dem aktuellen lokalen Projektstand.`, { size: 9, color: PDF_MUTED, gap: 18 });

  drawPdfSection(context, "Prüfstand");
  drawPdfMetric(context, "Beleg <-> Bestellung", `${coverage.documentEvidence.resolved} / ${coverage.documentEvidence.total}`, `${coverage.documentEvidence.open} offen`);
  drawPdfMetric(context, "Zahlungsnachweis", `${coverage.paymentEvidence.resolved} / ${coverage.paymentEvidence.total}`, `${coverage.paymentEvidence.open} offen`);
  drawPdfMetric(context, "Kontenabstimmung", `${coverage.accountEvidence.resolved} / ${coverage.accountEvidence.total}`, `${coverage.accountEvidence.open} offen`);
  drawPdfMetric(context, "Bankzahlungen", `${coverage.payments.resolved} / ${coverage.payments.total}`, `${coverage.payments.open} offen`);
  drawPdfMetric(context, "PayPal-Konto", `${coverage.bridges.resolved} / ${coverage.bridges.total}`, `${coverage.bridges.open} offen`);
  drawPdfMetric(context, "Bestellungen", `${coverage.orders.resolved} / ${Math.max(0, coverage.orders.total - coverage.orders.excluded)}`, `${coverage.orders.excluded} Tests ausgeschlossen`);
  drawPdfText(context, `Manuell geklärt: ${coverage.reviews.manualCleared}   Warnungen: ${coverage.reviews.warnings}   Datenfehler: ${coverage.reviews.dataErrors}`, { size: 9, bold: true, color: coverage.reviews.warnings || coverage.reviews.dataErrors ? PDF_WARNING : PDF_GREEN });

  drawPdfSection(context, "Plattformabrechnungen");
  for (const control of controls) {
    ensurePdfSpace(context, 150);
    drawPdfText(context, `${control.platform}${control.shop ? ` - ${control.shop}` : ""}`, { size: 12, bold: true, gap: 4 });
    for (const axis of [control.documentAxis, control.feeDocumentAxis, control.platformAxis, control.paymentAxis].filter(Boolean)) {
      const current = axis!;
      drawPdfText(
        context,
        `${current.label}: Soll ${formatMoney(current.expected)} | Ist ${formatMoney(current.actual)} | Differenz ${formatMoney(current.difference)}`,
        { size: 8.3, color: current.state === "confirmed" ? PDF_GREEN : PDF_WARNING, gap: 2 },
      );
    }
    drawPdfText(
      context,
      `Käufer ${formatMoney(control.buyerPayments)} - Tax ${formatMoney(control.marketplaceTax)} = Verkäuferumsatz ${formatMoney(control.sellerRevenue)}; Gebühren brutto ${formatMoney(control.feeCharges)}, Gebührenkorrekturen ${formatMoney(-control.feeCorrections)}, Gebühren netto ${formatMoney(control.fees)}, Erstattungen ${formatMoney(control.refunds)}, Anpassungen ${formatMoney(control.adjustments)}, Auszahlungen ${formatMoney(control.payouts)}, Differenz/Übertrag ${formatMoney(control.carry)}.`,
      { size: 7.8, color: PDF_MUTED, gap: 8 },
    );
  }

  const flaggedIds = new Set(
    [...effectiveReviews.values()]
      .filter((review) => review.status !== "manual-cleared")
      .map((review) => review.recordId),
  );
  const exceptions = project.records
    .filter((record) => isReconciliationRecord(record) && (state.open.has(record.id) || flaggedIds.has(record.id)))
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount));
  drawPdfSection(context, `Ausnahmen und Hinweise (${exceptions.length})`);
  for (const record of exceptions) {
    const recordReviews = reviewsByRecord.get(record.id) ?? [];
    const status = recordReviews.map((review) => review.status).join(", ") || "offen";
    const note = recordReviews.map((review) => review.note).join(" | ");
    ensurePdfSpace(context, note ? 52 : 34);
    drawPdfText(
      context,
      `${formatDate(record.date)} | ${record.counterparty || record.description} | ${record.reference || "-"} | ${formatMoney(record.amount, record.currency)} | ${status}`,
      { size: 8.2, bold: true, gap: 1 },
    );
    if (note) drawPdfText(context, note, { size: 7.5, color: PDF_MUTED, gap: 5 });
  }

  drawPdfSection(context, `Quelldateien (${project.sources.length})`);
  for (const source of project.sources) {
    drawPdfText(
      context,
      `${source.fileName} | ${source.kind} | ${source.rowCount} Zeilen | SHA-256 ${source.contentHash ?? "nicht vorhanden"}`,
      { size: 7.4, color: PDF_MUTED, gap: 3 },
    );
  }

  drawPdfSection(context, "Verfahren und Einschränkung");
  drawPdfText(context, "Der Bericht trennt Belegabgleich, Plattformkonto und Zahlungsnachweis. PayPal wird als Zwischenkonto behandelt; PayPal- und Bankzeile werden nicht doppelt als Zahlung gezählt.", { size: 8.5, gap: 5 });
  drawPdfText(context, "Marketplace Sales Tax wird getrennt vom Verkäuferumsatz ausgewiesen. Manuelle Bewertungen bleiben mit Anmerkung und Zeitstempel nachvollziehbar.", { size: 8.5, gap: 5 });
  drawPdfText(context, "Dieser technische Bericht unterstützt die Nachprüfung. Er ersetzt weder Originalbelege noch eine steuerliche oder rechtliche Beurteilung.", { size: 8.5, color: PDF_MUTED });

  const pages = document.getPages();
  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: PDF_MARGIN, y: 27 },
      end: { x: PDF_WIDTH - PDF_MARGIN, y: 27 },
      thickness: 0.6,
      color: PDF_LINE,
    });
    const footer = `buchrec - ${project.settings.year} - Seite ${index + 1} von ${pages.length}`;
    page.drawText(footer, { x: PDF_MARGIN, y: 14, size: 7, font, color: PDF_MUTED });
  });
  return document.save();
}

export async function exportAuditPdf(project: BuchrecProject): Promise<void> {
  download(await buildAuditPdf(project), `buchrec-pruefbericht-${project.settings.year}.pdf`, "application/pdf");
}

export async function buildAuditPackage(project: BuchrecProject): Promise<Uint8Array> {
  const workbook = auditWorkbook(project);
  const workbookBytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true }));
  const summaries = buildPlatformSummaries(project.records, project.links, project.settings.year);
  const platformControls = buildPlatformReconciliations(project.records, project.links, project.settings.year);
  const batches = buildSettlementBatches(project.records, project.links);
  const pdfBytes = await buildAuditPdf(project);
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
    platformControls,
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
    "pruefbericht.pdf": pdfBytes,
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "projekt.json": strToU8(JSON.stringify(project, null, 2)),
    "VERFAHRENSDOKUMENTATION.txt": strToU8(readme),
  }, { level: 6 });
}

export async function exportAuditPackage(project: BuchrecProject): Promise<void> {
  const archive = await buildAuditPackage(project);
  download(archive, `buchrec-pruefpaket-${project.settings.year}.zip`, "application/zip");
}
