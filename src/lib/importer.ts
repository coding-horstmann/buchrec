import Papa from "papaparse";
import * as XLSX from "xlsx";
import type {
  Direction,
  MetadataValue,
  NormalizedRecord,
  ParsedFileResult,
  RecordCategory,
  SourceImport,
  SourceKind,
} from "../types";
import { SOURCE_LABELS } from "../types";
import {
  directionFromAmount,
  makeId,
  metadataValue,
  normalizeHeader,
  normalizeText,
  parseAmount,
  parseDate,
  referenceTokens,
  roundMoney,
} from "./normalize";

type Cell = string | number | boolean | Date | null | undefined;
type RowObject = Record<string, Cell>;

interface TableData {
  sheetName?: string;
  rows: Cell[][];
}

interface Signature {
  kind: SourceKind;
  required: string[];
}

const SIGNATURES: Signature[] = [
  { kind: "bank-fyrst", required: ["buchungstag", "umsatzart", "betrag", "soll", "haben"] },
  { kind: "paypal-business", required: ["datum", "brutto", "netto", "transaktionscode", "zugehoriger transaktionscode"] },
  { kind: "bank-n26", required: ["booking date", "partner name", "amount eur", "original currency"] },
  { kind: "bank-dkb-ignored", required: ["buchungsdatum", "zahlungspflichtige r", "zahlungsempfanger in", "betrag"] },
  { kind: "etsy-sales", required: ["payment id", "order id", "gross amount", "net amount", "order date"] },
  { kind: "etsy-transfers", required: ["date", "amount", "status", "bank account ending digits"] },
  { kind: "etsy-statement", required: ["datum", "art", "titel", "gebuhren steuern", "netto"] },
  { kind: "ebay-orders", required: ["verkaufsprotokollnummer", "bestellnummer", "gesamtbetrag", "verkauft am"] },
  { kind: "ebay-ledger", required: ["datum der transaktionserstellung", "typ", "auszahlung nr", "betrag abzugl kosten"] },
  { kind: "shopify-orders", required: ["name", "financial status", "total", "created at", "payment method"] },
  { kind: "shopify-billing", required: ["bill", "store name", "charge category", "amount", "billing cycle"] },
  { kind: "printful-orders", required: ["datum", "bestellung", "printful id", "zahlungsinstrument", "gesamtsumme"] },
  { kind: "printful-wallet", required: ["datum", "aktion", "zahlungsinstrument", "betrag"] },
  { kind: "gelato", required: ["date", "reference id", "product charge", "shipping charge", "total charge"] },
];

function decodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function parseCsv(buffer: ArrayBuffer): Cell[][] {
  const text = decodeBuffer(buffer);
  let bestRows: Cell[][] = [];
  let bestScore = -1;
  for (const delimiter of [";", ",", "\t", "|"]) {
    const parsed = Papa.parse<Cell[]>(text, {
      delimiter,
      skipEmptyLines: false,
      dynamicTyping: false,
    });
    const rows = parsed.data as Cell[][];
    const scan = rows.slice(0, 15);
    const signature = Math.max(
      0,
      ...scan.flatMap((row) => SIGNATURES.map((entry) => signatureScore(row, entry))),
    );
    const widest = Math.max(0, ...scan.map((row) => row.filter((cell) => String(cell ?? "").trim()).length));
    const score = signature * 1_000 + widest;
    if (score > bestScore) {
      bestRows = rows;
      bestScore = score;
    }
  }
  return bestRows;
}

function normalizedHeaderSet(row: Cell[]): Set<string> {
  return new Set(row.map(normalizeHeader).filter(Boolean));
}

function signatureScore(row: Cell[], signature: Signature): number {
  const headers = normalizedHeaderSet(row);
  return signature.required.reduce((score, required) => {
    const exact = headers.has(required);
    const partial = [...headers].some((header) => header.includes(required) || required.includes(header));
    return score + (exact ? 3 : partial ? 1 : 0);
  }, 0);
}

