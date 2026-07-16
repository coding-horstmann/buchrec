import type {
  CoverageSummary,
  MatchCandidate,
  MatchLink,
  MatchResult,
  NormalizedRecord,
  ReconciliationAxes,
  RecordCategory,
  RecordReview,
} from "../types";
import { dateDifferenceDays, makeId, normalizeText, referenceTokens, roundMoney } from "./normalize";

const DOCUMENT_CATEGORIES = new Set<RecordCategory>(["document-expense", "document-income", "tax-payment"]);
const ORDER_CATEGORIES = new Set<RecordCategory>(["order", "order-detail", "sale"]);
const CASH_CATEGORIES = new Set<RecordCategory>(["cash-movement", "transfer"]);
const PAYMENT_EVIDENCE_CATEGORIES = new Set<RecordCategory>([
  "cash-movement",
  "transfer",
  "wallet-charge",
  "wallet-funding",
  "buyer-fee",
  "fee",
  "refund",
]);
const BANK_SOURCES = new Set(["bank-fyrst", "bank-n26"]);
const PLATFORM_SOURCES = new Set([
  "etsy-sales",
  "etsy-sold-orders",
  "etsy-transfers",
  "etsy-statement",
  "ebay-orders",
  "ebay-ledger",
  "shopify-orders",
  "shopify-billing",
]);
const LEGAL_AND_GENERIC_TOKENS = new Set([
  "ab",
  "ag",
  "and",
  "bhd",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "group",
  "inc",
  "limited",
  "llc",
  "ltd",
  "oy",
  "sarl",
  "the",
]);

const PARTY_ALIASES: Array<{ canonical: string; patterns: string[] }> = [
  { canonical: "art heroes", patterns: ["art heroes", "werk aan de muur", "we make it work"] },
  { canonical: "printler", patterns: ["printler"] },
  { canonical: "redbubble", patterns: ["redbubble"] },
  { canonical: "europosters", patterns: ["europosters"] },
  { canonical: "gelato", patterns: ["gelato"] },
  { canonical: "printful", patterns: ["printful"] },
  { canonical: "albin michel", patterns: ["albin michel", "editions albin michel"] },
];

function canonicalParty(value: string): string {
  const normalized = normalizeText(value);
  return PARTY_ALIASES.find((entry) => entry.patterns.some((pattern) => normalized.includes(pattern)))?.canonical ?? normalized;
}

function recordDates(record: NormalizedRecord): string[] {
  return [record.date, record.paymentDate, record.dueDate].filter((date): date is string => Boolean(date));
}

function reconciliationDateDifference(left: NormalizedRecord, right: NormalizedRecord): number | undefined {
  const differences = recordDates(left).flatMap((leftDate) =>
    recordDates(right).map((rightDate) => dateDifferenceDays(leftDate, rightDate)).filter((days): days is number => typeof days === "number"),
  );
  return differences.length ? Math.min(...differences) : undefined;
}

function isBank(record: NormalizedRecord): boolean {
  return BANK_SOURCES.has(record.sourceKind);
}

function isPayPal(record: NormalizedRecord): boolean {
  return record.sourceKind === "paypal-business";
}

export function isReconciliationRecord(record: NormalizedRecord): boolean {
  const excluded = record.disposition === "ignored" || record.disposition === "private" || record.disposition === "test";
  if (excluded) return false;
  if (DOCUMENT_CATEGORIES.has(record.category) || record.category === "order") return true;
  return isBank(record) && record.category !== "unknown";
}

function active(record: NormalizedRecord): boolean {
  return record.disposition === "active" || record.disposition === "resolved";
}

function amountVariants(record: NormalizedRecord): number[] {
  return Array.from(
    new Set(
      [record.amount, record.settlementAmount]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        .map((value) => roundMoney(Math.abs(value))),
    ),
  );
}

function closestAmountDifference(left: NormalizedRecord, right: NormalizedRecord): number {
  return Math.min(
    ...amountVariants(left).flatMap((leftAmount) =>
      amountVariants(right).map((rightAmount) => roundMoney(Math.abs(leftAmount - rightAmount))),
    ),
  );
}

const tokenCache = new Map<string, Set<string>>();
const counterpartyCache = new Map<string, Set<string>>();

function tokens(record: NormalizedRecord): Set<string> {
  const cached = tokenCache.get(record.id);
  if (cached) return cached;
  const result = new Set([
    ...record.relatedReferences,
    ...referenceTokens(record.reference, record.metadata.invoiceNumber),
  ]);
  tokenCache.set(record.id, result);
  return result;
}

function normalizedNameTokens(value: string): Set<string> {
  return new Set(
    canonicalParty(value)
      .split(/\W+/)
      .filter((token) => token.length > 1 && !LEGAL_AND_GENERIC_TOKENS.has(token)),
  );
}

function counterpartyTokens(record: NormalizedRecord): Set<string> {
  const cached = counterpartyCache.get(record.id);
  if (cached) return cached;
  const result = new Set<string>();
  for (const value of [
    record.counterparty,
    record.metadata.buyer,
    record.metadata.buyerUserId,
    record.metadata.shippingCompany,
  ]) {
    for (const token of normalizedNameTokens(String(value ?? ""))) result.add(token);
  }
  counterpartyCache.set(record.id, result);
  return result;
}

