import type {
  MatchLink,
  NormalizedRecord,
  PlatformPeriodSummary,
  SettlementBatch,
} from "../types";
import { makeId, normalizeText, roundMoney } from "./normalize";

interface PeriodAccumulator {
  account: string;
  period: string;
  currency: string;
  inflows: number;
  sellerRevenue: number;
  marketplaceTax: number;
  fees: number;
  refunds: number;
  charges: number;
  payouts: number;
  movement: number;
  paypalRows: NormalizedRecord[];
  note: string;
  kind: "paypal" | "etsy" | "provider" | "marketplace" | "royalty";
}

const ROYALTY_ACCOUNTS: Array<{ label: string; patterns: string[] }> = [
  { label: "Art Heroes", patterns: ["art heroes", "werk aan de muur", "we make it work"] },
  { label: "Printler", patterns: ["printler"] },
  { label: "Redbubble", patterns: ["redbubble"] },
  { label: "Europosters", patterns: ["europosters"] },
  { label: "Albin Michel", patterns: ["albin michel", "editions albin michel"] },
];

function royaltyAccount(value: string): string | undefined {
  const normalized = normalizeText(value);
  return ROYALTY_ACCOUNTS.find((entry) => entry.patterns.some((pattern) => normalized.includes(pattern)))?.label;
}

function signedPayPalNet(record: NormalizedRecord): number {
  const net = Number(record.metadata.net);
  if (Number.isFinite(net)) return roundMoney(net);
  if (record.direction === "in") return record.settlementAmount ?? record.amount;
  if (record.direction === "out") return -(record.settlementAmount ?? record.amount);
  return 0;
}

function createAccumulator(
  account: string,
  period: string,
  currency: string,
  kind: PeriodAccumulator["kind"],
  note: string,
): PeriodAccumulator {
  return {
    account,
    period,
    currency,
    inflows: 0,
    sellerRevenue: 0,
    marketplaceTax: 0,
    fees: 0,
    refunds: 0,
    charges: 0,
    payouts: 0,
    movement: 0,
    paypalRows: [],
    note,
    kind,
  };
}

function accumulator(
  map: Map<string, PeriodAccumulator>,
  account: string,
  period: string,
  currency: string,
  kind: PeriodAccumulator["kind"],
  note: string,
): PeriodAccumulator {
  const key = `${account}|${period}|${currency}`;
  const current = map.get(key) ?? createAccumulator(account, period, currency, kind, note);
  map.set(key, current);
  return current;
}

function periods(record: NormalizedRecord, year: number): string[] {
  if (!record.date || !record.date.startsWith(`${year}-`)) return [];
  return [record.date.slice(0, 7), String(year)];
}

function addPayPal(acc: PeriodAccumulator, record: NormalizedRecord): void {
  const movement = signedPayPalNet(record);
  acc.movement = roundMoney(acc.movement + movement);
  acc.paypalRows.push(record);
  const description = normalizeText(record.description);
  if (record.category === "transfer" && record.direction === "out" && description.includes("abbuchung")) {
    acc.payouts = roundMoney(acc.payouts + Math.abs(movement));
  } else if (movement >= 0) {
    acc.inflows = roundMoney(acc.inflows + record.amount);
    acc.fees = roundMoney(acc.fees + (record.feeAmount ?? 0));
  } else {
    acc.charges = roundMoney(acc.charges + Math.abs(movement));
  }
}

function addEtsy(acc: PeriodAccumulator, record: NormalizedRecord): void {
  if (record.category === "sale") acc.inflows = roundMoney(acc.inflows + record.amount);
  if (record.category === "refund") acc.refunds = roundMoney(acc.refunds + record.amount);
  if (record.category === "payout") acc.payouts = roundMoney(acc.payouts + record.amount);
  if (record.category === "fee") {
    if (record.metadata.marketplaceTax === true || normalizeText(record.description).includes("sales tax paid by buyer")) {
      acc.marketplaceTax = roundMoney(acc.marketplaceTax + record.amount);
    } else {
      acc.fees = roundMoney(acc.fees + record.amount);
    }
  }
  const contribution = record.category === "payout"
    ? -record.amount
    : Number(record.metadata.payoutContribution ?? 0);
  if (Number.isFinite(contribution)) acc.movement = roundMoney(acc.movement + contribution);
}

function addProvider(acc: PeriodAccumulator, record: NormalizedRecord): void {
  if (record.category === "wallet-charge") acc.charges = roundMoney(acc.charges + record.amount);
  if (record.category === "wallet-funding") acc.inflows = roundMoney(acc.inflows + record.amount);
  if (record.category === "refund") acc.refunds = roundMoney(acc.refunds + record.amount);
  acc.movement = roundMoney(acc.inflows + acc.refunds - acc.charges);
}