export function findHeaderIndex(rows: Cell[][]): number {
  const scanLimit = Math.min(rows.length, 15);
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < scanLimit; index += 1) {
    const row = rows[index];
    const signature = Math.max(...SIGNATURES.map((entry) => signatureScore(row, entry)));
    const nonEmpty = row.filter((cell) => String(cell ?? "").trim()).length;
    const alpha = row.filter((cell) => /[a-zA-ZäöüÄÖÜß]/.test(String(cell ?? ""))).length;
    const score = signature * 100 + nonEmpty + alpha * 0.25;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function detectSourceKind(headers: Cell[], sheetName?: string): SourceKind {
  const sheet = normalizeHeader(sheetName);
  const headerSet = normalizedHeaderSet(headers);
  if (sheet === "ausgaben" && headerSet.has("name des lieferanten")) return "accountable-expenses";
  if (sheet === "rechnungen" && headerSet.has("kundenname")) return "accountable-invoices";

  let best: { kind: SourceKind; score: number } = { kind: "unknown", score: 0 };
  for (const signature of SIGNATURES) {
    const score = signatureScore(headers, signature);
    const minimum = signature.required.length * 2;
    if (score >= minimum && score > best.score) best = { kind: signature.kind, score };
  }
  return best.kind;
}

function rowsToObjects(rows: Cell[][], headerIndex: number): { headers: string[]; rows: RowObject[] } {
  const headers = rows[headerIndex].map((cell, index) => String(cell ?? "").trim() || `Spalte ${index + 1}`);
  const data = rows.slice(headerIndex + 1).map((row) => {
    const result: RowObject = {};
    headers.forEach((header, index) => {
      result[header] = row[index] ?? "";
    });
    return result;
  });
  return { headers, rows: data.filter((row) => Object.values(row).some((value) => String(value ?? "").trim())) };
}

function headerMap(headers: string[]): Map<string, string> {
  return new Map(headers.map((header) => [normalizeHeader(header), header]));
}

function value(row: RowObject, map: Map<string, string>, ...names: string[]): Cell {
  for (const name of names) {
    const normalized = normalizeHeader(name);
    const exact = map.get(normalized);
    if (exact) return row[exact];
    const partial = [...map.entries()].find(([key]) => key.includes(normalized) || normalized.includes(key));
    if (partial) return row[partial[1]];
  }
  return "";
}

function inferShop(fileName: string, rows: RowObject[], map: Map<string, string>, kind: SourceKind): string | undefined {
  const explicit = rows
    .map((row) => String(value(row, map, "Store Name") ?? "").trim())
    .find(Boolean);
  if (explicit) return explicit;

  const normalized = normalizeText(fileName);
  if (/\bfrida\b/.test(normalized)) return "Frida";
  if (/\bform\b/.test(normalized)) return "Form";
  if (normalized.includes("wandmomente")) return "Wandmomente";
  if (normalized.includes("kaparell")) return "Kaparell";
  if (kind.startsWith("etsy")) return "Etsy-Shop · bitte zuordnen";
  if (kind.startsWith("shopify")) return "Shopify-Shop · bitte zuordnen";
  return undefined;
}

function recordBase(
  source: SourceImport,
  sourceRow: number,
  category: RecordCategory,
  direction: Direction,
  amount: number,
): Pick<NormalizedRecord, "id" | "sourceId" | "sourceKind" | "sourceFile" | "sourceRow" | "shop" | "category" | "direction" | "amount" | "currency" | "counterparty" | "reference" | "relatedReferences" | "description" | "disposition" | "metadata"> {
  return {
    id: makeId(source.id, sourceRow, category, amount),
    sourceId: source.id,
    sourceKind: source.kind,
    sourceFile: source.fileName,
    sourceRow,
    shop: source.shop,
    category,
    direction,
    amount: roundMoney(Math.abs(amount)),
    currency: "EUR",
    counterparty: "",
    reference: "",
    relatedReferences: [],
    description: "",
    disposition: source.ignored ? "ignored" : "active",
    metadata: {},
  };
}

function compactMetadata(entries: Record<string, Cell>): Record<string, MetadataValue> {
  return Object.fromEntries(Object.entries(entries).map(([key, entryValue]) => [key, metadataValue(entryValue)]));
}

function parseAccountableExpenses(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Gesamtbetrag")));
    const supplier = String(value(row, map, "Name Des Lieferanten") ?? "").trim();
    const codeDescription = String(value(row, map, "Codebeschreibung") ?? "").trim();
    if (!amount && !supplier) return [];
    const isTax = normalizeText(`${supplier} ${codeDescription}`).includes("finanzamt") || normalizeText(codeDescription).includes("umsatzsteuer zahlungen");
    const base = recordBase(source, source.headerRow + index + 1, isTax ? "tax-payment" : "document-expense", "out", amount);
    const notes = value(row, map, "Tags & Notizen");
    const movement = value(row, map, "Kontobewegungen");
    const bookingCode = value(row, map, "Buchungscode");
    return [{
      ...base,
      date: parseDate(value(row, map, "Buchungsdatum")),
      amount,
      currency: String(value(row, map, "Währung") || "EUR"),
      counterparty: supplier,
      reference: String(notes || bookingCode || ""),
      relatedReferences: referenceTokens(notes, movement, bookingCode),
      description: codeDescription || supplier,
      metadata: compactMetadata({
        paymentDate: value(row, map, "Zahlungsdatum"),
        bookingCode,
        documentPresent: value(row, map, "Dokument Vorhanden"),
        paid: value(row, map, "Bezahlt"),
        vatStatus: value(row, map, "USt.-Status"),
        notes,
        movement,
      }),
    }];
  });
}