function tokenSetSimilarity(leftTokens: Set<string>, rightTokens: Set<string>): number {
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (intersection >= 2) return 1;
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function counterpartySimilarity(left: NormalizedRecord, right: NormalizedRecord): number {
  return tokenSetSimilarity(counterpartyTokens(left), counterpartyTokens(right));
}

function sharedReference(left: NormalizedRecord, right: NormalizedRecord): string | undefined {
  const rightTokens = tokens(right);
  return [...tokens(left)].find((token) => rightTokens.has(token));
}

function pairKey(left: string, right: string, type: string): string {
  return [left, right].sort().join("|") + `|${type}`;
}

function makeLink(
  from: NormalizedRecord,
  to: NormalizedRecord,
  type: MatchLink["type"],
  confidence: number,
  rule: string,
  reason: string,
  automatic: boolean,
): MatchLink {
  return {
    id: makeId(pairKey(from.id, to.id, type), rule),
    fromId: from.id,
    toId: to.id,
    type,
    confidence: Math.min(100, Math.max(0, Math.round(confidence))),
    amountDifference: closestAmountDifference(from, to),
    dateDifference: reconciliationDateDifference(from, to),
    rule,
    reason,
    automatic,
  };
}

function makeReview(
  record: NormalizedRecord,
  status: RecordReview["status"],
  note: string,
  code: string,
): RecordReview {
  const timestamp = new Date().toISOString();
  return {
    id: makeId(record.id, status, code),
    recordId: record.id,
    status,
    note,
    automatic: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function etsyDocumentReviewLinks(records: NormalizedRecord[]): {
  links: MatchLink[];
  reviews: RecordReview[];
} {
  const documents = records.filter(
    (record) => active(record) && record.category === "document-income",
  );
  const orders = records.filter(
    (record) =>
      active(record) &&
      record.sourceKind === "etsy-sales" &&
      record.category === "order" &&
      record.metadata.fullyRefunded !== true,
  );
  const detailsByOrder = new Map<string, NormalizedRecord[]>();
  for (const detail of records.filter(
    (record) => active(record) && record.sourceKind === "etsy-sold-orders" && record.category === "order-detail",
  )) {
    const key = `${normalizeText(detail.shop)}|${detail.reference}`;
    detailsByOrder.set(key, [...(detailsByOrder.get(key) ?? []), detail]);
  }
  const buyerFeesByOrder = new Map<string, number>();
  for (const buyerFee of records.filter(
    (record) => active(record) && record.sourceKind === "etsy-statement" && record.category === "buyer-fee",
  )) {
    const key = `${normalizeText(buyerFee.shop)}|${buyerFee.reference}`;
    const signed = buyerFee.direction === "in" ? -buyerFee.amount : buyerFee.amount;
    buyerFeesByOrder.set(key, roundMoney((buyerFeesByOrder.get(key) ?? 0) + signed));
  }

  const links: MatchLink[] = [];
  const reviews: RecordReview[] = [];
  const usedOrders = new Set<string>();
  for (const document of documents) {
    const possible = orders
      .map((order) => {
        const details = detailsByOrder.get(`${normalizeText(order.shop)}|${order.reference}`) ?? [];
        const similarity = Math.max(
          counterpartySimilarity(document, order),
          ...details.map((detail) => counterpartySimilarity(document, detail)),
        );
        const days = reconciliationDateDifference(document, order);
        const listingAmount = Number(order.metadata.listingAmount);
        const buyerFee = buyerFeesByOrder.get(`${normalizeText(order.shop)}|${order.reference}`) ?? 0;
        const detailedSellerAmount = details.length === 1 ? details[0].amount : undefined;
        const sellerAmount = detailedSellerAmount ?? roundMoney(order.amount - buyerFee);
        const sellerMatch = Math.abs(document.amount - sellerAmount) <= 0.02;
        const buyerFeeMatch = buyerFee > 0.02 && Math.abs(document.amount - order.amount) <= 0.02;
        const buyerTotalMatch = Number.isFinite(listingAmount) && Math.abs(document.amount - listingAmount) <= 0.02;
        const zeroInvoice = document.amount === 0 && sellerAmount > 0;
        if (similarity < 1 || (days !== undefined && days > 20) || (!sellerMatch && !buyerFeeMatch && !buyerTotalMatch && !zeroInvoice)) return undefined;
        return {
          order,
          days: days ?? 0,
          listingAmount,
          sellerAmount,
          sellerMatch,
          buyerFee,
          buyerFeeMatch,
          buyerTotalMatch,
          zeroInvoice,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => left.days - right.days || left.order.sourceRow - right.order.sourceRow);
    if (possible.length !== 1 || usedOrders.has(possible[0].order.id)) continue;
    const match = possible[0];
    usedOrders.add(match.order.id);
    const taxDifference = roundMoney(match.listingAmount - match.sellerAmount - match.buyerFee);

    if (match.zeroInvoice) {
      links.push(makeLink(
        document,
        match.order,
        "document-order",
        100,
        "etsy-zero-invoice-data-error",
        `Etsy-Bestellung ${match.order.reference} identifiziert; Accountable-Beleg hat 0,00 EUR`,
        true,
      ));
      reviews.push(makeReview(
        document,
        "data-error",
        `Accountable enthält 0,00 EUR, Etsy weist für Bestellung ${match.order.reference} ${match.sellerAmount.toFixed(2)} EUR Verkäuferumsatz aus.`,
        "etsy-zero-invoice",
      ));
    } else if (match.buyerFeeMatch) {
      links.push(makeLink(
        document,
        match.order,
        "document-order",
        100,
        "etsy-buyer-fee-warning",
        `Beleg enthält ${match.buyerFee.toFixed(2)} EUR von Etsy erhobene Buyer Fee`,
        true,
      ));
      reviews.push(makeReview(
        document,
        "warning",
        `Zugeordnet mit Warnung: Der Accountable-Beleg enthält ${match.buyerFee.toFixed(2)} EUR von Etsy erhobene Buyer Fee.`,
        "etsy-buyer-fee-invoice",
      ));
    } else if (match.buyerTotalMatch && taxDifference + match.buyerFee > 0.02) {
      links.push(makeLink(
        document,
        match.order,
        "document-order",
        100,
        "etsy-buyer-total-sales-tax-warning",
        `Beleg entspricht Käufergesamtbetrag; ${taxDifference.toFixed(2)} EUR Marketplace Sales Tax und ${match.buyerFee.toFixed(2)} EUR Buyer Fees sind nicht Verkäuferumsatz`,
        true,
      ));
      reviews.push(makeReview(
        document,
        "warning",
        `Zugeordnet mit Warnung: Der Accountable-Beleg enthält ${taxDifference.toFixed(2)} EUR Marketplace Sales Tax und ${match.buyerFee.toFixed(2)} EUR Buyer Fees.`,
        "etsy-sales-tax-invoice",
      ));
    } else {
      links.push(makeLink(
        document,
        match.order,
        "document-order",
        100,
        "etsy-related-party-exact",
        `Etsy-Bestellung ${match.order.reference} über Käufer-, Empfänger- oder Firmenidentität centgenau zugeordnet`,
        true,
      ));
    }
  }
  return { links, reviews };
}

function fullyRefundedEtsyInvoiceReviews(records: NormalizedRecord[]): RecordReview[] {
  const refundedOrders = records.filter(
    (record) =>
      active(record) &&
      record.sourceKind === "etsy-sales" &&
      record.category === "order" &&
      record.metadata.fullyRefunded === true,
  );
  const invoices = records.filter(
    (record) => active(record) && record.category === "document-income" && record.direction === "in",
  );
  const creditNotes = records.filter(
    (record) => active(record) && record.category === "document-income" && record.direction === "out",
  );
  const reviews: RecordReview[] = [];
  for (const order of refundedOrders) {
    const matchingInvoices = invoices.filter((document) => {
      const days = reconciliationDateDifference(document, order);
      return counterpartySimilarity(document, order) >= 1 &&
        closestAmountDifference(document, order) <= 0.02 &&
        (days === undefined || days <= 90);
    });
    if (matchingInvoices.length !== 1) continue;
    const invoice = matchingInvoices[0];
    const hasCreditNote = creditNotes.some((creditNote) => {
      const days = reconciliationDateDifference(invoice, creditNote);
      return counterpartySimilarity(invoice, creditNote) >= 1 &&
        closestAmountDifference(invoice, creditNote) <= 0.02 &&
        (days === undefined || days <= 180);
    });
    if (!hasCreditNote) {
      reviews.push(makeReview(
        invoice,
        "warning",
        `Etsy-Bestellung ${order.reference} wurde vollständig erstattet, im Accountable-Export ist aber keine passende Stornorechnung erkennbar.`,
        "etsy-full-refund-without-credit-note",
      ));
    }
  }
  return reviews;
}

function paypalRelatedLinks(records: NormalizedRecord[]): MatchLink[] {
  const paypal = records.filter((record) => active(record) && isPayPal(record));
  const byReference = new Map(paypal.map((record) => [record.reference, record]));
  const links: MatchLink[] = [];
  for (const record of paypal) {
    const relatedReference = String(record.metadata.relatedTransaction ?? "").trim();
    const related = byReference.get(relatedReference);
    if (!related || related.id === record.id) continue;
    links.push(
      makeLink(
        record,
        related,
        "paypal-related",
        100,
        "paypal-related-transaction",
        `PayPal-Verknüpfung über Transaktionscode ${relatedReference}`,
        true,
      ),
    );
  }
  return links;
}

function paypalBalanceLinks(records: NormalizedRecord[]): MatchLink[] {
  const paypal = records.filter((record) => active(record) && isPayPal(record) && record.direction !== "neutral");
  const possible: Array<{ left: NormalizedRecord; right: NormalizedRecord; days: number }> = [];
  for (let leftIndex = 0; leftIndex < paypal.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paypal.length; rightIndex += 1) {
      const left = paypal[leftIndex];
      const right = paypal[rightIndex];
      if (left.direction === right.direction || closestAmountDifference(left, right) > 0.02) continue;
      if (left.category !== "transfer" && right.category !== "transfer") continue;
      const days = dateDifferenceDays(left.date, right.date) ?? 0;
      if (days > 5) continue;
      possible.push({ left, right, days });
    }
  }
  const byRecord = new Map<string, typeof possible>();
  for (const candidate of possible) {
    byRecord.set(candidate.left.id, [...(byRecord.get(candidate.left.id) ?? []), candidate]);
    byRecord.set(candidate.right.id, [...(byRecord.get(candidate.right.id) ?? []), candidate]);
  }
  const uniqueClosest = (recordId: string) => {
    const sorted = [...(byRecord.get(recordId) ?? [])].sort((left, right) => left.days - right.days);
    return sorted.length && (!sorted[1] || sorted[0].days < sorted[1].days) ? sorted[0] : undefined;
  };
  return possible
    .filter((candidate) => uniqueClosest(candidate.left.id) === candidate && uniqueClosest(candidate.right.id) === candidate)
    .map((candidate) =>
      makeLink(
        candidate.left,
        candidate.right,
        "paypal-related",
        97,
        "paypal-balance-movement",
        "PayPal-Händlerbewegung und zugehörige Kontobewegung centgenau",
        true,
      ),
    );
}

function signedPayPalAmount(record: NormalizedRecord): number {
  const net = Number(record.metadata.net);
  if (Number.isFinite(net)) return roundMoney(net);
  const gross = Number(record.metadata.gross);
  if (Number.isFinite(gross)) return roundMoney(gross);
  if (record.direction === "in") return record.amount;
  if (record.direction === "out") return -record.amount;
  return 0;
}

function paypalChronological(records: NormalizedRecord[]): NormalizedRecord[] {
  return [...records].sort(
    (left, right) =>
      (left.date ?? "").localeCompare(right.date ?? "") ||
      String(left.metadata.time ?? "").localeCompare(String(right.metadata.time ?? "")) ||
      left.sourceRow - right.sourceRow,
  );
}

export function paypalBalancedCurrencies(records: NormalizedRecord[]): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const currencies = new Set(records.filter(isPayPal).map((record) => record.currency));
  for (const currency of currencies) {
    const rows = paypalChronological(
      records.filter((record) => active(record) && isPayPal(record) && record.currency === currency),
    );
    let previousBalance: number | undefined;
    let valid = rows.length > 0;
    for (const record of rows) {
      const balance = Number(record.metadata.balance);
      if (!Number.isFinite(balance)) {
        valid = false;
        continue;
      }
      if (previousBalance !== undefined) {
        const expected = roundMoney(previousBalance + signedPayPalAmount(record));
        if (Math.abs(expected - balance) > 0.02) valid = false;
      }
      previousBalance = balance;
    }
    result.set(currency, valid);
  }
  return result;
}

function paypalBalanceBatchLinks(records: NormalizedRecord[]): MatchLink[] {
  const links: MatchLink[] = [];
  const currencies = new Set(records.filter(isPayPal).map((record) => record.currency));
  for (const currency of currencies) {
    const rows = paypalChronological(
      records.filter((record) => active(record) && isPayPal(record) && record.currency === currency),
    );
    let segment: NormalizedRecord[] = [];
    for (const record of rows) {
      segment.push(record);
      const balance = Number(record.metadata.balance);
      if (!Number.isFinite(balance) || Math.abs(balance) > 0.02) continue;
      const normalizedDescription = normalizeText(record.description);
      const withdrawal =
        record.direction === "out" &&
        record.category === "transfer" &&
        (normalizedDescription.includes("abbuchung") || normalizedDescription.includes("bankkonto"));
      if (withdrawal && segment.length > 1) {
        const members = segment.filter((member) => member.id !== record.id && member.category !== "transfer");
        for (const member of members) {
          links.push(
            makeLink(
              member,
              record,
              "account-batch",
              100,
              "paypal-running-balance-batch",
              `${members.length} PayPal-Bewegung${members.length === 1 ? "" : "en"} ergeben die Sammelabbuchung ${record.amount.toFixed(2)} ${currency}`,
              true,
            ),
          );
        }
      }
      segment = [];
    }
  }
  return links;
}

function adjacencyFromLinks(links: MatchLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links.filter((entry) => !entry.rejected)) {
    adjacency.set(link.fromId, new Set([...(adjacency.get(link.fromId) ?? []), link.toId]));
    adjacency.set(link.toId, new Set([...(adjacency.get(link.toId) ?? []), link.fromId]));
  }
  return adjacency;
}

function connectedIds(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      queue.push(neighbor);
    }
  }
  return seen;
}

function paypalContext(records: NormalizedRecord[], relatedLinks: MatchLink[]): Map<string, NormalizedRecord[]> {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const adjacency = adjacencyFromLinks(relatedLinks);
  const context = new Map<string, NormalizedRecord[]>();
  for (const record of records.filter(isPayPal)) {
    context.set(
      record.id,
      [...connectedIds(record.id, adjacency)]
        .map((id) => recordMap.get(id))
        .filter((entry): entry is NormalizedRecord => Boolean(entry)),
    );
  }
  return context;
}

function effectiveCounterpartySimilarity(
  document: NormalizedRecord,
  target: NormalizedRecord,
  paypalContexts: Map<string, NormalizedRecord[]>,
): { similarity: number; viaPayPal: boolean } {
  const direct = counterpartySimilarity(document, target);
  const related = paypalContexts.get(target.id) ?? [];
  const contextual = related.reduce((best, record) => Math.max(best, counterpartySimilarity(document, record)), 0);
  return { similarity: Math.max(direct, contextual), viaPayPal: contextual > direct };
}

function compatibleDocumentTarget(document: NormalizedRecord, target: NormalizedRecord): boolean {
  if (!active(target) || document.sourceId === target.sourceId || document.direction !== target.direction) return false;
  if (document.category === "document-income") return ORDER_CATEGORIES.has(target.category) || CASH_CATEGORIES.has(target.category);
  if (target.category === "wallet-charge") return false;
  return PAYMENT_EVIDENCE_CATEGORIES.has(target.category);
}

interface ScoredPair {
  score: number;
  reason: string[];
  target: NormalizedRecord;
  reference?: string;
  difference: number;
  days?: number;
}

