import type {
  CoverageSummary,
  MatchCandidate,
  MatchLink,
  MatchResult,
  NormalizedRecord,
  RecordCategory,
} from "../types";
import { dateDifferenceDays, makeId, normalizeText, referenceTokens, roundMoney } from "./normalize";

const DOCUMENT_CATEGORIES = new Set<RecordCategory>(["document-expense", "document-income", "tax-payment"]);
const ORDER_CATEGORIES = new Set<RecordCategory>(["order", "sale"]);
const CASH_CATEGORIES = new Set<RecordCategory>(["cash-movement", "transfer"]);
const PAYMENT_EVIDENCE_CATEGORIES = new Set<RecordCategory>([
  "cash-movement",
  "transfer",
  "wallet-charge",
  "wallet-funding",
  "fee",
  "refund",
]);

export function isReconciliationRecord(record: NormalizedRecord): boolean {
  const excluded = record.disposition === "ignored" || record.disposition === "private" || record.disposition === "test";
  if (excluded) return false;
  if (DOCUMENT_CATEGORIES.has(record.category) || record.category === "order") return true;
  return (
    (record.sourceKind === "bank-fyrst" || record.sourceKind === "bank-n26" || record.sourceKind === "paypal-business") &&
    record.category !== "unknown"
  );
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

function counterpartyTokens(record: NormalizedRecord): Set<string> {
  const cached = counterpartyCache.get(record.id);
  if (cached) return cached;
  const result = new Set(
    normalizeText(record.counterparty)
      .split(/\W+/)
      .filter((token) => token.length > 2),
  );
  counterpartyCache.set(record.id, result);
  return result;
}

function counterpartySimilarity(left: NormalizedRecord, right: NormalizedRecord): number {
  const leftTokens = counterpartyTokens(left);
  const rightTokens = counterpartyTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
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
    dateDifference: dateDifferenceDays(from.date, to.date),
    rule,
    reason,
    automatic,
  };
}