function parseAccountableInvoices(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Gesamtbetrag")));
    const customer = String(value(row, map, "Kundenname") ?? "").trim();
    if (!amount && !customer) return [];
    const invoiceType = String(value(row, map, "Rechnung Type") ?? "");
    const isCredit = normalizeText(invoiceType).includes("credit");
    const reference = String(value(row, map, "Einkommenszahl") ?? "");
    const base = recordBase(source, source.headerRow + index + 1, "document-income", isCredit ? "out" : "in", amount);
    return [{
      ...base,
      date: parseDate(value(row, map, "Rechnungsdatum")),
      dueDate: parseDate(value(row, map, "Fälligkeitsdatum")),
      amount,
      currency: String(value(row, map, "Währung") || "EUR"),
      counterparty: customer,
      reference,
      relatedReferences: referenceTokens(reference, value(row, map, "Name Des Artikels")),
      description: String(value(row, map, "Name Des Artikels") || invoiceType),
      metadata: compactMetadata({
        paymentDate: value(row, map, "Zahlungsdatum"),
        status: value(row, map, "Status"),
        invoiceType,
        vatAmount: value(row, map, "USt.-Betrag"),
      }),
    }];
  });
}

function parseFyrst(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    let signedAmount = parseAmount(value(row, map, "Betrag"));
    const debit = parseAmount(value(row, map, "Soll"));
    const credit = parseAmount(value(row, map, "Haben"));
    if (debit && !credit) signedAmount = -Math.abs(signedAmount || debit);
    if (credit && !debit) signedAmount = Math.abs(signedAmount || credit);
    const date = parseDate(value(row, map, "Buchungstag"));
    if (!date && !signedAmount) return [];
    const base = recordBase(source, source.headerRow + index + 1, "cash-movement", directionFromAmount(signedAmount), signedAmount);
    const counterparty = String(value(row, map, "Begünstigter / Auftraggeber") ?? "").trim();
    const purpose = String(value(row, map, "Verwendungszweck") ?? "").trim();
    const reference = String(value(row, map, "Kundenreferenz", "Mandatsreferenz") ?? "");
    return [{
      ...base,
      date,
      currency: String(value(row, map, "Währung") || "EUR"),
      counterparty,
      reference,
      relatedReferences: referenceTokens(reference, purpose, value(row, map, "Mandatsreferenz")),
      description: purpose || String(value(row, map, "Umsatzart") || "Bankbewegung"),
      metadata: compactMetadata({
        valueDate: value(row, map, "Wert"),
        transactionType: value(row, map, "Umsatzart"),
        iban: value(row, map, "IBAN / Kontonummer"),
      }),
    }];
  });
}