function scoreDocumentTarget(
  document: NormalizedRecord,
  target: NormalizedRecord,
  dateTolerance: number,
  amountTolerance: number,
  paypalContexts: Map<string, NormalizedRecord[]>,
): ScoredPair | undefined {
  if (!compatibleDocumentTarget(document, target)) return undefined;
  const difference = closestAmountDifference(document, target);
  const days = reconciliationDateDifference(document, target);
  const reference = sharedReference(document, target);
  const { similarity: nameSimilarity, viaPayPal } = effectiveCounterpartySimilarity(document, target, paypalContexts);
  const reason: string[] = [];
  let score = 0;

  if (reference) {
    score += 70;
    reason.push(`gemeinsame Referenz ${reference}`);
  }

  if (difference <= 0.01) {
    score += 45;
    reason.push("Betrag centgenau");
  } else if (difference <= amountTolerance) {
    score += 40;
    reason.push(`Betrag innerhalb der Toleranz (${difference.toFixed(2)} €)`);
  } else if (difference <= 0.05) {
    score += 40;
    reason.push("Betrag praktisch identisch");
  } else if (difference <= 1) {
    score += 24;
    reason.push(`Betragsabweichung ${difference.toFixed(2)} €`);
  } else if (difference <= 5 && (reference || nameSimilarity >= 0.5)) {
    score += 10;
    reason.push(`erklärungsbedürftige Abweichung ${difference.toFixed(2)} €`);
  } else if (!reference) {
    return undefined;
  }

  if (typeof days === "number" && days <= dateTolerance) {
    score += Math.max(4, 20 - Math.floor((days / Math.max(1, dateTolerance)) * 16));
    reason.push(`${days} Tage Abstand`);
  } else if (!reference) {
    return undefined;
  }

  if (nameSimilarity >= 1) {
    score += 30;
    reason.push(viaPayPal ? "Händlername über PayPal-Transaktionskette" : "Gegenpartei eindeutig ähnlich");
  } else if (nameSimilarity >= 0.5) {
    score += 20;
    reason.push(viaPayPal ? "Händlerhinweis aus PayPal-Verknüpfung" : "Gegenpartei teilweise ähnlich");
  }

  if (document.category === "document-income" && ORDER_CATEGORIES.has(target.category)) {
    score += 12;
    reason.push("Rechnung ↔ Plattformbestellung");
  }
  if (document.category !== "document-income" && CASH_CATEGORIES.has(target.category)) {
    score += 8;
    reason.push("Ausgabe ↔ Zahlungsbewegung");
  }
  if (document.category === "tax-payment" && normalizeText(target.counterparty + target.description).includes("finanzamt")) {
    score += 35;
    reason.push("Finanzamt-Steuerzahlung");
  } else if (document.category === "tax-payment" && difference <= 0.02 && (days ?? 99) <= 3) {
    score += 25;
    reason.push("Steuerbeleg und Bankzahlung centgenau am selben Termin");
  }

  return { score, reason, target, reference, difference, days };
}

function documentLinks(
  records: NormalizedRecord[],
  dateTolerance: number,
  amountTolerance: number,
  paypalContexts: Map<string, NormalizedRecord[]>,
): MatchResult {
  const proposedLinks: Array<{ document: NormalizedRecord; pair: ScoredPair; family: string }> = [];
  const candidates: MatchCandidate[] = [];
  const documents = records.filter((record) => DOCUMENT_CATEGORIES.has(record.category) && active(record));
  const allIncomeTargets = records.filter(
    (record) => active(record) && record.direction === "in" && (ORDER_CATEGORIES.has(record.category) || CASH_CATEGORIES.has(record.category)),
  );
  const primaryOrderKeys = new Set(
    allIncomeTargets
      .filter((record) => record.category === "order")
      .map((record) => `${normalizeText(record.shop)}|${record.reference}`),
  );
  const detailedOrderKeys = new Set(
    allIncomeTargets
      .filter((record) => record.category === "order-detail")
      .map((record) => `${normalizeText(record.shop)}|${record.reference}`),
  );
  const incomeTargets = allIncomeTargets.filter(
    (record) =>
      (
        record.category !== "order" ||
        !detailedOrderKeys.has(`${normalizeText(record.shop)}|${record.reference}`)
      ) &&
      (
        record.category !== "order-detail" ||
        !primaryOrderKeys.has(`${normalizeText(record.shop)}|${record.reference}`) ||
        detailedOrderKeys.has(`${normalizeText(record.shop)}|${record.reference}`)
      ),
  );
  const outgoingTargets = records.filter(
    (record) => active(record) && record.direction === "out" && PAYMENT_EVIDENCE_CATEGORIES.has(record.category),
  );

  for (const document of documents) {
    const targets = document.category === "document-income" ? incomeTargets : outgoingTargets;
    const scored = targets
      .map((target) => scoreDocumentTarget(document, target, dateTolerance, amountTolerance, paypalContexts))
      .filter((entry): entry is ScoredPair => Boolean(entry))
      .sort((left, right) => right.score - left.score || left.difference - right.difference);
    const families = new Map<string, ScoredPair[]>();
    for (const pair of scored) {
      const family = ORDER_CATEGORIES.has(pair.target.category) ? "order" : "payment";
      families.set(family, [...(families.get(family) ?? []), pair]);
    }
    for (const [family, familyPairs] of families) {
      const best = familyPairs[0];
      const runnerUp = familyPairs[1];
      const type: MatchLink["type"] = family === "order" ? "document-order" : "document-payment";
      const reason = best.reason.join(" · ");
      const unambiguous = !runnerUp || best.score - runnerUp.score >= 8 || Boolean(best.reference);
      if (best.score >= 82 && unambiguous) {
        proposedLinks.push({ document, pair: best, family });
      } else if (best.score >= 55) {
        candidates.push({ ...makeLink(document, best.target, type, best.score, "document-candidate", reason, false), automatic: false });
      }
    }
  }

  const targetUse = new Map<string, Array<{ document: NormalizedRecord; pair: ScoredPair; family: string }>>();
  for (const proposal of proposedLinks) {
    targetUse.set(proposal.pair.target.id, [...(targetUse.get(proposal.pair.target.id) ?? []), proposal]);
  }
  const links: MatchLink[] = [];
  for (const proposals of targetUse.values()) {
    proposals.sort((left, right) => right.pair.score - left.pair.score || left.pair.difference - right.pair.difference);
    const best = proposals[0];
    const ambiguous = proposals.length > 1 && !best.pair.reference && best.pair.score - proposals[1].pair.score < 8;
    const type: MatchLink["type"] = best.family === "order" ? "document-order" : "document-payment";
    const link = makeLink(best.document, best.pair.target, type, best.pair.score, "document-best-match", best.pair.reason.join(" · "), true);
    if (ambiguous) candidates.push({ ...link, automatic: false, rule: "document-candidate-duplicate-target" });
    else links.push(link);
  }
  return { links, candidates, reviews: [] };
}

function foreignCurrencyMerchantLinks(records: NormalizedRecord[]): MatchLink[] {
  const documents = records
    .filter(
      (record) =>
        active(record) &&
        record.category === "document-income" &&
        record.currency === "EUR" &&
        canonicalParty(record.counterparty) === "printler",
    )
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.id.localeCompare(right.id));
  const payments = records
    .filter(
      (record) =>
        active(record) &&
        isPayPal(record) &&
        record.direction === "in" &&
        record.currency !== "EUR" &&
        canonicalParty(record.counterparty) === "printler",
    )
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.sourceRow - right.sourceRow);
  const available = new Set(documents.map((document) => document.id));
  const links: MatchLink[] = [];
  for (const payment of payments) {
    const candidates = documents
      .filter((document) => available.has(document.id))
      .map((document) => ({ document, days: reconciliationDateDifference(document, payment) ?? 999 }))
      .filter((entry) => entry.days <= 30)
      .sort((left, right) => left.days - right.days || (left.document.date ?? "").localeCompare(right.document.date ?? ""));
    if (!candidates.length) continue;
    const selected = candidates[0].document;
    available.delete(selected.id);
    const impliedRate = selected.amount ? payment.amount / selected.amount : 0;
    const link = makeLink(
      selected,
      payment,
      "foreign-exchange",
      93,
      "printler-paypal-fx-window",
      `Printler-Zahlung ${payment.amount.toFixed(2)} ${payment.currency} ↔ ${selected.amount.toFixed(2)} EUR · abgeleiteter Kurs ${impliedRate.toFixed(4)} ${payment.currency}/EUR · EUR-Gegenseite fehlt im Export`,
      true,
    );
    links.push({ ...link, amountDifference: 0 });
  }
  return links;
}

function acceptedMerchantVariantLinks(records: NormalizedRecord[], existingLinks: MatchLink[]): MatchLink[] {
  const linked = new Set(
    existingLinks
      .filter((link) => link.type === "document-payment" || link.type === "foreign-exchange")
      .flatMap((link) => [link.fromId, link.toId]),
  );
  const documents = records.filter(
    (record) =>
      active(record) &&
      record.category === "document-income" &&
      canonicalParty(record.counterparty) === "europosters" &&
      !linked.has(record.id),
  );
  const payments = records.filter(
    (record) =>
      active(record) &&
      isPayPal(record) &&
      record.direction === "in" &&
      canonicalParty(record.counterparty) === "europosters" &&
      !linked.has(record.id),
  );
  const links: MatchLink[] = [];
  for (const document of documents) {
    const matches = payments.filter((payment) => {
      const days = reconciliationDateDifference(document, payment);
      const differenceRatio = document.amount ? Math.abs(document.amount - payment.amount) / document.amount : 1;
      return (days === undefined || days <= 20) && differenceRatio <= 0.1;
    });
    if (matches.length !== 1) continue;
    links.push(
      makeLink(
        document,
        matches[0],
        "document-payment",
        90,
        "europosters-documented-payout-variance",
        `Europosters-Plattformzahlung eindeutig nach Händler und Zeitraum · Bruttoabweichung ${Math.abs(document.amount - matches[0].amount).toFixed(2)} EUR bleibt im Prüfbericht sichtbar`,
        true,
      ),
    );
  }
  return links;
}

function uniqueYearlyExactMerchantLinks(records: NormalizedRecord[], existingLinks: MatchLink[]): MatchLink[] {
  const linkedDocuments = new Set(
    existingLinks
      .filter((link) => link.type === "document-payment" || link.type === "foreign-exchange")
      .flatMap((link) => [link.fromId, link.toId]),
  );
  const documents = records.filter(
    (record) => active(record) && DOCUMENT_CATEGORIES.has(record.category) && !linkedDocuments.has(record.id),
  );
  const payments = records.filter(
    (record) => active(record) && (isBank(record) || isPayPal(record)) && record.direction !== "neutral",
  );
  const possible: Array<{ document: NormalizedRecord; payment: NormalizedRecord }> = [];
  for (const document of documents) {
    const documentParty = normalizedNameTokens(document.counterparty);
    if (!documentParty.size) continue;
    for (const payment of payments) {
      if (document.direction !== payment.direction || closestAmountDifference(document, payment) > 0.02) continue;
      if (document.date && payment.date && document.date.slice(0, 4) !== payment.date.slice(0, 4)) continue;
      const paymentParty = normalizedNameTokens(`${payment.counterparty} ${payment.description}`);
      if (tokenSetSimilarity(documentParty, paymentParty) < 0.5) continue;
      possible.push({ document, payment });
    }
  }
  const byDocument = new Map<string, typeof possible>();
  const byPayment = new Map<string, typeof possible>();
  for (const candidate of possible) {
    byDocument.set(candidate.document.id, [...(byDocument.get(candidate.document.id) ?? []), candidate]);
    byPayment.set(candidate.payment.id, [...(byPayment.get(candidate.payment.id) ?? []), candidate]);
  }
  return possible
    .filter(
      (candidate) =>
        byDocument.get(candidate.document.id)?.length === 1 &&
        byPayment.get(candidate.payment.id)?.length === 1,
    )
    .map((candidate) => {
      const days = reconciliationDateDifference(candidate.document, candidate.payment);
      return makeLink(
        candidate.document,
        candidate.payment,
        "document-payment",
        91,
        "unique-yearly-exact-merchant-payment",
        `Im Gesamtjahr eindeutiger Händler- und Betragsgleichlauf${days === undefined ? "" : ` · ${days} Tage Datumsabweichung im Beleg`}`,
        true,
      );
    });
}