function addMarketplace(acc: PeriodAccumulator, record: NormalizedRecord): void {
  if (record.category === "order" || record.category === "sale") {
    acc.sellerRevenue = roundMoney(acc.sellerRevenue + record.amount);
  }
  if (record.category === "fee") acc.fees = roundMoney(acc.fees + record.amount);
  if (record.category === "refund") acc.refunds = roundMoney(acc.refunds + record.amount);
  if (record.category === "payout") acc.payouts = roundMoney(acc.payouts + record.amount);
  acc.movement = roundMoney(acc.sellerRevenue - acc.fees - acc.refunds - acc.payouts);
}

function addRoyalty(acc: PeriodAccumulator, record: NormalizedRecord): void {
  if (record.category === "document-income") acc.sellerRevenue = roundMoney(acc.sellerRevenue + record.amount);
  if (record.sourceKind === "paypal-business" && record.direction === "in") {
    acc.inflows = roundMoney(acc.inflows + (record.settlementAmount ?? record.amount));
    acc.fees = roundMoney(acc.fees + (record.feeAmount ?? 0));
  }
  if (record.sourceKind === "bank-fyrst" && record.direction === "in") acc.inflows = roundMoney(acc.inflows + record.amount);
  acc.movement = roundMoney(acc.sellerRevenue - acc.inflows - acc.fees);
}

function paypalBalances(rows: NormalizedRecord[]): {
  opening?: number;
  calculated?: number;
  reported?: number;
  residual?: number;
} {
  const sorted = [...rows].sort(
    (left, right) =>
      (left.date ?? "").localeCompare(right.date ?? "") ||
      String(left.metadata.time ?? "").localeCompare(String(right.metadata.time ?? "")) ||
      left.sourceRow - right.sourceRow,
  );
  if (!sorted.length) return {};
  const firstBalance = Number(sorted[0].metadata.balance);
  const lastBalance = Number(sorted.at(-1)!.metadata.balance);
  if (!Number.isFinite(firstBalance) || !Number.isFinite(lastBalance)) return {};
  const opening = roundMoney(firstBalance - signedPayPalNet(sorted[0]));
  const movement = roundMoney(sorted.reduce((sum, record) => sum + signedPayPalNet(record), 0));
  const calculated = roundMoney(opening + movement);
  return {
    opening,
    calculated,
    reported: roundMoney(lastBalance),
    residual: roundMoney(lastBalance - calculated),
  };
}

function finalize(acc: PeriodAccumulator): PlatformPeriodSummary {
  const balances = acc.kind === "paypal" ? paypalBalances(acc.paypalRows) : {};
  const sellerRevenue = acc.kind === "etsy"
    ? roundMoney(acc.inflows - acc.marketplaceTax)
    : acc.sellerRevenue;
  const carry = acc.kind === "paypal"
    ? balances.reported ?? acc.movement
    : acc.kind === "etsy"
      ? acc.movement
      : acc.movement;
  const residual = balances.residual;
  const status =
    acc.kind === "paypal"
      ? residual !== undefined && Math.abs(residual) <= 0.02 ? "balanced" : "attention"
      : acc.kind === "etsy" ? "roll-forward"
        : Math.abs(carry) <= 0.02 ? "balanced" : "roll-forward";
  return {
    id: makeId(acc.account, acc.period, acc.currency),
    account: acc.account,
    period: acc.period,
    currency: acc.currency,
    inflows: acc.inflows,
    sellerRevenue,
    marketplaceTax: acc.marketplaceTax,
    fees: acc.fees,
    refunds: acc.refunds,
    charges: acc.charges,
    payouts: acc.payouts,
    openingBalance: balances.opening,
    calculatedClosing: balances.calculated,
    reportedClosing: balances.reported,
    residual,
    carry: roundMoney(carry),
    status,
    note: acc.note,
  };
}