function parsePayPal(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const gross = parseAmount(value(row, map, "Brutto"));
    const net = parseAmount(value(row, map, "Netto"));
    const fee = parseAmount(value(row, map, "Entgelt"));
    const description = String(value(row, map, "Beschreibung") ?? "").trim();
    const normalizedDescription = normalizeText(description);
    if (!gross && !net && !description) return [];
    let category: RecordCategory = "cash-movement";
    if (/wahrungsumrechnung|bankgutschrift|abbuchung.*bankkonto|nutzer eingeleitete abbuchung/.test(normalizedDescription)) category = "transfer";
    if (/ruckzahlung|ruckbuchung/.test(normalizedDescription)) category = "refund";
    const signedAmount = gross || net;
    const base = recordBase(source, source.headerRow + index + 1, category, directionFromAmount(signedAmount), signedAmount);
    const transactionCode = String(value(row, map, "Transaktionscode") ?? "");
    const related = String(value(row, map, "Zugehöriger Transaktionscode") ?? "");
    return [{
      ...base,
      date: parseDate(value(row, map, "Datum")),
      settlementAmount: roundMoney(Math.abs(net)),
      feeAmount: roundMoney(Math.abs(fee)),
      currency: String(value(row, map, "Währung") || "EUR"),
      counterparty: String(value(row, map, "Name") || value(row, map, "Name der Bank") || "PayPal"),
      reference: transactionCode,
      relatedReferences: referenceTokens(transactionCode, related, value(row, map, "Rechnungsnummer")),
      description,
      metadata: compactMetadata({
        time: value(row, map, "Uhrzeit"),
        gross,
        fee,
        net,
        relatedTransaction: related,
        invoiceNumber: value(row, map, "Rechnungsnummer"),
      }),
    }];
  });
}

function parseN26(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const signedAmount = parseAmount(value(row, map, "Amount (EUR)"));
    const date = parseDate(value(row, map, "Booking Date"));
    if (!date && !signedAmount) return [];
    const base = recordBase(source, source.headerRow + index + 1, "cash-movement", directionFromAmount(signedAmount), signedAmount);
    const reference = String(value(row, map, "Payment Reference") ?? "");
    return [{
      ...base,
      date,
      currency: "EUR",
      counterparty: String(value(row, map, "Partner Name") ?? ""),
      reference,
      relatedReferences: referenceTokens(reference, value(row, map, "Partner Iban")),
      description: String(value(row, map, "Type") || reference || "N26-Bewegung"),
      metadata: compactMetadata({
        valueDate: value(row, map, "Value Date"),
        partnerIban: value(row, map, "Partner Iban"),
        originalAmount: value(row, map, "Original Amount"),
        originalCurrency: value(row, map, "Original Currency"),
        exchangeRate: value(row, map, "Exchange Rate"),
      }),
    }];
  });
}

function parseEtsySales(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const gross = Math.abs(parseAmount(value(row, map, "Gross Amount")));
    const orderId = String(value(row, map, "Order ID") ?? "");
    if (!gross && !orderId) return [];
    const fees = Math.abs(parseAmount(value(row, map, "Fees")));
    const net = Math.abs(parseAmount(value(row, map, "Net Amount")));
    const paymentId = String(value(row, map, "Payment ID") ?? "");
    const base = recordBase(source, source.headerRow + index + 1, "order", "in", gross);
    return [{
      ...base,
      date: parseDate(value(row, map, "Order Date")),
      settlementAmount: net,
      feeAmount: fees,
      currency: String(value(row, map, "Currency") || "EUR"),
      counterparty: String(value(row, map, "Buyer Name") || value(row, map, "Buyer") || ""),
      reference: orderId,
      relatedReferences: referenceTokens(orderId, paymentId),
      description: `Etsy-Bestellung ${orderId}`,
      metadata: compactMetadata({ paymentId, status: value(row, map, "Status"), refundAmount: value(row, map, "Refund Amount") }),
    }];
  });
}