function exactReferenceLinks(records: NormalizedRecord[]): MatchLink[] {
  const evidence = records.filter(
    (record) => active(record) && PLATFORM_SOURCES.has(record.sourceKind) && ["order", "order-detail", "sale", "refund", "fee"].includes(record.category),
  );
  const index = new Map<string, NormalizedRecord[]>();
  for (const record of evidence) {
    for (const token of tokens(record)) index.set(token, [...(index.get(token) ?? []), record]);
  }
  const links: MatchLink[] = [];
  const seen = new Set<string>();
  for (const [reference, matches] of index) {
    if (matches.length > 50) continue;
    for (let leftIndex = 0; leftIndex < matches.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex += 1) {
        const left = matches[leftIndex];
        const right = matches[rightIndex];
        if (left.sourceId === right.sourceId || left.sourceKind === right.sourceKind) continue;
        if (left.shop && right.shop && normalizeText(left.shop) !== normalizeText(right.shop)) continue;
        const key = pairKey(left.id, right.id, "platform-evidence");
        if (seen.has(key)) continue;
        const days = dateDifferenceDays(left.date, right.date);
        if (typeof days === "number" && days > 60) continue;
        seen.add(key);
        links.push(makeLink(left, right, "platform-evidence", 98, "shared-platform-reference", `Gemeinsame Plattformreferenz ${reference}`, true));
      }
    }
  }
  return links;
}

function payoutLinks(records: NormalizedRecord[]): MatchLink[] {
  const payouts = records.filter((record) => active(record) && record.category === "payout");
  const bankIncoming = records.filter((record) => active(record) && isBank(record) && record.category === "cash-movement" && record.direction === "in");
  const byAmount = new Map<number, NormalizedRecord[]>();
  for (const bank of bankIncoming) {
    for (const amount of amountVariants(bank)) {
      const cents = Math.round(amount * 100);
      byAmount.set(cents, [...(byAmount.get(cents) ?? []), bank]);
    }
  }
  const links: MatchLink[] = [];
  for (const payout of payouts) {
    const possible = Array.from(new Set(amountVariants(payout).flatMap((amount) => byAmount.get(Math.round(amount * 100)) ?? [])));
    const matches = possible
      .filter((bank) => closestAmountDifference(payout, bank) <= 0.02)
      .map((bank) => ({ bank, days: dateDifferenceDays(payout.date, bank.date) }))
      .filter((entry) => entry.days === undefined || entry.days <= 7)
      .sort((left, right) => (left.days ?? 99) - (right.days ?? 99));
    if (!matches.length) continue;
    const best = matches[0];
    const tied = matches[1] && (matches[1].days ?? 99) === (best.days ?? 99);
    if (tied) continue;
    links.push(makeLink(payout, best.bank, "payout-bank", 98, "payout-exact-bank", `Auszahlung und Bankgutschrift centgenau · ${best.days ?? "?"} Tage Abstand`, true));
  }
  return links;
}

function platformDebitLinks(records: NormalizedRecord[]): MatchLink[] {
  const transfers = records.filter(
    (record) =>
      active(record) &&
      record.sourceKind === "ebay-ledger" &&
      record.category === "transfer" &&
      record.direction === "in",
  );
  const bankDebits = records.filter(
    (record) =>
      active(record) &&
      isBank(record) &&
      record.category === "cash-movement" &&
      record.direction === "out" &&
      normalizeText(`${record.counterparty} ${record.description}`).includes("ebay"),
  );
  const possible: Array<{ transfer: NormalizedRecord; bank: NormalizedRecord; days: number }> = [];
  for (const transfer of transfers) {
    for (const bank of bankDebits) {
      if (closestAmountDifference(transfer, bank) > 0.02) continue;
      const days = dateDifferenceDays(transfer.date, bank.date);
      if (days === undefined || days > 7) continue;
      possible.push({ transfer, bank, days });
    }
  }
  const closestTransfer = new Map<string, typeof possible>();
  const closestBank = new Map<string, typeof possible>();
  for (const candidate of possible) {
    closestTransfer.set(
      candidate.transfer.id,
      [...(closestTransfer.get(candidate.transfer.id) ?? []), candidate]
        .sort((left, right) => left.days - right.days),
    );
    closestBank.set(
      candidate.bank.id,
      [...(closestBank.get(candidate.bank.id) ?? []), candidate]
        .sort((left, right) => left.days - right.days),
    );
  }
  return possible
    .filter((candidate) => {
      const transferBest = closestTransfer.get(candidate.transfer.id) ?? [];
      const bankBest = closestBank.get(candidate.bank.id) ?? [];
      return (
        transferBest[0] === candidate &&
        bankBest[0] === candidate &&
        (!transferBest[1] || transferBest[1].days > candidate.days) &&
        (!bankBest[1] || bankBest[1].days > candidate.days)
      );
    })
    .map((candidate) =>
      makeLink(
        candidate.transfer,
        candidate.bank,
        "payout-bank",
        99,
        "ebay-debit-bank",
        `eBay-Belastung und FYRST/N26-Abbuchung centgenau · ${candidate.days} Tage Abstand`,
        true,
      ),
    );
}

function walletLinks(records: NormalizedRecord[]): MatchLink[] {
  const walletFunding = records.filter((record) => active(record) && record.category === "wallet-funding");
  const paypalOutgoing = records.filter((record) => active(record) && isPayPal(record) && record.direction === "out");
  const links: MatchLink[] = [];
  for (const funding of walletFunding) {
    const matches = paypalOutgoing
      .filter((paypal) => closestAmountDifference(funding, paypal) <= 0.02)
      .map((paypal) => ({ paypal, days: dateDifferenceDays(funding.date, paypal.date) }))
      .filter((entry) => entry.days === undefined || entry.days <= 3)
      .sort((left, right) => (left.days ?? 99) - (right.days ?? 99));
    if (matches.length !== 1) continue;
    links.push(makeLink(funding, matches[0].paypal, "wallet-bridge", 97, "printful-wallet-paypal", "Printful-Geldbörse und PayPal-Belastung centgenau", true));
  }
  return links;
}

function providerPaymentLinks(records: NormalizedRecord[]): MatchLink[] {
  const charges = records.filter(
    (record) => active(record) && record.category === "wallet-charge" && (record.sourceKind === "gelato" || record.sourceKind === "printful-orders"),
  );
  const targets = records.filter(
    (record) =>
      active(record) &&
      record.direction === "out" &&
      (isBank(record) || isPayPal(record) || record.category === "wallet-funding"),
  );
  const possible: Array<{ charge: NormalizedRecord; target: NormalizedRecord; days: number; priority: number }> = [];
  for (const charge of charges) {
    for (const target of targets) {
      if (charge.sourceId === target.sourceId || closestAmountDifference(charge, target) > 0.02) continue;
      const days = dateDifferenceDays(charge.date, target.date) ?? 0;
      if (days > 3 || counterpartySimilarity(charge, target) < 0.5) continue;
      possible.push({ charge, target, days, priority: isPayPal(target) ? 0 : target.category === "wallet-funding" ? 1 : 2 });
    }
  }
  const usedCharges = new Set<string>();
  const usedTargets = new Set<string>();
  const selected = possible
    .sort((left, right) => left.days - right.days || left.priority - right.priority || left.charge.sourceRow - right.charge.sourceRow)
    .filter((candidate) => {
      if (usedCharges.has(candidate.charge.id) || usedTargets.has(candidate.target.id)) return false;
      usedCharges.add(candidate.charge.id);
      usedTargets.add(candidate.target.id);
      return true;
    });
  return selected.map((candidate) =>
    makeLink(
      candidate.charge,
      candidate.target,
      "wallet-bridge",
      97,
      "provider-exact-payment",
      "Anbieterauftrag und Zahlungsbewegung centgenau",
      true,
    ),
  );
}

function providerRefundLinks(records: NormalizedRecord[]): MatchLink[] {
  const providers = new Set(["gelato", "printful-orders"]);
  const charges = records.filter(
    (record) => active(record) && providers.has(record.sourceKind) && record.category === "wallet-charge" && record.reference,
  );
  const refunds = records.filter(
    (record) => active(record) && providers.has(record.sourceKind) && record.category === "refund" && record.reference,
  );
  const links: MatchLink[] = [];
  for (const refund of refunds) {
    const matches = charges.filter(
      (charge) =>
        charge.sourceKind === refund.sourceKind &&
        charge.reference === refund.reference &&
        closestAmountDifference(charge, refund) <= 0.02,
    );
    if (matches.length !== 1) continue;
    links.push(
      makeLink(
        matches[0],
        refund,
        "account-batch",
        100,
        "provider-charge-refund",
        `${refund.counterparty}-Auftrag und Erstattung über dieselbe Referenz`,
        true,
      ),
    );
  }
  return links;
}