function compatibleDocumentTarget(document: NormalizedRecord, target: NormalizedRecord): boolean {
  if (!active(target) || document.sourceId === target.sourceId || document.direction !== target.direction) return false;
  if (document.category === "document-income") return ORDER_CATEGORIES.has(target.category) || CASH_CATEGORIES.has(target.category);
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

function scoreDocumentTarget(document: NormalizedRecord, target: NormalizedRecord, dateTolerance: number, amountTolerance: number): ScoredPair | undefined {
  if (!compatibleDocumentTarget(document, target)) return undefined;
  const difference = closestAmountDifference(document, target);
  const days = dateDifferenceDays(document.date, target.date);
  const reference = sharedReference(document, target);
  const nameSimilarity = counterpartySimilarity(document, target);
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
  } else if (difference <= 5 && (reference || nameSimilarity >= 0.25)) {
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

  if (nameSimilarity >= 0.67) {
    score += 30;
    reason.push("Gegenpartei sehr ähnlich");
  } else if (nameSimilarity >= 0.3) {
    score += 16;
    reason.push("Gegenpartei teilweise ähnlich");
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
  }

  return { score, reason, target, reference, difference, days };
}

function documentLinks(records: NormalizedRecord[], dateTolerance: number, amountTolerance: number): MatchResult {
  const links: MatchLink[] = [];
  const candidates: MatchCandidate[] = [];
  const documents = records.filter((record) => DOCUMENT_CATEGORIES.has(record.category) && active(record));
  const incomeTargets = records.filter(
    (record) =>
      active(record) &&
      record.direction === "in" &&
      (ORDER_CATEGORIES.has(record.category) || CASH_CATEGORIES.has(record.category)),
  );
  const outgoingTargets = records.filter(
    (record) => active(record) && record.direction === "out" && PAYMENT_EVIDENCE_CATEGORIES.has(record.category),
  );

  for (const document of documents) {
    const targets = document.category === "document-income" ? incomeTargets : outgoingTargets;
    const scored = targets
      .map((target) => scoreDocumentTarget(document, target, dateTolerance, amountTolerance))
      .filter((entry): entry is ScoredPair => Boolean(entry))
      .sort((left, right) => right.score - left.score || left.difference - right.difference);

    const families = new Map<string, ScoredPair[]>();
    for (const pair of scored) {
      const family = ORDER_CATEGORIES.has(pair.target.category) ? "order" : "payment";
      families.set(family, [...(families.get(family) ?? []), pair]);
    }

    for (const [family, familyPairs] of families) {
      const best = familyPairs[0];
      const type: MatchLink["type"] = family === "order" ? "document-order" : "document-payment";
      const reason = best.reason.join(" · ");
      if (best.score >= 82) {
        links.push(makeLink(document, best.target, type, best.score, "document-best-match", reason, true));
      } else if (best.score >= 55) {
        candidates.push({
          ...makeLink(document, best.target, type, best.score, "document-candidate", reason, false),
          automatic: false,
        });
      }
    }
  }

  return { links, candidates };
}

function exactReferenceLinks(records: NormalizedRecord[]): MatchLink[] {
  const links: MatchLink[] = [];
  const evidence = records.filter((record) => active(record) && (ORDER_CATEGORIES.has(record.category) || record.category === "sale"));
  const index = new Map<string, NormalizedRecord[]>();
  for (const record of evidence) {
    for (const token of tokens(record)) index.set(token, [...(index.get(token) ?? []), record]);
  }
  const seen = new Set<string>();
  for (const [reference, matches] of index) {
    if (matches.length > 50) continue;
    for (let leftIndex = 0; leftIndex < matches.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex += 1) {
        const left = matches[leftIndex];
        const right = matches[rightIndex];
      if (left.sourceId === right.sourceId || left.sourceKind === right.sourceKind) continue;
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
  const bankIncoming = records.filter(
    (record) => active(record) && record.category === "cash-movement" && record.direction === "in",
  );
  const byAmount = new Map<number, NormalizedRecord[]>();
  for (const bank of bankIncoming) {
    for (const amount of amountVariants(bank)) {
      const cents = Math.round(amount * 100);
      byAmount.set(cents, [...(byAmount.get(cents) ?? []), bank]);
    }
  }
  const links: MatchLink[] = [];
  for (const payout of payouts) {
    const possible = Array.from(
      new Set(
        amountVariants(payout).flatMap((amount) => byAmount.get(Math.round(amount * 100)) ?? []),
      ),
    );
    const matches = possible
      .filter((bank) => closestAmountDifference(payout, bank) <= 0.02)
      .map((bank) => ({ bank, days: dateDifferenceDays(payout.date, bank.date) }))
      .filter((entry) => entry.days === undefined || entry.days <= 7)
      .sort((left, right) => (left.days ?? 99) - (right.days ?? 99));
    if (!matches.length) continue;
    const best = matches[0];
    links.push(
      makeLink(
        payout,
        best.bank,
        "payout-bank",
        98,
        "payout-exact-bank",
        `Auszahlung und Bankgutschrift centgenau · ${best.days ?? "?"} Tage Abstand`,
        true,
      ),
    );
  }
  return links;
}

function walletLinks(records: NormalizedRecord[]): MatchLink[] {
  const walletFunding = records.filter((record) => active(record) && record.category === "wallet-funding");
  const paypalOutgoing = records.filter(
    (record) => active(record) && record.sourceKind === "paypal-business" && record.direction === "out",
  );
  const links: MatchLink[] = [];
  for (const funding of walletFunding) {
    const matches = paypalOutgoing
      .filter((paypal) => closestAmountDifference(funding, paypal) <= 0.02)
      .map((paypal) => ({ paypal, days: dateDifferenceDays(funding.date, paypal.date) }))
      .filter((entry) => entry.days === undefined || entry.days <= 3)
      .sort((left, right) => (left.days ?? 99) - (right.days ?? 99));
    if (!matches.length) continue;
    links.push(makeLink(funding, matches[0].paypal, "wallet-bridge", 97, "printful-wallet-paypal", "Printful-Geldbörse und PayPal-Belastung centgenau", true));
  }
  return links;
}

function internalTransferLinks(records: NormalizedRecord[]): MatchLink[] {
  const cash = records.filter(
    (record) =>
      active(record) &&
      (record.sourceKind === "bank-fyrst" || record.sourceKind === "bank-n26" || record.sourceKind === "paypal-business") &&
      (CASH_CATEGORIES.has(record.category) || record.category === "cash-movement"),
  );
  const links: MatchLink[] = [];
  for (let leftIndex = 0; leftIndex < cash.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < cash.length; rightIndex += 1) {
      const left = cash[leftIndex];
      const right = cash[rightIndex];
      if (left.sourceKind === right.sourceKind || left.direction === right.direction || left.direction === "neutral" || right.direction === "neutral") continue;
      if (closestAmountDifference(left, right) > 0.02) continue;
      const days = dateDifferenceDays(left.date, right.date);
      if (typeof days === "number" && days > 3) continue;
      const text = normalizeText(`${left.counterparty} ${left.description} ${right.counterparty} ${right.description}`);
      const explicitTransfer = left.category === "transfer" || right.category === "transfer";
      const namedAccount = /paypal|n26|eigenubertrag|umbuchung/.test(text);
      if (!explicitTransfer && !namedAccount) continue;
      links.push(makeLink(left, right, "internal-transfer", 96, "cash-countermovement", "Gleich hoher Gegenlauf zwischen eigenen Zahlungswegen", true));
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
  const document = documentLinks(records, dateTolerance, amountTolerance);
  const links = deduplicateLinks([
    ...exactReferenceLinks(records),
    ...payoutLinks(records),
    ...walletLinks(records),
    ...internalTransferLinks(records),
    ...document.links,
  ]);
  const linkedPairs = new Set(links.map((link) => pairKey(link.fromId, link.toId, link.type)));
  const candidates = document.candidates.filter(
    (candidate) => !linkedPairs.has(pairKey(candidate.fromId, candidate.toId, candidate.type)),
  );
  return { links, candidates };
}

export function coverageSummary(records: NormalizedRecord[], links: MatchLink[]): CoverageSummary {
  const linked = new Set(links.filter((link) => !link.rejected).flatMap((link) => [link.fromId, link.toId]));
  const documents = records.filter((record) => DOCUMENT_CATEGORIES.has(record.category) && isReconciliationRecord(record));
  const payments = records.filter(
    (record) =>
      (record.sourceKind === "bank-fyrst" || record.sourceKind === "bank-n26" || record.sourceKind === "paypal-business") &&
      record.category !== "unknown" &&
      isReconciliationRecord(record),
  );
  const orders = records.filter((record) => record.category === "order");
  const includedOrders = orders.filter(isReconciliationRecord);
  const resolvedDocuments = documents.filter((record) => linked.has(record.id) || record.disposition === "resolved").length;
  const resolvedPayments = payments.filter((record) => linked.has(record.id) || record.disposition === "resolved").length;
  const excludedOrders = orders.length - includedOrders.length;
  const resolvedOrders = includedOrders.filter((record) => linked.has(record.id) || record.disposition === "resolved").length;
  const exceptions =
    documents.length - resolvedDocuments +
    payments.length - resolvedPayments +
    orders.length - excludedOrders - resolvedOrders;
  return {
    documents: { total: documents.length, resolved: resolvedDocuments, open: documents.length - resolvedDocuments },
    payments: { total: payments.length, resolved: resolvedPayments, open: payments.length - resolvedPayments },
    orders: {
      total: orders.length,
      resolved: resolvedOrders,
      excluded: excludedOrders,
      open: Math.max(0, includedOrders.length - resolvedOrders),
    },
    exceptions: Math.max(0, exceptions),
  };
}

export function manualLink(records: NormalizedRecord[], ids: string[]): MatchLink[] {
  const selected = ids.map((id) => records.find((record) => record.id === id)).filter((record): record is NormalizedRecord => Boolean(record));
  if (selected.length < 2) return [];
  const anchor = selected[0];
  return selected.slice(1).map((record) =>
    makeLink(anchor, record, "manual", 100, "manual-confirmation", "Vom Nutzer manuell verbunden", false),
  );
}