function parseEtsyTransfers(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Amount")));
    const date = parseDate(value(row, map, "Date"));
    if (!amount && !date) return [];
    const status = String(value(row, map, "Status") ?? "");
    const base = recordBase(source, source.headerRow + index + 1, "payout", "in", amount);
    const returned = normalizeText(status).includes("returned");
    return [{
      ...base,
      date,
      currency: String(value(row, map, "Currency") || "EUR"),
      counterparty: "Etsy",
      reference: String(value(row, map, "Bank Account Ending Digits") ?? ""),
      relatedReferences: referenceTokens(status, value(row, map, "Bank Account Ending Digits")),
      description: `Etsy-Auszahlung · ${status}`,
      disposition: returned ? "ignored" : "active",
      dispositionReason: returned ? "Zurückgegebene Auszahlung" : undefined,
      metadata: compactMetadata({ status }),
    }];
  });
}

function parseEtsyStatement(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const type = String(value(row, map, "Art") ?? "");
    const normalizedType = normalizeText(type);
    const gross = parseAmount(value(row, map, "Betrag"));
    const fee = parseAmount(value(row, map, "Gebühren & Steuern"));
    const net = parseAmount(value(row, map, "Netto"));
    if (!type && !gross && !net) return [];
    let category: RecordCategory = "unknown";
    let direction: Direction = directionFromAmount(net || gross);
    if (normalizedType === "sale") { category = "sale"; direction = "in"; }
    else if (/fee|marketing|tax|buyer fee/.test(normalizedType)) { category = "fee"; direction = "out"; }
    else if (normalizedType.includes("refund")) { category = "refund"; direction = "out"; }
    else if (normalizedType.includes("uberweisung")) { category = "payout"; direction = "in"; }
    else if (normalizedType.includes("zahlung")) { category = "transfer"; }
    const amount = Math.abs(gross || net);
    const base = recordBase(source, source.headerRow + index + 1, category, direction, amount);
    const info = String(value(row, map, "Info") ?? "");
    const title = String(value(row, map, "Titel") ?? "");
    return [{
      ...base,
      date: parseDate(value(row, map, "Datum")),
      settlementAmount: Math.abs(net),
      feeAmount: Math.abs(fee),
      currency: String(value(row, map, "Währung") || "EUR"),
      counterparty: "Etsy",
      reference: info,
      relatedReferences: referenceTokens(info, title),
      description: `${type} · ${title || info}`,
      metadata: compactMetadata({ type, title, info, gross, fee, net, taxInfo: value(row, map, "Steuerliche Angaben") }),
    }];
  });
}

function parseEbayOrders(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const orderId = String(value(row, map, "Bestellnummer") ?? "");
    const amount = Math.abs(parseAmount(value(row, map, "Gesamtbetrag inkl. der von eBay eingezogenen Steuer und Gebühren", "Gesamtbetrag")));
    if (!orderId && !amount) return [];
    const base = recordBase(source, source.headerRow + index + 1, "order", "in", amount);
    return [{
      ...base,
      date: parseDate(value(row, map, "Zahlungsdatum", "Verkauft am")),
      currency: "EUR",
      counterparty: String(value(row, map, "Name des Käufers") ?? ""),
      reference: orderId,
      relatedReferences: referenceTokens(orderId, value(row, map, "Transaktionsnummer"), value(row, map, "PayPal-Transaktionsnummer")),
      description: String(value(row, map, "Angebotstitel") || `eBay-Bestellung ${orderId}`),
      metadata: compactMetadata({ soldAt: value(row, map, "Verkauft am"), quantity: value(row, map, "Anzahl") }),
    }];
  });
}