function providerDocumentLinks(records: NormalizedRecord[], refundLinks: MatchLink[], dateTolerance: number): MatchLink[] {
  const refundedCharges = new Set(
    refundLinks.filter((link) => link.rule === "provider-charge-refund").flatMap((link) => [link.fromId]),
  );
  const documents = records.filter((record) => {
    if (!active(record) || record.category !== "document-expense") return false;
    const provider = canonicalParty(record.counterparty);
    return provider === "gelato" || provider === "printful";
  });
  const charges = records.filter(
    (record) =>
      active(record) &&
      record.category === "wallet-charge" &&
      (record.sourceKind === "gelato" || record.sourceKind === "printful-orders") &&
      !refundedCharges.has(record.id),
  );
  interface ProviderCandidate {
    document: NormalizedRecord;
    charge: NormalizedRecord;
    days: number;
  }
  const possible: ProviderCandidate[] = [];
  for (const document of documents) {
    for (const charge of charges) {
      const provider = canonicalParty(document.counterparty);
      if (provider !== canonicalParty(charge.counterparty)) continue;
      if (closestAmountDifference(document, charge) > 0.02) continue;
      const days = reconciliationDateDifference(document, charge) ?? 999;
      const maximumDays = provider === "printful" ? Math.max(45, dateTolerance) : dateTolerance;
      if (days > maximumDays) continue;
      possible.push({ document, charge, days });
    }
  }
  const groups = new Map<string, ProviderCandidate[]>();
  for (const candidate of possible) {
    const key = `${canonicalParty(candidate.document.counterparty)}|${Math.round(candidate.document.amount * 100)}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const selected: ProviderCandidate[] = [];
  for (const candidates of groups.values()) {
    const groupDocuments = [...new Map(candidates.map((candidate) => [candidate.document.id, candidate.document])).values()]
      .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.sourceRow - right.sourceRow);
    const groupCharges = [...new Map(candidates.map((candidate) => [candidate.charge.id, candidate.charge])).values()];
    if (groupDocuments.length > 18 || groupCharges.length > 18) {
      const usedDocuments = new Set<string>();
      const usedCharges = new Set<string>();
      selected.push(...[...candidates]
        .sort((left, right) => left.days - right.days || left.document.sourceRow - right.document.sourceRow || left.charge.sourceRow - right.charge.sourceRow)
        .filter((candidate) => {
          if (usedDocuments.has(candidate.document.id) || usedCharges.has(candidate.charge.id)) return false;
          usedDocuments.add(candidate.document.id);
          usedCharges.add(candidate.charge.id);
          return true;
        }));
      continue;
    }
    const chargeIndex = new Map(groupCharges.map((charge, index) => [charge.id, index]));
    interface Assignment { matches: number; cost: number; pairs: ProviderCandidate[] }
    const memo = new Map<string, Assignment>();
    const solve = (documentIndex: number, mask: number): Assignment => {
      if (documentIndex >= groupDocuments.length) return { matches: 0, cost: 0, pairs: [] };
      const key = `${documentIndex}|${mask}`;
      const cached = memo.get(key);
      if (cached) return cached;
      const document = groupDocuments[documentIndex];
      let best = solve(documentIndex + 1, mask);
      for (const candidate of candidates.filter((entry) => entry.document.id === document.id)) {
        const index = chargeIndex.get(candidate.charge.id);
        if (index === undefined || (mask & (1 << index))) continue;
        const tail = solve(documentIndex + 1, mask | (1 << index));
        const option = { matches: tail.matches + 1, cost: tail.cost + candidate.days, pairs: [candidate, ...tail.pairs] };
        if (option.matches > best.matches || (option.matches === best.matches && option.cost < best.cost)) best = option;
      }
      memo.set(key, best);
      return best;
    };
    selected.push(...solve(0, 0).pairs);
  }
  return selected
    .map((candidate) =>
      makeLink(
        candidate.document,
        candidate.charge,
        "document-order",
        candidate.days <= dateTolerance ? 99 : 94,
        "provider-document-global-assignment",
        `${candidate.charge.counterparty}-Beleg und Anbieterauftrag global 1:1 zugeordnet · ${candidate.days} Tage Abstand`,
        true,
      ),
    );
}

interface PayPalBankCandidate {
  bank: NormalizedRecord;
  paypal: NormalizedRecord;
  days: number;
  cost: number;
  structured: boolean;
}

function bestGlobalAssignment(
  banks: NormalizedRecord[],
  candidates: PayPalBankCandidate[],
): PayPalBankCandidate[] {
  const paypal = [...new Map(candidates.map((candidate) => [candidate.paypal.id, candidate.paypal])).values()];
  const paypalIndex = new Map(paypal.map((record, index) => [record.id, index]));
  if (paypal.length > 18 || banks.length > 18) {
    const used = new Set<string>();
    return [...candidates]
      .sort((left, right) => left.cost - right.cost || left.days - right.days)
      .filter((candidate) => {
        if (used.has(candidate.bank.id) || used.has(candidate.paypal.id)) return false;
        used.add(candidate.bank.id);
        used.add(candidate.paypal.id);
        return true;
      });
  }

  interface Assignment {
    matches: number;
    cost: number;
    pairs: PayPalBankCandidate[];
  }
  const byBank = new Map(
    banks.map((bank) => [bank.id, candidates.filter((candidate) => candidate.bank.id === bank.id)]),
  );
  const memo = new Map<string, Assignment>();
  const solve = (bankIndex: number, mask: number): Assignment => {
    if (bankIndex >= banks.length) return { matches: 0, cost: 0, pairs: [] };
    const key = `${bankIndex}|${mask}`;
    const cached = memo.get(key);
    if (cached) return cached;
    let best = solve(bankIndex + 1, mask);
    for (const candidate of byBank.get(banks[bankIndex].id) ?? []) {
      const index = paypalIndex.get(candidate.paypal.id);
      if (index === undefined || (mask & (1 << index))) continue;
      const tail = solve(bankIndex + 1, mask | (1 << index));
      const option: Assignment = {
        matches: tail.matches + 1,
        cost: tail.cost + candidate.cost,
        pairs: [candidate, ...tail.pairs],
      };
      if (
        option.matches > best.matches ||
        (option.matches === best.matches && option.cost < best.cost)
      ) {
        best = option;
      }
    }
    memo.set(key, best);
    return best;
  };
  return solve(0, 0).pairs;
}

function internalTransferLinks(records: NormalizedRecord[]): MatchLink[] {
  const banks = records.filter(
    (record) =>
      active(record) &&
      isBank(record) &&
      record.direction !== "neutral" &&
      normalizeText(`${record.counterparty} ${record.description}`).includes("paypal"),
  );
  const paypal = records.filter(
    (record) => active(record) && isPayPal(record) && record.direction !== "neutral",
  );
  const groups = new Map<string, NormalizedRecord[]>();
  for (const bank of banks) {
    const key = `${bank.currency}|${Math.round(bank.amount * 100)}|${bank.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), bank]);
  }

  const assignments: PayPalBankCandidate[] = [];
  const usedPayPal = new Set<string>();
  for (const groupBanks of groups.values()) {
    const candidates: PayPalBankCandidate[] = [];
    for (const bank of groupBanks) {
      for (const entry of paypal) {
        if (entry.currency !== bank.currency || closestAmountDifference(bank, entry) > 0.02) continue;
        const days = dateDifferenceDays(bank.date, entry.date);
        if (days === undefined || days > 10) continue;
        const description = normalizeText(entry.description);
        const bankFunding =
          bank.direction === "out" &&
          entry.direction === "in" &&
          entry.category === "transfer" &&
          (description.includes("bankgutschrift") || description.includes("paypal konto"));
        const bankWithdrawal =
          bank.direction === "in" &&
          entry.direction === "out" &&
          entry.category === "transfer" &&
          (description.includes("abbuchung") || description.includes("bankkonto"));
        const merchantRefund =
          bank.direction === "in" &&
          entry.direction === "in" &&
          entry.category !== "transfer";
        const directMerchantPayment =
          bank.direction === "out" &&
          entry.direction === "out" &&
          !(entry.category === "transfer" && (description.includes("abbuchung") || description.includes("bankkonto")));
        if (!bankFunding && !bankWithdrawal && !merchantRefund && !directMerchantPayment) continue;
        const structured = bankFunding || bankWithdrawal || merchantRefund;
        const merchantSimilarity = counterpartySimilarity(bank, entry);
        const typePenalty = structured ? 0 : 20;
        candidates.push({
          bank,
          paypal: entry,
          days,
          cost: days * 10 + typePenalty - Math.round(merchantSimilarity * 3),
          structured,
        });
      }
    }
    for (const assignment of bestGlobalAssignment(groupBanks, candidates)) {
      if (usedPayPal.has(assignment.paypal.id)) continue;
      usedPayPal.add(assignment.paypal.id);
      assignments.push(assignment);
    }
  }

  return assignments.map((assignment) =>
    makeLink(
      assignment.bank,
      assignment.paypal,
      "paypal-bank-bridge",
      assignment.structured ? 99 : 94,
      "paypal-bank-global-assignment",
      `Globale Eins-zu-eins-Zuordnung über Betrag, Richtung, Transaktionstyp und ${assignment.days} Tage Abstand`,
      true,
    ),
  );
}

function bankInternalLinks(records: NormalizedRecord[]): MatchLink[] {
  const bank = records.filter((record) => active(record) && isBank(record) && record.direction !== "neutral");
  const possible: Array<{ left: NormalizedRecord; right: NormalizedRecord; days: number }> = [];
  for (let leftIndex = 0; leftIndex < bank.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < bank.length; rightIndex += 1) {
      const left = bank[leftIndex];
      const right = bank[rightIndex];
      if (left.sourceKind === right.sourceKind || left.direction === right.direction || closestAmountDifference(left, right) > 0.02) continue;
      const days = dateDifferenceDays(left.date, right.date) ?? 0;
      if (days > 3 || counterpartySimilarity(left, right) < 0.5) continue;
      const party = normalizeText(`${left.counterparty} ${right.counterparty}`);
      if (!party.includes("niklas") || !party.includes("horstmann")) continue;
      possible.push({ left, right, days });
    }
  }
  const byRecord = new Map<string, typeof possible>();
  for (const candidate of possible) {
    byRecord.set(candidate.left.id, [...(byRecord.get(candidate.left.id) ?? []), candidate]);
    byRecord.set(candidate.right.id, [...(byRecord.get(candidate.right.id) ?? []), candidate]);
  }
  const uniqueClosest = (recordId: string) => {
    const sorted = [...(byRecord.get(recordId) ?? [])].sort((left, right) => left.days - right.days);
    return sorted.length && (!sorted[1] || sorted[0].days < sorted[1].days) ? sorted[0] : undefined;
  };
  return possible
    .filter((candidate) => uniqueClosest(candidate.left.id) === candidate && uniqueClosest(candidate.right.id) === candidate)
    .map((candidate) =>
      makeLink(candidate.left, candidate.right, "internal-transfer", 99, "bank-own-account-transfer", "Gegenlauf zwischen eigenen Bankkonten", true),
    );
}

function platformSettlementLinks(records: NormalizedRecord[]): MatchLink[] {
  const links: MatchLink[] = [];
  const ebayLedger = records.filter((record) => active(record) && record.sourceKind === "ebay-ledger");
  const byPayout = new Map<string, NormalizedRecord[]>();
  for (const record of ebayLedger) {
    const payoutId = String(record.metadata.payoutId ?? "").trim();
    if (payoutId) byPayout.set(payoutId, [...(byPayout.get(payoutId) ?? []), record]);
  }
  for (const [payoutId, group] of byPayout) {
    const payouts = group.filter((record) => record.category === "payout");
    const activity = group.filter((record) => record.category !== "payout");
    if (payouts.length !== 1) continue;
    for (const record of activity) {
      links.push(makeLink(record, payouts[0], "platform-settlement", 100, "ebay-payout-id", `eBay-Auszahlung ${payoutId}`, true));
    }
  }

  const etsyStatementPayouts = records.filter((record) => active(record) && record.sourceKind === "etsy-statement" && record.category === "payout");
  const etsyTransfers = records.filter((record) => active(record) && record.sourceKind === "etsy-transfers" && record.category === "payout");
  for (const payout of etsyStatementPayouts) {
    const matches = etsyTransfers.filter((transfer) => {
      if (payout.shop && transfer.shop && normalizeText(payout.shop) !== normalizeText(transfer.shop)) return false;
      const days = dateDifferenceDays(payout.date, transfer.date);
      return closestAmountDifference(payout, transfer) <= 0.02 && (days === undefined || days <= 3);
    });
    if (matches.length === 1) {
      links.push(makeLink(payout, matches[0], "platform-settlement", 100, "etsy-statement-transfer", "Etsy-Abrechnung und Überweisung centgenau", true));
    }
  }
  const etsyShops = new Set(
    records
      .filter((record) => active(record) && record.sourceKind === "etsy-statement" && record.shop)
      .map((record) => record.shop!),
  );
  for (const shop of etsyShops) {
    const statement = records
      .filter((record) => active(record) && record.sourceKind === "etsy-statement" && record.shop === shop && record.date)
      .sort((left, right) => left.date!.localeCompare(right.date!) || left.sourceRow - right.sourceRow);
    const payouts = statement.filter((record) => record.category === "payout");
    let previousDate = "0000-00-00";
    for (const payout of payouts) {
      const sameDayPayouts = payouts.filter((entry) => entry.date === payout.date);
      if (sameDayPayouts.length > 1) {
        previousDate = payout.date!;
        continue;
      }
      const activity = statement.filter(
        (record) => record.category !== "payout" && record.date! > previousDate && record.date! <= payout.date!,
      );
      const contribution = roundMoney(
        activity.reduce((sum, record) => sum + Number(record.metadata.payoutContribution ?? 0), 0),
      );
      if (activity.length && Math.abs(contribution - payout.amount) <= 0.02) {
        for (const record of activity) {
          links.push(
            makeLink(
              record,
              payout,
              "platform-settlement",
              99,
              "etsy-exact-payout-batch",
              `Etsy-Aktivitäten ergeben zusammen die Auszahlung ${payout.amount.toFixed(2)} €`,
              true,
            ),
          );
        }
      }
      previousDate = payout.date!;
    }

    let combinedPreviousDate = "0000-00-00";
    let pending: Array<{ payout: NormalizedRecord; activity: NormalizedRecord[]; contribution: number }> = [];
    for (const payout of payouts) {
      const sameDayPayouts = payouts.filter((entry) => entry.date === payout.date);
      const activity = statement.filter(
        (record) => record.category !== "payout" && record.date! > combinedPreviousDate && record.date! <= payout.date!,
      );
      const contribution = roundMoney(
        activity.reduce((sum, record) => sum + Number(record.metadata.payoutContribution ?? 0), 0),
      );
      combinedPreviousDate = payout.date!;
      if (sameDayPayouts.length > 1 || !activity.length) {
        pending = [];
        continue;
      }
      const individualExact = Math.abs(contribution - payout.amount) <= 0.02;
      if (individualExact) {
        pending = [];
        continue;
      }
      pending.push({ payout, activity, contribution });
      const combinedContribution = roundMoney(pending.reduce((sum, entry) => sum + entry.contribution, 0));
      const combinedPayouts = roundMoney(pending.reduce((sum, entry) => sum + entry.payout.amount, 0));
      if (pending.length >= 2 && Math.abs(combinedContribution - combinedPayouts) <= 0.02) {
        const anchor = pending.at(-1)!.payout;
        for (const entry of pending) {
          for (const record of entry.activity) {
            links.push(
              makeLink(
                record,
                anchor,
                "platform-settlement",
                98,
                "etsy-combined-payout-window",
                `Mehrere Etsy-Auszahlungsintervalle ergeben zusammen ${combinedPayouts.toFixed(2)} €`,
                true,
              ),
            );
          }
          if (entry.payout.id !== anchor.id) {
            links.push(
              makeLink(entry.payout, anchor, "platform-settlement", 98, "etsy-combined-payout-window", "Gemeinsames centgenaues Etsy-Auszahlungsfenster", true),
            );
          }
        }
        pending = [];
      } else if (pending.length >= 4) {
        pending = [];
      }
    }
  }
  return links;
}

