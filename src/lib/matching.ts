import type {
  CoverageSummary,
  MatchCandidate,
  MatchLink,
  MatchResult,
  NormalizedRecord,
  ReconciliationAxes,
  RecordCategory,
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
  const result = normalizedNameTokens(record.counterparty);
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
  const incomeTargets = allIncomeTargets.filter(
    (record) =>
      record.category !== "order-detail" ||
      !primaryOrderKeys.has(`${normalizeText(record.shop)}|${record.reference}`),
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
  return { links, candidates };
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
  const possible: Array<{ document: NormalizedRecord; charge: NormalizedRecord; days: number }> = [];
  for (const document of documents) {
    for (const charge of charges) {
      if (canonicalParty(document.counterparty) !== canonicalParty(charge.counterparty)) continue;
      if (closestAmountDifference(document, charge) > 0.02) continue;
      const days = reconciliationDateDifference(document, charge) ?? 999;
      if (days > dateTolerance) continue;
      possible.push({ document, charge, days });
    }
  }
  const usedDocuments = new Set<string>();
  const usedCharges = new Set<string>();
  return possible
    .sort((left, right) => left.days - right.days || left.document.sourceRow - right.document.sourceRow || left.charge.sourceRow - right.charge.sourceRow)
    .filter((candidate) => {
      if (usedDocuments.has(candidate.document.id) || usedCharges.has(candidate.charge.id)) return false;
      usedDocuments.add(candidate.document.id);
      usedCharges.add(candidate.charge.id);
      return true;
    })
    .map((candidate) =>
      makeLink(
        candidate.document,
        candidate.charge,
        "document-order",
        99,
        "provider-document-order",
        `${candidate.charge.counterparty}-Beleg und Anbieterauftrag centgenau · ${candidate.days} Tage Abstand`,
        true,
      ),
    );
}

function internalTransferLinks(records: NormalizedRecord[]): MatchLink[] {
  const cash = records.filter(
    (record) => active(record) && (isBank(record) || isPayPal(record)) && (CASH_CATEGORIES.has(record.category) || record.category === "cash-movement"),
  );
  const candidates: Array<{ left: NormalizedRecord; right: NormalizedRecord; days: number; score: number }> = [];
  for (let leftIndex = 0; leftIndex < cash.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cash.length; rightIndex += 1) {
      const left = cash[leftIndex];
      const right = cash[rightIndex];
      if (left.sourceKind === right.sourceKind || left.direction === "neutral" || right.direction === "neutral") continue;
      if (!(isPayPal(left) || isPayPal(right)) || closestAmountDifference(left, right) > 0.02) continue;
      const days = dateDifferenceDays(left.date, right.date) ?? 0;
      if (days > 5) continue;
      const text = normalizeText(`${left.counterparty} ${left.description} ${right.counterparty} ${right.description}`);
      const explicitTransfer = left.category === "transfer" || right.category === "transfer";
      const namedPayPal = text.includes("paypal");
      if (left.direction === right.direction && !namedPayPal) continue;
      if (left.direction !== right.direction && !explicitTransfer && !namedPayPal) continue;
      candidates.push({
        left,
        right,
        days,
        score: (left.direction !== right.direction && explicitTransfer ? 20 : 0) + (left.direction === right.direction ? 10 : 0) - days,
      });
    }
  }
  const byRecord = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    byRecord.set(candidate.left.id, [...(byRecord.get(candidate.left.id) ?? []), candidate]);
    byRecord.set(candidate.right.id, [...(byRecord.get(candidate.right.id) ?? []), candidate]);
  }
  const bestFor = (recordId: string) => {
    const sorted = [...(byRecord.get(recordId) ?? [])].sort((left, right) => right.score - left.score || left.days - right.days);
    if (!sorted.length || (sorted[1] && sorted[1].score === sorted[0].score && sorted[1].days === sorted[0].days)) return undefined;
    return sorted[0];
  };
  const links: MatchLink[] = [];
  for (const candidate of candidates) {
    if (bestFor(candidate.left.id) !== candidate || bestFor(candidate.right.id) !== candidate) continue;
    const sameDirection = candidate.left.direction === candidate.right.direction;
    links.push(
      makeLink(
        candidate.left,
        candidate.right,
        "paypal-bank-bridge",
        sameDirection ? 94 : 98,
        sameDirection ? "paypal-bank-same-payment" : "paypal-bank-countermovement",
        sameDirection ? "PayPal-Händlerzahlung und identische Bankbuchung" : "PayPal-Kontobewegung und gleich hoher Bankgegenlauf",
        true,
      ),
    );
  }
  return links;
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
        return days === undefined || days <= dateTolerance;
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
    (entry) => active(entry) && entry.date && (entry.category === "fee" || (entry.sourceKind === "ebay-ledger" && entry.category === "sale" && (entry.feeAmount ?? 0) > 0)),
  )) {
    const platform = record.sourceKind === "etsy-statement" ? "etsy" : record.sourceKind === "ebay-ledger" ? "ebay" : "";
    if (!platform) continue;
    if (platform === "etsy" && normalizeText(record.description).includes("sales tax paid by buyer")) continue;
    const key = `${platform}|${normalizeText(record.shop)}|${record.date!.slice(0, 7)}`;
    feeGroups.set(key, [...(feeGroups.get(key) ?? []), record]);
  }
  const links: MatchLink[] = [];
  const proposals = new Map<string, Array<{ document: NormalizedRecord; group: NormalizedRecord[] }>>();
  const documents = records.filter(
    (record) => active(record) && record.category === "document-expense" && /etsy|ebay/.test(normalizeText(record.counterparty)),
  );
  for (const document of documents) {
    const platform = normalizeText(document.counterparty).includes("etsy") ? "etsy" : "ebay";
    const matches = [...feeGroups.entries()]
      .filter(([key]) => key.startsWith(`${platform}|`))
      .map(([, group]) => ({
        group,
        total: roundMoney(group.reduce((sum, record) => sum + (record.category === "sale" ? record.feeAmount ?? 0 : record.amount), 0)),
        days: Math.min(...group.map((record) => dateDifferenceDays(document.date, record.date) ?? 0)),
      }))
      .filter((entry) => Math.abs(entry.total - document.amount) <= 0.02 && entry.days <= 45);
    if (matches.length !== 1) continue;
    const groupKey = matches[0].group.map((record) => record.id).sort().join("|");
    proposals.set(groupKey, [...(proposals.get(groupKey) ?? []), { document, group: matches[0].group }]);
  }
  for (const options of proposals.values()) {
    if (options.length !== 1) continue;
    for (const fee of options[0].group) {
      links.push(
        makeLink(
          options[0].document,
          fee,
          "group-payment",
          99,
          "platform-withheld-fees",
          "Einbehaltene Plattformgebühren ergeben zusammen den Accountable-Beleg",
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
    ...walletLinks(records),
    ...providerPaymentLinks(records),
    ...providerRefunds,
    ...providerDocuments,
    ...internalTransferLinks(records),
    ...bankInternalLinks(records),
    ...platformAggregate,
    ...withheldFeeLinks(records),
    ...foreignCurrency,
    ...document.links,
  ];
  const merchantVariants = acceptedMerchantVariantLinks(records, baseLinks);
  const yearlyExact = uniqueYearlyExactMerchantLinks(records, [...baseLinks, ...merchantVariants]);
  const links = deduplicateLinks([...baseLinks, ...merchantVariants, ...yearlyExact, ...groupedBankPaymentLinks(records, baseLinks, dateTolerance)]);
  const linkedPairs = new Set(links.map((link) => pairKey(link.fromId, link.toId, link.type)));
  const candidates = document.candidates.filter((candidate) => !linkedPairs.has(pairKey(candidate.fromId, candidate.toId, candidate.type)));
  return { links, candidates };
}

interface ReconciliationState {
  resolved: Set<string>;
  open: Set<string>;
}

export function reconciliationAxes(records: NormalizedRecord[], links: MatchLink[]): Map<string, ReconciliationAxes> {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const adjacency = adjacencyFromLinks(links);
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
    const hasDocument = component.some((entry) => DOCUMENT_CATEGORIES.has(entry.category));
    const hasOrder = component.some((entry) => entry.category === "order" || entry.category === "order-detail");
    const hasProviderOrder = component.some((entry) => entry.category === "wallet-charge");
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
        if (hasProviderOrder) {
          businessEvidence = "confirmed";
          businessReason = "Accountable-Beleg und Anbieterauftrag verbunden";
        } else if (provider === "gelato" || provider === "printful") {
          businessEvidence = "open";
          businessReason = "Gelato-/Printful-Beleg ohne zugehörigen Anbieterauftrag";
        } else {
          businessReason = "Für diese Eingangsrechnung liegt kein separater Bestellexport vor";
        }
      } else if (hasOrder || hasProviderOrder) {
        businessEvidence = "confirmed";
        businessReason = hasOrder ? "Accountable-Beleg und Bestellung verbunden" : "Accountable-Beleg und Anbieterauftrag verbunden";
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
      businessEvidence = hasDocument ? "confirmed" : "open";
      businessReason = hasDocument ? "Bestellung und Accountable-Beleg verbunden" : "Kein Accountable-Beleg verbunden";
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

export function reconciliationState(records: NormalizedRecord[], links: MatchLink[]): ReconciliationState {
  const axes = reconciliationAxes(records, links);
  const resolved = new Set<string>();
  const open = new Set<string>();
  for (const record of records) {
    if (!isReconciliationRecord(record)) continue;
    const recordAxes = axes.get(record.id);
    let isResolved =
      recordAxes?.paymentEvidence === "confirmed" &&
      recordAxes.accountEvidence === "confirmed";
    if (record.category === "order") {
      isResolved = isResolved && recordAxes?.businessEvidence === "confirmed";
    }
    (isResolved ? resolved : open).add(record.id);
  }
  return { resolved, open };
}

export function coverageSummary(records: NormalizedRecord[], links: MatchLink[]): CoverageSummary {
  const state = reconciliationState(records, links);
  const axes = reconciliationAxes(records, links);
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
  const exceptions = documents.length - resolvedDocuments + payments.length - resolvedPayments + includedOrders.length - resolvedOrders;
  return {
    documents: { total: documents.length, resolved: resolvedDocuments, open: documents.length - resolvedDocuments },
    documentEvidence: { total: documents.length, resolved: confirmedBusiness, open: documents.length - confirmedBusiness },
    paymentEvidence: { total: documents.length, resolved: confirmedPayments, open: documents.length - confirmedPayments },
    accountEvidence: { total: documents.length, resolved: confirmedAccounts, open: documents.length - confirmedAccounts },
    payments: { total: payments.length, resolved: resolvedPayments, open: payments.length - resolvedPayments },
    bridges: { total: paypal.length, resolved: resolvedBridges, open: paypal.length - resolvedBridges },
    orders: { total: orders.length, resolved: resolvedOrders, excluded: excludedOrders, open: Math.max(0, includedOrders.length - resolvedOrders) },
    exceptions: Math.max(0, exceptions),
  };
}

export function manualLink(records: NormalizedRecord[], ids: string[]): MatchLink[] {
  const selected = ids.map((id) => records.find((record) => record.id === id)).filter((record): record is NormalizedRecord => Boolean(record));
  if (selected.length < 2) return [];
  const anchor = selected[0];
  return selected.slice(1).map((record) => makeLink(anchor, record, "manual", 100, "manual-confirmation", "Vom Nutzer manuell verbunden", false));
}