function parseEbayLedger(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const type = String(value(row, map, "Typ") ?? "");
    const normalizedType = normalizeText(type);
    let category: RecordCategory = "unknown";
    let direction: Direction = "neutral";
    if (normalizedType === "bestellung") { category = "sale"; direction = "in"; }
    else if (normalizedType === "auszahlung") { category = "payout"; direction = "in"; }
    else if (normalizedType.includes("ruckerstattung")) { category = "refund"; direction = "out"; }
    else if (normalizedType.includes("gebuhr") || normalizedType === "belastung") { category = "fee"; direction = "out"; }
    const gross = parseAmount(value(row, map, "Transaktionsbetrag (inkl. Kosten)"));
    const settlement = parseAmount(value(row, map, "Betrag abzügl. Kosten"));
    const amount = Math.abs(category === "payout" ? settlement : gross || settlement);
    const orderId = String(value(row, map, "Bestellnummer") ?? "");
    const payoutId = String(value(row, map, "Auszahlung Nr.") ?? "");
    if (!type && !amount) return [];
    const base = recordBase(source, source.headerRow + index + 1, category, direction, amount);
    return [{
      ...base,
      date: parseDate(category === "payout" ? value(row, map, "Auszahlungsdatum") : value(row, map, "Datum der Transaktionserstellung")),
      settlementAmount: Math.abs(settlement),
      currency: String(value(row, map, "Transaktionswährung", "Auszahlungswährung") || "EUR"),
      counterparty: category === "payout" ? "eBay" : String(value(row, map, "Name des Käufers") || "eBay"),
      reference: payoutId || orderId || String(value(row, map, "Referenznummer") || ""),
      relatedReferences: referenceTokens(orderId, payoutId, value(row, map, "Transaktionsnummer"), value(row, map, "Referenznummer")),
      description: String(value(row, map, "Beschreibung") || type),
      metadata: compactMetadata({ type, orderId, payoutId, payoutStatus: value(row, map, "Auszahlungsstatus") }),
    }];
  });
}

function mergeGroupRows(rows: RowObject[], map: Map<string, string>): RowObject {
  const merged: RowObject = {};
  for (const header of map.values()) {
    merged[header] = rows.map((row) => row[header]).find((entry) => String(entry ?? "").trim()) ?? "";
  }
  return merged;
}

function parseShopifyOrders(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  const groups = new Map<string, RowObject[]>();
  for (const row of rows) {
    const orderId = String(value(row, map, "Name") ?? "").trim();
    if (!orderId) continue;
    groups.set(orderId, [...(groups.get(orderId) ?? []), row]);
  }
  return [...groups.entries()].map(([orderId, group], index) => {
    const row = mergeGroupRows(group, map);
    const amount = Math.abs(parseAmount(value(row, map, "Total")));
    const base = recordBase(source, source.headerRow + index + 1, "order", "in", amount);
    const customer = String(value(row, map, "Billing Name") || value(row, map, "Shipping Name") || "");
    const zeroOrder = amount === 0;
    const paymentReference = String(value(row, map, "Payment Reference", "Payment ID") ?? "");
    return {
      ...base,
      date: parseDate(value(row, map, "Paid at", "Created at")),
      currency: String(value(row, map, "Currency") || "EUR"),
      counterparty: customer,
      reference: orderId,
      relatedReferences: referenceTokens(orderId, paymentReference, value(row, map, "Payment References")),
      description: `Shopify-Bestellung ${orderId}`,
      disposition: zeroOrder ? "test" : "active",
      dispositionReason: zeroOrder ? "0-Euro-Testbestellung" : undefined,
      metadata: compactMetadata({
        customerKey: normalizeText(customer),
        paymentMethod: value(row, map, "Payment Method"),
        paymentReference,
        financialStatus: value(row, map, "Financial Status"),
        createdAt: value(row, map, "Created at"),
        lineCount: group.length,
      }),
    };
  });
}