function signedPlatformAmount(record: NormalizedRecord): number {
  if (record.direction === "out") return -Math.abs(record.amount);
  if (record.direction === "in") return Math.abs(record.amount);
  return 0;
}

function creditNoteRefundLinks(records: NormalizedRecord[]): MatchLink[] {
  const creditNotes = records.filter(
    (record) =>
      active(record) &&
      record.category === "document-income" &&
      record.direction === "out",
  );
  const refunds = records.filter(
    (record) =>
      active(record) &&
      PLATFORM_SOURCES.has(record.sourceKind) &&
      record.category === "refund" &&
      record.direction === "out",
  );
  const proposals: Array<{ document: NormalizedRecord; refund: NormalizedRecord; days: number }> = [];
  for (const document of creditNotes) {
    for (const refund of refunds) {
      if (closestAmountDifference(document, refund) > 0.02 || counterpartySimilarity(document, refund) < 0.5) continue;
      const days = reconciliationDateDifference(document, refund);
      if (days !== undefined && days > 90) continue;
      proposals.push({ document, refund, days: days ?? 0 });
    }
  }
  const byDocument = new Map<string, typeof proposals>();
  const byRefund = new Map<string, typeof proposals>();
  for (const proposal of proposals) {
    byDocument.set(proposal.document.id, [...(byDocument.get(proposal.document.id) ?? []), proposal]);
    byRefund.set(proposal.refund.id, [...(byRefund.get(proposal.refund.id) ?? []), proposal]);
  }
  return proposals
    .filter(
      (proposal) =>
        byDocument.get(proposal.document.id)?.length === 1 &&
        byRefund.get(proposal.refund.id)?.length === 1,
    )
    .map((proposal) =>
      makeLink(
        proposal.document,
        proposal.refund,
        "document-order",
        100,
        "credit-note-platform-refund",
        `Stornorechnung und Plattformerstattung centgenau · ${proposal.days} Tage Abstand`,
        true,
      ),
    );
}

function documentAggregateLinks(records: NormalizedRecord[], dateTolerance: number): MatchLink[] {
  const documents = records.filter((record) => active(record) && DOCUMENT_CATEGORIES.has(record.category));
  const platformRecords = records.filter(
    (record) => active(record) && PLATFORM_SOURCES.has(record.sourceKind) && ["order", "sale", "refund"].includes(record.category),
  );
  const byReference = new Map<string, NormalizedRecord[]>();
  for (const record of platformRecords) {
    const reference = String(record.metadata.orderId ?? record.reference).trim();
    if (reference) byReference.set(reference, [...(byReference.get(reference) ?? []), record]);
  }
  const links: MatchLink[] = [];
  for (const document of documents.filter((record) => record.category === "document-income")) {
    const matches: Array<{ group: NormalizedRecord[]; difference: number }> = [];
    for (const group of byReference.values()) {
      const primaryOrders = group.filter((record) => record.category === "order");
      const ledgerSales = group.filter((record) => record.category === "sale");
      const sales = ledgerSales.length ? ledgerSales : primaryOrders;
      const refunds = group.filter((record) => record.category === "refund");
      if (!sales.length || !refunds.length) continue;
      const evidence = [...sales, ...refunds];
      const nameSimilarity = evidence.reduce((best, record) => Math.max(best, counterpartySimilarity(document, record)), 0);
      const withinDate = evidence.some((record) => {
        const days = dateDifferenceDays(document.date, record.date);
        return days === undefined || days <= Math.max(dateTolerance, 90);
      });
      if (nameSimilarity < 0.5 || !withinDate) continue;
      const netAmount = roundMoney(evidence.reduce((sum, record) => sum + signedPlatformAmount(record), 0));
      const difference = roundMoney(Math.abs(document.amount - netAmount));
      if (difference <= 0.02) matches.push({ group: evidence, difference });
    }
    if (matches.length !== 1) continue;
    for (const evidence of matches[0].group) {
      links.push(makeLink(document, evidence, "group-payment", 99, "platform-sale-minus-refund", "Rechnung entspricht Verkauf abzüglich Erstattung", true));
    }
  }
  return links;
}

function withheldFeeLinks(records: NormalizedRecord[]): MatchLink[] {
  const feeGroups = new Map<string, NormalizedRecord[]>();
  for (const record of records.filter(
    (entry) =>
      active(entry) &&
      entry.date &&
      (
        entry.category === "fee" ||
        (
          entry.sourceKind === "ebay-ledger" &&
          (entry.category === "sale" || entry.category === "refund") &&
          Math.abs(entry.feeAmount ?? 0) > 0
        )
      ),
  )) {
    const platform = record.sourceKind === "etsy-statement" ? "etsy" : record.sourceKind === "ebay-ledger" ? "ebay" : "";
    if (!platform) continue;
    if (platform === "etsy" && record.metadata.marketplaceTax === true) continue;
    const key = `${platform}|${normalizeText(record.shop)}|${record.date!.slice(0, 7)}`;
    feeGroups.set(key, [...(feeGroups.get(key) ?? []), record]);
  }
  const links: MatchLink[] = [];
  const documents = records.filter(
    (record) => active(record) && record.category === "document-expense" && /etsy|ebay/.test(normalizeText(record.counterparty)),
  );
  const candidates: Array<{
    document: NormalizedRecord;
    groupKey: string;
    group: NormalizedRecord[];
    difference: number;
    days: number;
    basis: "net" | "gross";
  }> = [];
  for (const document of documents) {
    const platform = normalizeText(document.counterparty).includes("etsy") ? "etsy" : "ebay";
    candidates.push(...[...feeGroups.entries()]
      .filter(([key]) => key.startsWith(`${platform}|`))
      .flatMap(([groupKey, group]) => {
        const netTotal = roundMoney(group.reduce((sum, record) => {
          if (record.sourceKind === "ebay-ledger" && (record.category === "sale" || record.category === "refund")) {
            return sum + (record.feeAmount ?? 0);
          }
          return sum + (record.direction === "in" ? -record.amount : record.amount);
        }, 0));
        const grossGroup = group.filter((record) => {
          if (record.sourceKind !== "ebay-ledger") return true;
          if (record.category === "sale" || record.category === "refund") return (record.feeAmount ?? 0) > 0;
          return record.category === "fee" && record.direction === "out";
        });
        const grossTotal = roundMoney(grossGroup.reduce((sum, record) => {
          if (record.category === "sale" || record.category === "refund") return sum + Math.max(0, record.feeAmount ?? 0);
          return sum + record.amount;
        }, 0));
        const days = Math.min(...group.map((record) => dateDifferenceDays(document.date, record.date) ?? 0));
        const variants: Array<{ basis: "net" | "gross"; total: number; group: NormalizedRecord[] }> = [
          { basis: "net", total: netTotal, group },
        ];
        if (platform === "ebay" && Math.abs(grossTotal - netTotal) > 0.02) {
          variants.push({ basis: "gross" as const, total: grossTotal, group: grossGroup });
        }
        return variants.map((variant) => ({ document, groupKey, days, ...variant }));
      })
      .map((entry) => ({ ...entry, difference: roundMoney(Math.abs(entry.total - document.amount)) }))
      .filter((entry) => entry.difference <= 1.5 && entry.days <= 45));
  }
  const byDocument = new Map(documents.map((document) => [
    document.id,
    candidates.filter((candidate) => candidate.document.id === document.id)
      .sort((left, right) => left.difference - right.difference || left.days - right.days),
  ]));
  const byGroup = new Map([...feeGroups.keys()].map((groupKey) => [
    groupKey,
    candidates.filter((candidate) => candidate.groupKey === groupKey)
      .sort((left, right) => left.difference - right.difference || left.days - right.days),
  ]));
  const assignedDocuments = new Set<string>();
  const assignedGroups = new Set<string>();
  for (const candidate of [...candidates].sort((left, right) => left.difference - right.difference || left.days - right.days)) {
    if (assignedDocuments.has(candidate.document.id) || assignedGroups.has(candidate.groupKey)) continue;
    if (byDocument.get(candidate.document.id)?.[0] !== candidate || byGroup.get(candidate.groupKey)?.[0] !== candidate) continue;
    const documentRunnerUp = byDocument.get(candidate.document.id)?.[1];
    const groupRunnerUp = byGroup.get(candidate.groupKey)?.[1];
    if (documentRunnerUp && documentRunnerUp.difference === candidate.difference && documentRunnerUp.days === candidate.days) continue;
    if (groupRunnerUp && groupRunnerUp.difference === candidate.difference && groupRunnerUp.days === candidate.days) continue;
    assignedDocuments.add(candidate.document.id);
    assignedGroups.add(candidate.groupKey);
    const exact = candidate.difference <= 0.02;
    for (const fee of candidate.group) {
      links.push(
        makeLink(
          candidate.document,
          fee,
          "group-payment",
          exact ? 99 : 90,
          exact ? `platform-withheld-fees-${candidate.basis}` : `platform-withheld-fees-${candidate.basis}-variance`,
          exact
            ? `${candidate.basis === "gross" ? "Brutto-" : "Netto-"}Plattformgebühren ergeben zusammen den Accountable-Beleg`
            : `Monatsgebühren dem Accountable-Beleg mit ${candidate.difference.toFixed(2)} EUR Abweichung zugeordnet`,
          true,
        ),
      );
    }
  }
  return links;
}