export function buildPlatformSummaries(
  records: NormalizedRecord[],
  _links: MatchLink[],
  year: number,
): PlatformPeriodSummary[] {
  const map = new Map<string, PeriodAccumulator>();
  const etsyStatementShops = new Set(
    records.filter((record) => record.sourceKind === "etsy-statement").map((record) => normalizeText(record.shop)),
  );

  for (const record of records.filter((entry) => entry.disposition === "active" || entry.disposition === "resolved")) {
    const recordPeriods = periods(record, year);
    if (!recordPeriods.length) continue;
    for (const period of recordPeriods) {
      if (record.sourceKind === "paypal-business") {
        addPayPal(
          accumulator(map, "PayPal", period, record.currency, "paypal", "PayPal-Zwischenkonto anhand des laufenden Guthabens"),
          record,
        );
      }

      if (record.sourceKind === "etsy-statement") {
        addEtsy(
          accumulator(map, `Etsy · ${record.shop ?? "nicht zugeordnet"}`, period, record.currency, "etsy", "Monatsstatement; Carry ist der fortgeschriebene Auszahlungsbestand"),
          record,
        );
      } else if (
        record.sourceKind === "etsy-sales" &&
        !etsyStatementShops.has(normalizeText(record.shop))
      ) {
        addMarketplace(
          accumulator(map, `Etsy · ${record.shop ?? "nicht zugeordnet"}`, period, record.currency, "marketplace", "Fallback ohne Etsy-Monatsstatement"),
          record,
        );
      }

      if (record.sourceKind === "ebay-ledger") {
        addMarketplace(accumulator(map, "eBay", period, record.currency, "marketplace", "eBay-Abrechnung"), record);
      }
      if (record.sourceKind === "shopify-orders" || record.sourceKind === "shopify-billing") {
        addMarketplace(
          accumulator(map, `Shopify · ${record.shop ?? "nicht zugeordnet"}`, period, record.currency, "marketplace", "Bestellungen und Shopify-Gebühren; PayPal separat abgestimmt"),
          record,
        );
      }
      if (record.sourceKind === "gelato") {
        addProvider(accumulator(map, "Gelato", period, record.currency, "provider", "Aufträge, Stornos und Anbieter-Guthaben"), record);
      }
      if (record.sourceKind === "printful-orders" || record.sourceKind === "printful-wallet") {
        addProvider(accumulator(map, "Printful", period, record.currency, "provider", "Bestellungen, Erstattungen und Walletbewegungen"), record);
      }

      const royalty = royaltyAccount(record.counterparty);
      if (
        royalty &&
        (record.category === "document-income" || record.sourceKind === "paypal-business" || record.sourceKind === "bank-fyrst")
      ) {
        addRoyalty(
          accumulator(map, royalty, period, record.currency, "royalty", "Zahlungsabgleich; Plattformumsatz mangels zusätzlichem Plattformbericht nicht unabhängig vollständig prüfbar"),
          record,
        );
      }
    }
  }
  return [...map.values()]
    .map(finalize)
    .sort((left, right) => left.account.localeCompare(right.account) || right.period.localeCompare(left.period) || left.currency.localeCompare(right.currency));
}

function batchAccount(anchor: NormalizedRecord): string {
  if (anchor.sourceKind === "paypal-business") return "PayPal";
  if (anchor.sourceKind.startsWith("etsy")) return `Etsy · ${anchor.shop ?? "nicht zugeordnet"}`;
  if (anchor.sourceKind.startsWith("ebay")) return "eBay";
  if (anchor.sourceKind === "gelato") return "Gelato";
  if (anchor.sourceKind.startsWith("printful")) return "Printful";
  return anchor.counterparty || anchor.sourceFile;
}

export function buildSettlementBatches(records: NormalizedRecord[], links: MatchLink[]): SettlementBatch[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const grouped = new Map<string, { anchor: NormalizedRecord; rule: string; links: MatchLink[] }>();
  for (const link of links.filter(
    (entry) =>
      !entry.rejected &&
      (entry.type === "account-batch" || entry.type === "platform-settlement") &&
      /batch|window|payout|refund|saldo|balance|settlement/.test(entry.rule),
  )) {
    const left = recordMap.get(link.fromId);
    const right = recordMap.get(link.toId);
    if (!left || !right) continue;
    const anchor =
      [left, right].find((record) => record.category === "payout") ??
      [left, right].find((record) => record.sourceKind === "paypal-business" && record.category === "transfer") ??
      right;
    const key = `${link.rule}|${anchor.id}`;
    const current = grouped.get(key) ?? { anchor, rule: link.rule, links: [] };
    current.links.push(link);
    grouped.set(key, current);
  }

  return [...grouped.values()].map(({ anchor, rule, links: batchLinks }) => {
    const memberIds = [...new Set(batchLinks.flatMap((link) => [link.fromId, link.toId]))];
    const account = batchAccount(anchor);
    return {
      id: makeId(rule, anchor.id),
      account,
      label: `${account} · ${anchor.date ?? "ohne Datum"} · ${memberIds.length} Bewegungen`,
      date: anchor.date,
      currency: anchor.currency,
      amount: anchor.amount,
      memberIds,
      memberCount: memberIds.length,
      rule,
      verified: batchLinks.every((link) => link.confidence >= 98),
    };
  }).sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "") || left.account.localeCompare(right.account));
}