function parseShopifyBilling(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Amount")));
    const bill = String(value(row, map, "Bill #") ?? "");
    if (!amount && !bill) return [];
    const base = recordBase(source, source.headerRow + index + 1, "fee", "out", amount);
    const shop = String(value(row, map, "Store Name") || source.shop || "Shopify");
    return [{
      ...base,
      shop,
      date: parseDate(value(row, map, "Date")),
      currency: String(value(row, map, "Currency") || "EUR"),
      counterparty: "Shopify",
      reference: bill,
      relatedReferences: referenceTokens(bill, value(row, map, "Order")),
      description: String(value(row, map, "Description") || value(row, map, "Charge category") || "Shopify-Gebühr"),
      metadata: compactMetadata({ chargeCategory: value(row, map, "Charge category"), app: value(row, map, "App"), shop }),
    }];
  });
}

function parsePrintfulOrders(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Gesamtsumme")));
    const printfulId = String(value(row, map, "Printful-ID") ?? "");
    const date = parseDate(value(row, map, "Datum"));
    if (!date && !printfulId) return [];
    const status = String(value(row, map, "Status") ?? "");
    const refunded = normalizeText(status).includes("erstattet");
    const base = recordBase(source, source.headerRow + index + 1, refunded ? "refund" : "wallet-charge", refunded ? "in" : "out", amount);
    return [{
      ...base,
      date,
      currency: "EUR",
      counterparty: "Printful",
      reference: printfulId,
      relatedReferences: referenceTokens(printfulId, value(row, map, "Bestellung")),
      description: `Printful-Bestellung ${String(value(row, map, "Bestellung") || printfulId)}`,
      metadata: compactMetadata({ status, paymentInstrument: value(row, map, "Zahlungsinstrument"), products: value(row, map, "Produkte") }),
    }];
  });
}

function parsePrintfulWallet(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Betrag")));
    const date = parseDate(value(row, map, "Datum"));
    if (!date) return [];
    const action = String(value(row, map, "Aktion") ?? "");
    const base = recordBase(source, source.headerRow + index + 1, "wallet-funding", "out", amount);
    return [{
      ...base,
      date,
      currency: "EUR",
      counterparty: "Printful",
      reference: String(value(row, map, "Zahlungsinstrument") ?? ""),
      relatedReferences: referenceTokens(action, value(row, map, "Zahlungsinstrument")),
      description: action || "Printful-Geldbörse",
      metadata: compactMetadata({ action, paymentInstrument: value(row, map, "Zahlungsinstrument") }),
    }];
  });
}

function parseGelato(source: SourceImport, rows: RowObject[], map: Map<string, string>): NormalizedRecord[] {
  return rows.flatMap((row, index) => {
    const amount = Math.abs(parseAmount(value(row, map, "Total Charge")));
    const reference = String(value(row, map, "Reference ID") ?? "");
    if (!amount && !reference) return [];
    const base = recordBase(source, source.headerRow + index + 1, "wallet-charge", "out", amount);
    return [{
      ...base,
      date: parseDate(value(row, map, "Date")),
      currency: String(value(row, map, "Currency") || "EUR"),
      counterparty: "Gelato",
      reference,
      relatedReferences: referenceTokens(reference),
      description: `Gelato-Auftrag ${reference}`,
      metadata: compactMetadata({ productCharge: value(row, map, "Product Charge"), shippingCharge: value(row, map, "Shipping Charge"), vatCharge: value(row, map, "VAT Charge") }),
    }];
  });
}

function parseRecords(source: SourceImport, rows: RowObject[], headers: string[]): NormalizedRecord[] {
  const map = headerMap(headers);
  switch (source.kind) {
    case "accountable-expenses": return parseAccountableExpenses(source, rows, map);
    case "accountable-invoices": return parseAccountableInvoices(source, rows, map);
    case "bank-fyrst": return parseFyrst(source, rows, map);
    case "paypal-business": return parsePayPal(source, rows, map);
    case "bank-n26": return parseN26(source, rows, map);
    case "bank-dkb-ignored": return [];
    case "etsy-sales": return parseEtsySales(source, rows, map);
    case "etsy-transfers": return parseEtsyTransfers(source, rows, map);
    case "etsy-statement": return parseEtsyStatement(source, rows, map);
    case "ebay-orders": return parseEbayOrders(source, rows, map);
    case "ebay-ledger": return parseEbayLedger(source, rows, map);
    case "shopify-orders": return parseShopifyOrders(source, rows, map);
    case "shopify-billing": return parseShopifyBilling(source, rows, map);
    case "printful-orders": return parsePrintfulOrders(source, rows, map);
    case "printful-wallet": return parsePrintfulWallet(source, rows, map);
    case "gelato": return parseGelato(source, rows, map);
    case "unknown": return [];
  }
}