function subsetIndexes(values: number[], target: number, maximumItems = 8): number[][] {
  const solutions: number[][] = [];
  const targetCents = Math.round(target * 100);
  const cents = values.map((value) => Math.round(value * 100));
  function visit(index: number, sum: number, selected: number[]) {
    if (solutions.length > 1) return;
    if (sum === targetCents && selected.length >= 2) {
      solutions.push([...selected]);
      return;
    }
    if (index >= cents.length || selected.length >= maximumItems || sum > targetCents) return;
    visit(index + 1, sum + cents[index], [...selected, index]);
    visit(index + 1, sum, selected);
  }
  visit(0, 0, []);
  return solutions;
}

function groupedBankPaymentLinks(records: NormalizedRecord[], existingLinks: MatchLink[], dateTolerance: number): MatchLink[] {
  const alreadyDirect = new Set(
    existingLinks
      .filter((link) => link.type === "document-payment" || link.type === "group-payment")
      .flatMap((link) => [link.fromId, link.toId]),
  );
  const documents = records.filter(
    (record) => active(record) && DOCUMENT_CATEGORIES.has(record.category) && record.direction === "out" && !alreadyDirect.has(record.id),
  );
  const bank = records.filter((record) => active(record) && isBank(record) && record.direction === "out" && !alreadyDirect.has(record.id));
  const links: MatchLink[] = [];
  for (const document of documents) {
    const candidates = bank
      .filter((payment) => {
        const days = dateDifferenceDays(document.date, payment.date);
        return (days === undefined || days <= dateTolerance) && payment.amount < document.amount && counterpartySimilarity(document, payment) >= 0.5;
      })
      .sort((left, right) => (dateDifferenceDays(document.date, left.date) ?? 99) - (dateDifferenceDays(document.date, right.date) ?? 99))
      .slice(0, 12);
    const solutions = subsetIndexes(candidates.map((candidate) => candidate.amount), document.amount);
    if (solutions.length !== 1) continue;
    for (const index of solutions[0]) {
      links.push(makeLink(document, candidates[index], "group-payment", 99, "document-payment-subset", `Mehrere Zahlungen ergeben zusammen ${document.amount.toFixed(2)} €`, true));
    }
  }
  return links;
}

function groupedDocumentsToPaymentLinks(records: NormalizedRecord[], existingLinks: MatchLink[], dateTolerance: number): MatchLink[] {
  const alreadyDirect = new Set(
    existingLinks
      .filter((link) => link.type === "document-payment" || link.type === "group-payment")
      .flatMap((link) => [link.fromId, link.toId]),
  );
  const documents = records.filter(
    (record) =>
      active(record) &&
      (record.category === "document-expense" || record.category === "tax-payment") &&
      record.direction === "out" &&
      !alreadyDirect.has(record.id),
  );
  const payments = records.filter(
    (record) =>
      active(record) &&
      record.direction === "out" &&
      (isPayPal(record) || isBank(record)) &&
      !alreadyDirect.has(record.id),
  );
  const proposals: Array<{ payment: NormalizedRecord; documents: NormalizedRecord[]; days: number }> = [];
  for (const payment of payments) {
    const candidates = documents
      .filter((document) => {
        const days = reconciliationDateDifference(document, payment);
        return document.amount < payment.amount &&
          (days === undefined || days <= dateTolerance) &&
          counterpartySimilarity(document, payment) >= 0.5;
      })
      .sort((left, right) => (reconciliationDateDifference(left, payment) ?? 99) - (reconciliationDateDifference(right, payment) ?? 99))
      .slice(0, 12);
    const solutions = subsetIndexes(candidates.map((document) => document.amount), payment.amount);
    if (solutions.length !== 1) continue;
    const selected = solutions[0].map((index) => candidates[index]);
    proposals.push({
      payment,
      documents: selected,
      days: Math.max(...selected.map((document) => reconciliationDateDifference(document, payment) ?? 0)),
    });
  }
  const usedDocuments = new Set<string>();
  const usedPayments = new Set<string>();
  const links: MatchLink[] = [];
  for (const proposal of proposals.sort((left, right) => left.days - right.days)) {
    if (usedPayments.has(proposal.payment.id) || proposal.documents.some((document) => usedDocuments.has(document.id))) continue;
    usedPayments.add(proposal.payment.id);
    proposal.documents.forEach((document) => usedDocuments.add(document.id));
    for (const document of proposal.documents) {
      links.push(makeLink(
        document,
        proposal.payment,
        "group-payment",
        99,
        "multiple-documents-single-payment",
        `${proposal.documents.length} Belege ergeben zusammen die Zahlung ${proposal.payment.amount.toFixed(2)} €`,
        true,
      ));
    }
  }
  return links;
}

function deduplicateLinks(links: MatchLink[]): MatchLink[] {
  const map = new Map<string, MatchLink>();
  for (const link of links.sort((left, right) => right.confidence - left.confidence)) {
    const key = pairKey(link.fromId, link.toId, link.type);
    if (!map.has(key)) map.set(key, link);
  }
  return [...map.values()];
}

export function runMatching(records: NormalizedRecord[], dateTolerance = 20, amountTolerance = 0.02): MatchResult {
  tokenCache.clear();
  counterpartyCache.clear();
  const paypalRelated = paypalRelatedLinks(records);
  const contexts = paypalContext(records, paypalRelated);
  const document = documentLinks(records, dateTolerance, amountTolerance, contexts);
  const etsyReviewed = etsyDocumentReviewLinks(records);
  const refundedEtsyReviews = fullyRefundedEtsyInvoiceReviews(records);
  const platformAggregate = documentAggregateLinks(records, dateTolerance);
  const foreignCurrency = foreignCurrencyMerchantLinks(records);
  const providerRefunds = providerRefundLinks(records);
  const providerDocuments = providerDocumentLinks(records, providerRefunds, dateTolerance);
  const baseLinks = [
    ...paypalRelated,
    ...paypalBalanceLinks(records),
    ...paypalBalanceBatchLinks(records),
    ...exactReferenceLinks(records),
    ...platformSettlementLinks(records),
    ...payoutLinks(records),
    ...platformDebitLinks(records),
    ...walletLinks(records),
    ...providerPaymentLinks(records),
    ...providerRefunds,
    ...providerDocuments,
    ...etsyReviewed.links,
    ...creditNoteRefundLinks(records),
    ...internalTransferLinks(records),
    ...bankInternalLinks(records),
    ...platformAggregate,
    ...withheldFeeLinks(records),
    ...foreignCurrency,
    ...document.links,
  ];
  const merchantVariants = acceptedMerchantVariantLinks(records, baseLinks);
  const yearlyExact = uniqueYearlyExactMerchantLinks(records, [...baseLinks, ...merchantVariants]);
  const linksBeforeGroups = [...baseLinks, ...merchantVariants, ...yearlyExact];
  const links = deduplicateLinks([
    ...linksBeforeGroups,
    ...groupedBankPaymentLinks(records, linksBeforeGroups, dateTolerance),
    ...groupedDocumentsToPaymentLinks(records, linksBeforeGroups, dateTolerance),
  ]);
  const linkedPairs = new Set(links.map((link) => pairKey(link.fromId, link.toId, link.type)));
  const adjacency = adjacencyFromLinks(links);
  const candidates = document.candidates.filter(
    (candidate) =>
      !linkedPairs.has(pairKey(candidate.fromId, candidate.toId, candidate.type)) &&
      !connectedIds(candidate.fromId, adjacency).has(candidate.toId),
  );
  return { links, candidates, reviews: [...etsyReviewed.reviews, ...refundedEtsyReviews] };
}

interface ReconciliationState {
  resolved: Set<string>;
  open: Set<string>;
}