function sourceWarnings(kind: SourceKind, records: NormalizedRecord[]): string[] {
  const warnings: string[] = [];
  if (kind === "unknown") warnings.push("Dateistruktur wurde nicht erkannt.");
  if (kind === "bank-dkb-ignored") warnings.push("DKB ist nach Projektvorgabe vollständig ausgeschlossen.");
  if (!records.length && kind !== "bank-dkb-ignored" && kind !== "unknown") warnings.push("Keine verwertbaren Datensätze erkannt.");
  if (records.some((record) => !record.date)) warnings.push("Einzelne Datensätze haben kein erkennbares Datum.");
  return warnings;
}

function buildSource(file: File, table: TableData, headers: string[], headerIndex: number, kind: SourceKind, shop?: string): SourceImport {
  const fingerprint = makeId(kind, ...headers.map(normalizeHeader).sort());
  return {
    id: makeId(file.name, file.size, table.sheetName, fingerprint),
    fileName: file.name,
    fileSize: file.size,
    fingerprint,
    kind,
    label: SOURCE_LABELS[kind],
    shop,
    sheetName: table.sheetName,
    headerRow: headerIndex + 1,
    rowCount: 0,
    warnings: [],
    ignored: kind === "bank-dkb-ignored" || kind === "unknown",
  };
}

async function fileTables(file: File): Promise<TableData[]> {
  const buffer = await file.arrayBuffer();
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    return workbook.SheetNames.map((sheetName) => ({
      sheetName,
      rows: XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
        raw: false,
      }),
    }));
  }
  return [{ rows: parseCsv(buffer) }];
}

export async function parseImportFile(file: File): Promise<ParsedFileResult> {
  const sources: SourceImport[] = [];
  const records: NormalizedRecord[] = [];
  for (const table of await fileTables(file)) {
    if (!table.rows.length) continue;
    const headerIndex = findHeaderIndex(table.rows);
    const { headers, rows } = rowsToObjects(table.rows, headerIndex);
    const kind = detectSourceKind(headers, table.sheetName);
    if (/\.xlsx?$/i.test(file.name) && !kind.startsWith("accountable")) continue;
    const map = headerMap(headers);
    const shop = inferShop(file.name, rows, map, kind);
    const source = buildSource(file, table, headers, headerIndex, kind, shop);
    const parsedRecords = parseRecords(source, rows, headers);
    const dated = parsedRecords.map((record) => record.date).filter((date): date is string => Boolean(date)).sort();
    source.rowCount = parsedRecords.length || rows.length;
    source.dateMin = dated[0];
    source.dateMax = dated.at(-1);
    source.warnings = sourceWarnings(kind, parsedRecords);
    sources.push(source);
    records.push(...parsedRecords);
  }
  return { sources, records };
}

export function applyShopifyAllowList(records: NormalizedRecord[], shop: string, genuineCustomers: string[]): NormalizedRecord[] {
  const allowed = new Set(genuineCustomers.map(normalizeText));
  return records.map((record) => {
    if (record.sourceKind !== "shopify-orders" || normalizeText(record.shop) !== normalizeText(shop) || record.amount === 0) return record;
    const genuine = allowed.has(normalizeText(record.counterparty));
    return {
      ...record,
      disposition: genuine ? "active" : "test",
      dispositionReason: genuine ? undefined : "Vom Nutzer als Testbestellung klassifiziert",
    };
  });
}