export function reconciliationAxes(
  records: NormalizedRecord[],
  links: MatchLink[],
  reviews: RecordReview[] = [],
): Map<string, ReconciliationAxes> {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const reviewsByRecord = new Map<string, RecordReview[]>();
  for (const review of reviews) {
    reviewsByRecord.set(review.recordId, [...(reviewsByRecord.get(review.recordId) ?? []), review]);
  }
  const adjacency = adjacencyFromLinks(links);
  const businessAdjacency = adjacencyFromLinks(
    links.filter((link) => {
      if (["document-order", "platform-evidence", "manual"].includes(link.type)) return true;
      if (link.type !== "group-payment") return false;
      const from = recordMap.get(link.fromId);
      const to = recordMap.get(link.toId);
      return [from, to].some((record) => record?.category === "document-income") &&
        [from, to].some((record) => record && ["order", "order-detail", "sale", "refund"].includes(record.category));
    }),
  );
  const paypalBalances = paypalBalancedCurrencies(records);
  const orderCustomers = new Set(
    records
      .filter((record) => record.category === "order" || record.category === "order-detail")
      .map((record) => canonicalParty(record.counterparty))
      .filter(Boolean),
  );
  const printfulWalletMovement = roundMoney(
    records
      .filter(
        (record) =>
          active(record) &&
          (record.sourceKind === "printful-orders" || record.sourceKind === "printful-wallet"),
      )
      .reduce((sum, record) => {
        if (record.category === "wallet-funding" || record.category === "refund") return sum + record.amount;
        if (record.category === "wallet-charge") return sum - record.amount;
        return sum;
      }, 0),
  );
  const printfulWalletBalanced = Math.abs(printfulWalletMovement) <= 0.02;
  const result = new Map<string, ReconciliationAxes>();

  for (const record of records) {
    if (!isReconciliationRecord(record) && !isPayPal(record)) continue;
    if (!active(record)) {
      result.set(record.id, {
        businessEvidence: "excluded",
        paymentEvidence: "excluded",
        accountEvidence: "excluded",
        businessReason: record.dispositionReason ?? "Von der Abstimmung ausgeschlossen",
        paymentReason: record.dispositionReason ?? "Von der Abstimmung ausgeschlossen",
        accountReason: record.dispositionReason ?? "Von der Abstimmung ausgeschlossen",
      });
      continue;
    }

    const component = [...connectedIds(record.id, adjacency)]
      .map((id) => recordMap.get(id))
      .filter((entry): entry is NormalizedRecord => Boolean(entry));
    const businessComponent = [...connectedIds(record.id, businessAdjacency)]
      .map((id) => recordMap.get(id))
      .filter((entry): entry is NormalizedRecord => Boolean(entry));
    const hasDirectDocument = businessComponent.some((entry) => entry.category === "document-income");
    const hasDirectOrder = businessComponent.some((entry) => entry.category === "order" || entry.category === "order-detail");
    const hasDirectProviderOrder = businessComponent.some((entry) => entry.category === "wallet-charge");
    const hasBank = component.some(isBank);
    const paypalRecords = component.filter(isPayPal);
    const hasPayPal = paypalRecords.length > 0;
    const paypalAccountBalanced = paypalRecords.some((entry) => paypalBalances.get(entry.currency));
    const hasPlatformLedger = component.some(
      (entry) => entry.sourceKind === "etsy-statement" || entry.sourceKind === "ebay-ledger",
    );
    const hasBalancedProviderWallet =
      printfulWalletBalanced &&
      component.some((entry) => entry.sourceKind === "printful-orders" || entry.sourceKind === "printful-wallet");
    const hasPayout = component.some((entry) => entry.category === "payout");
    const hasPaymentAccount = hasBank || hasPayPal || hasPayout || hasBalancedProviderWallet;
    const knownRoyaltyDocument =
      DOCUMENT_CATEGORIES.has(record.category) &&
      ["art heroes", "printler", "redbubble", "europosters", "albin michel"].includes(canonicalParty(record.counterparty));

    let businessEvidence: ReconciliationAxes["businessEvidence"] = "not-applicable";
    let businessReason = "Für diesen Datensatz ist keine Bestellung erforderlich";
    if (DOCUMENT_CATEGORIES.has(record.category)) {
      if (record.category === "tax-payment") {
        businessReason = "Steuerbeleg benötigt keine Plattformbestellung";
      } else if (record.category === "document-expense") {
        const provider = canonicalParty(record.counterparty);
        if (hasDirectProviderOrder) {
          businessEvidence = "confirmed";
          businessReason = "Accountable-Beleg und Anbieterauftrag verbunden";
        } else if (provider === "gelato" || provider === "printful") {
          businessEvidence = "open";
          businessReason = "Gelato-/Printful-Beleg ohne zugehörigen Anbieterauftrag";
        } else {
          businessReason = "Für diese Eingangsrechnung liegt kein separater Bestellexport vor";
        }
      } else if (hasDirectOrder || hasDirectProviderOrder) {
        businessEvidence = "confirmed";
        businessReason = hasDirectOrder ? "Accountable-Beleg und konkrete Bestellung direkt verbunden" : "Accountable-Beleg und Anbieterauftrag direkt verbunden";
      } else if (knownRoyaltyDocument && hasPaymentAccount) {
        businessEvidence = "confirmed";
        businessReason = "Plattformrechnung ohne separaten Bestellexport; Zahlung eindeutig zugeordnet";
      } else if (orderCustomers.has(canonicalParty(record.counterparty))) {
        businessEvidence = "open";
        businessReason = "Kunde ist im Bestellexport vorhanden, aber die konkrete Bestellung ist noch nicht verbunden";
      } else {
        businessReason = "Kein separater Bestell- oder Plattformexport für diesen Beleg vorhanden";
      }
    } else if (record.category === "order") {
      businessEvidence = hasDirectDocument ? "confirmed" : "open";
      businessReason = hasDirectDocument ? "Bestellung und Accountable-Beleg direkt verbunden" : "Kein Accountable-Beleg direkt verbunden";
    }

    let paymentEvidence: ReconciliationAxes["paymentEvidence"] = "not-applicable";
    let paymentReason = "Für diesen Datensatz wird kein eigener Zahlungsnachweis erwartet";
    if (DOCUMENT_CATEGORIES.has(record.category) || record.category === "order") {
      paymentEvidence = hasPaymentAccount || hasPlatformLedger ? "confirmed" : "open";
      paymentReason = paymentEvidence === "confirmed"
        ? hasBank ? "Zahlungsweg erreicht FYRST oder N26"
            : hasPayPal ? "Zahlung im PayPal-Zwischenkonto nachgewiesen"
              : hasBalancedProviderWallet ? "Über das vollständig abgestimmte Printful-Wallet nachgewiesen"
            : "Im Plattform-Zahlungskonto nachgewiesen"
        : "Noch kein Zahlungs- oder Plattformkonto erreicht";
    } else if (isBank(record) || isPayPal(record)) {
      paymentEvidence = component.length > 1 ? "confirmed" : "open";
      paymentReason = component.length > 1 ? "Mit einem Geschäftsvorfall oder Gegenkonto verbunden" : "Noch ohne Gegenbeleg";
    }

    const accountConfirmed = hasBank || paypalAccountBalanced || hasPlatformLedger || hasBalancedProviderWallet;
    let accountEvidence: ReconciliationAxes["accountEvidence"] = "not-applicable";
    let accountReason = "Kein Zahlungskonto betroffen";
    if (DOCUMENT_CATEGORIES.has(record.category) || record.category === "order" || isBank(record) || isPayPal(record)) {
      accountEvidence = accountConfirmed ? "confirmed" : "open";
      accountReason = accountEvidence === "confirmed"
        ? hasBank ? "Kette erreicht FYRST oder N26"
          : paypalAccountBalanced ? "PayPal-Konto ist über den laufenden Guthabenstand abgestimmt"
            : hasBalancedProviderWallet ? "Printful-Wallet geht aus Zuführungen, Aufträgen und Erstattungen centgenau auf"
            : "Plattformbewegung ist im Etsy-/eBay-Unterkonto fortgeschrieben"
        : "Zahlungskonto oder Jahresendbestand noch nicht erklärt";
    }

    if (record.disposition === "resolved") {
      businessEvidence = businessEvidence === "open" ? "confirmed" : businessEvidence;
      paymentEvidence = paymentEvidence === "open" ? "confirmed" : paymentEvidence;
      accountEvidence = accountEvidence === "open" ? "confirmed" : accountEvidence;
    }
    const recordReviews = reviewsByRecord.get(record.id) ?? [];
    const dataError = recordReviews.find((review) => review.status === "data-error");
    const manualCleared = recordReviews.find((review) => review.status === "manual-cleared");
    if (dataError) {
      businessEvidence = "open";
      businessReason = dataError.note;
    }
    if (manualCleared) {
      if (businessEvidence === "open") businessEvidence = "confirmed";
      if (paymentEvidence === "open") paymentEvidence = "confirmed";
      if (accountEvidence === "open") accountEvidence = "confirmed";
      businessReason = `Manuell geklärt: ${manualCleared.note}`;
      paymentReason = `Manuell geklärt: ${manualCleared.note}`;
      accountReason = `Manuell geklärt: ${manualCleared.note}`;
    }
    result.set(record.id, {
      businessEvidence,
      paymentEvidence,
      accountEvidence,
      businessReason,
      paymentReason,
      accountReason,
    });
  }
  return result;
}

export function reconciliationState(
  records: NormalizedRecord[],
  links: MatchLink[],
  reviews: RecordReview[] = [],
): ReconciliationState {
  const axes = reconciliationAxes(records, links, reviews);
  const resolved = new Set<string>();
  const open = new Set<string>();
  for (const record of records) {
    if (!isReconciliationRecord(record)) continue;
    const recordAxes = axes.get(record.id);
    let isResolved =
      recordAxes?.paymentEvidence === "confirmed" &&
      recordAxes.accountEvidence === "confirmed" &&
      recordAxes.businessEvidence !== "open";
    (isResolved ? resolved : open).add(record.id);
  }
  return { resolved, open };
}

export function effectiveRecordReviews(reviews: RecordReview[]): Map<string, RecordReview> {
  const result = new Map<string, RecordReview>();
  for (const review of reviews) {
    const current = result.get(review.recordId);
    if (
      !current ||
      (!review.automatic && current.automatic) ||
      (review.automatic === current.automatic && review.updatedAt > current.updatedAt)
    ) {
      result.set(review.recordId, review);
    }
  }
  return result;
}

export function coverageSummary(
  records: NormalizedRecord[],
  links: MatchLink[],
  reviews: RecordReview[] = [],
): CoverageSummary {
  const state = reconciliationState(records, links, reviews);
  const axes = reconciliationAxes(records, links, reviews);
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const adjacency = adjacencyFromLinks(links);
  const documents = records.filter((record) => DOCUMENT_CATEGORIES.has(record.category) && isReconciliationRecord(record));
  const payments = records.filter((record) => isBank(record) && record.category !== "unknown" && isReconciliationRecord(record));
  const paypal = records.filter((record) => isPayPal(record) && active(record) && record.category !== "unknown");
  const orders = records.filter((record) => record.category === "order");
  const includedOrders = orders.filter(isReconciliationRecord);
  const resolvedDocuments = documents.filter((record) => state.resolved.has(record.id)).length;
  const confirmedBusiness = documents.filter((record) => {
    const evidence = axes.get(record.id)?.businessEvidence;
    return evidence === "confirmed" || evidence === "not-applicable";
  }).length;
  const confirmedPayments = documents.filter((record) => axes.get(record.id)?.paymentEvidence === "confirmed").length;
  const confirmedAccounts = documents.filter((record) => axes.get(record.id)?.accountEvidence === "confirmed").length;
  const resolvedPayments = payments.filter((record) => state.resolved.has(record.id)).length;
  const resolvedBridges = paypal.filter((record) => {
    if (record.disposition === "resolved") return true;
    return [...connectedIds(record.id, adjacency)]
      .map((id) => recordMap.get(id))
      .some((entry) => entry && isBank(entry));
  }).length;
  const excludedOrders = orders.length - includedOrders.length;
  const resolvedOrders = includedOrders.filter((record) => state.resolved.has(record.id)).length;
  const effectiveReviews = effectiveRecordReviews(reviews);
  const manualClearedIds = new Set([...effectiveReviews.values()].filter((review) => review.status === "manual-cleared").map((review) => review.recordId));
  const annotatedOpenIds = new Set([...effectiveReviews.values()].filter((review) => review.status === "open-note").map((review) => review.recordId));
  const warningIds = new Set([...effectiveReviews.values()].filter((review) => review.status === "warning").map((review) => review.recordId));
  const dataErrorIds = new Set([...effectiveReviews.values()].filter((review) => review.status === "data-error").map((review) => review.recordId));
  const exceptionIds = new Set(state.open);
  for (const review of effectiveReviews.values()) {
    if (review.status !== "manual-cleared") exceptionIds.add(review.recordId);
    else exceptionIds.delete(review.recordId);
  }
  return {
    documents: { total: documents.length, resolved: resolvedDocuments, open: documents.length - resolvedDocuments },
    documentEvidence: { total: documents.length, resolved: confirmedBusiness, open: documents.length - confirmedBusiness },
    paymentEvidence: { total: documents.length, resolved: confirmedPayments, open: documents.length - confirmedPayments },
    accountEvidence: { total: documents.length, resolved: confirmedAccounts, open: documents.length - confirmedAccounts },
    payments: { total: payments.length, resolved: resolvedPayments, open: payments.length - resolvedPayments },
    bridges: { total: paypal.length, resolved: resolvedBridges, open: paypal.length - resolvedBridges },
    orders: { total: orders.length, resolved: resolvedOrders, excluded: excludedOrders, open: Math.max(0, includedOrders.length - resolvedOrders) },
    reviews: {
      manualCleared: manualClearedIds.size,
      annotatedOpen: annotatedOpenIds.size,
      warnings: warningIds.size,
      dataErrors: dataErrorIds.size,
    },
    exceptions: exceptionIds.size,
  };
}

export function manualLink(records: NormalizedRecord[], ids: string[]): MatchLink[] {
  const selected = ids.map((id) => records.find((record) => record.id === id)).filter((record): record is NormalizedRecord => Boolean(record));
  if (selected.length < 2) return [];
  const anchor = selected[0];
  return selected.slice(1).map((record) => makeLink(anchor, record, "manual", 100, "manual-confirmation", "Vom Nutzer manuell verbunden", false));
}
