import type {
  MatchLink,
  NormalizedRecord,
  PlatformPeriodSummary,
  PlatformReconciliation,
  RecordReview,
  SettlementBatch,
  SingleReconciliationSummary,
} from "../types";
import { makeId, normalizeText, roundMoney } from "./normalize";
import { reconciliationState } from "./matching";

interface PeriodAccumulator {
  account: string;
  period: string;
  currency: string;
  inflows: number;
  sellerRevenue: number;
  marketplaceTax: number;
  buyerFees: number;
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
    buyerFees: 0,
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
  if (record.category === "buyer-fee") {
    acc.buyerFees = roundMoney(acc.buyerFees + (record.direction === "in" ? -record.amount : record.amount));
  }
  if (record.category === "fee") {
    if (record.metadata.marketplaceTax === true || normalizeText(record.description).includes("sales tax paid by buyer")) {
      acc.marketplaceTax = roundMoney(acc.marketplaceTax + (record.direction === "in" ? -record.amount : record.amount));
    } else {
      acc.fees = roundMoney(acc.fees + (record.direction === "in" ? -record.amount : record.amount));
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
    acc.fees = roundMoney(acc.fees + (record.feeAmount ?? 0));
  }
  if (record.category === "fee") {
    acc.fees = roundMoney(acc.fees + (record.direction === "in" ? -record.amount : record.amount));
  }
  if (record.category === "refund") {
    acc.refunds = roundMoney(acc.refunds + record.amount);
    acc.fees = roundMoney(acc.fees + (record.feeAmount ?? 0));
  }
  if (record.category === "transfer") {
    acc.inflows = roundMoney(acc.inflows + (record.direction === "out" ? -record.amount : record.amount));
  }
  if (record.category === "payout") acc.payouts = roundMoney(acc.payouts + record.amount);
  acc.movement = roundMoney(acc.sellerRevenue + acc.inflows - acc.fees - acc.refunds - acc.payouts);
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
    ? roundMoney(acc.inflows - acc.marketplaceTax - acc.buyerFees)
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
    buyerFees: acc.buyerFees,
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

function linkAdjacency(links: MatchLink[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const link of links.filter((entry) => !entry.rejected)) {
    adjacency.set(link.fromId, new Set([...(adjacency.get(link.fromId) ?? []), link.toId]));
    adjacency.set(link.toId, new Set([...(adjacency.get(link.toId) ?? []), link.fromId]));
  }
  return adjacency;
}

function connected(startId: string, adjacency: Map<string, Set<string>>): Set<string> {
  const result = new Set([startId]);
  const pending = [startId];
  while (pending.length) {
    const current = pending.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (result.has(next)) continue;
      result.add(next);
      pending.push(next);
    }
  }
  return result;
}

function signedDocument(record: NormalizedRecord): number {
  return record.direction === "out" ? -record.amount : record.amount;
}

function controlAxis(
  label: string,
  expected: number,
  actual: number,
  detail: string,
  carryAllowed = false,
) {
  const difference = roundMoney(actual - expected);
  return {
    label,
    expected: roundMoney(expected),
    actual: roundMoney(actual),
    difference,
    state: Math.abs(difference) <= 0.02 ? "confirmed" as const : carryAllowed ? "warning" as const : "open" as const,
    detail,
  };
}

function balanceAxis(label: string, amount: number, detail: string) {
  const value = roundMoney(amount);
  return {
    label,
    expected: value,
    actual: value,
    difference: 0,
    state: "confirmed" as const,
    detail,
    mode: "balance" as const,
  };
}

function platformBankTotal(
  payouts: NormalizedRecord[],
  records: NormalizedRecord[],
  adjacency: Map<string, Set<string>>,
): number {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const bankIds = new Set<string>();
  for (const payout of payouts) {
    for (const id of connected(payout.id, adjacency)) {
      const record = recordMap.get(id);
      if (record && (record.sourceKind === "bank-fyrst" || record.sourceKind === "bank-n26")) {
        bankIds.add(id);
      }
    }
  }
  return roundMoney([...bankIds].reduce((sum, id) => {
    const record = recordMap.get(id);
    if (!record) return sum;
    return sum + (record.direction === "out" ? -record.amount : record.amount);
  }, 0));
}

function platformBankTotalIncludingRecognizableRows(
  payouts: NormalizedRecord[],
  records: NormalizedRecord[],
  adjacency: Map<string, Set<string>>,
): { total: number; unmatched: number } {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const connectedBanks = new Set<string>();
  for (const payout of payouts) {
    for (const id of connected(payout.id, adjacency)) {
      const record = recordMap.get(id);
      if (record && (record.sourceKind === "bank-fyrst" || record.sourceKind === "bank-n26")) connectedBanks.add(id);
    }
  }
  const connectedRows = [...connectedBanks].map((id) => recordMap.get(id)!).filter(Boolean);
  const ibans = new Set(connectedRows.map((record) => String(record.metadata.iban ?? "")).filter(Boolean));
  const parties = new Set(connectedRows.map((record) => normalizeText(record.counterparty)).filter(Boolean));
  const directions = new Set(payouts.map((record) => record.direction));
  const currencies = new Set(payouts.map((record) => record.currency));
  const recognizable = records.filter((record) => {
    if (record.sourceKind !== "bank-fyrst" && record.sourceKind !== "bank-n26") return false;
    if (!directions.has(record.direction) || !currencies.has(record.currency)) return false;
    const iban = String(record.metadata.iban ?? "");
    return (Boolean(iban) && ibans.has(iban)) || parties.has(normalizeText(record.counterparty));
  });
  const ids = new Set([...connectedBanks, ...recognizable.map((record) => record.id)]);
  const total = roundMoney([...ids].reduce((sum, id) => {
    const record = recordMap.get(id);
    return record ? sum + (record.direction === "out" ? -record.amount : record.amount) : sum;
  }, 0));
  return { total, unmatched: [...ids].filter((id) => !connectedBanks.has(id)).length };
}

function connectedDocuments(
  platformRecords: NormalizedRecord[],
  records: NormalizedRecord[],
  adjacency: Map<string, Set<string>>,
  category: "document-income" | "document-expense",
): NormalizedRecord[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ids = new Set<string>();
  for (const platformRecord of platformRecords) {
    for (const id of connected(platformRecord.id, adjacency)) {
      if (recordMap.get(id)?.category === category) ids.add(id);
    }
  }
  return [...ids].map((id) => recordMap.get(id)!).filter(Boolean);
}

export function buildPlatformReconciliations(
  records: NormalizedRecord[],
  links: MatchLink[],
  year: number,
): PlatformReconciliation[] {
  const activeRecords = records.filter(
    (record) =>
      (record.disposition === "active" || record.disposition === "resolved") &&
      record.date?.startsWith(`${year}-`),
  );
  const adjacency = linkAdjacency(links);
  const activeRecordMap = new Map(activeRecords.map((record) => [record.id, record]));
  const businessAdjacency = linkAdjacency(
    links.filter((link) => {
      if (["document-order", "platform-evidence", "manual"].includes(link.type)) return true;
      if (link.type !== "group-payment") return false;
      const from = activeRecordMap.get(link.fromId);
      const to = activeRecordMap.get(link.toId);
      return [from, to].some((record) => record?.category === "document-income") &&
        [from, to].some((record) => record && ["order", "order-detail", "sale", "refund"].includes(record.category));
    }),
  );
  const summaries = buildPlatformSummaries(records, links, year);
  const result: PlatformReconciliation[] = [];

  const etsyShops = new Set(
    activeRecords
      .filter((record) => record.sourceKind === "etsy-sales" && record.shop)
      .map((record) => record.shop!),
  );
  for (const shop of etsyShops) {
    const allOrders = activeRecords.filter(
      (record) => record.sourceKind === "etsy-sales" && record.category === "order" && normalizeText(record.shop) === normalizeText(shop),
    );
    const platformRecords = activeRecords.filter(
      (record) => record.sourceKind.startsWith("etsy") && normalizeText(record.shop) === normalizeText(shop),
    );
    const detailsByOrder = new Map(
      platformRecords
        .filter((record) => record.sourceKind === "etsy-sold-orders" && record.category === "order-detail")
        .map((record) => [record.reference, record]),
    );
    const buyerFeesByOrder = new Map<string, number>();
    for (const record of platformRecords.filter((entry) => entry.category === "buyer-fee")) {
      const signed = record.direction === "in" ? -record.amount : record.amount;
      buyerFeesByOrder.set(record.reference, roundMoney((buyerFeesByOrder.get(record.reference) ?? 0) + signed));
    }
    const invoiceOrders = allOrders.filter((record) => record.metadata.fullyRefunded !== true);
    const documentRevenue = roundMoney(invoiceOrders.reduce((sum, record) => {
      const detail = detailsByOrder.get(record.reference);
      const buyerFee = buyerFeesByOrder.get(record.reference) ?? 0;
      return sum + (detail?.amount ?? roundMoney(record.amount - buyerFee));
    }, 0));
    const buyerPayments = roundMoney(allOrders.reduce((sum, record) => {
      const listing = Number(record.metadata.listingAmount);
      return sum + (Number.isFinite(listing) ? listing : record.amount);
    }, 0));
    const statement = summaries.find(
      (summary) => summary.account === `Etsy · ${shop}` && summary.period === String(year) && summary.currency === "EUR",
    );
    const sellerRevenue = statement?.sellerRevenue ?? roundMoney(allOrders.reduce((sum, record) => sum + record.amount, 0));
    const marketplaceTax = statement?.marketplaceTax ?? roundMoney(buyerPayments - sellerRevenue);
    const buyerFees = statement?.buyerFees ?? roundMoney([...buyerFeesByOrder.values()].reduce((sum, amount) => sum + amount, 0));
    const salesDocuments = connectedDocuments(platformRecords, activeRecords, businessAdjacency, "document-income");
    const feeDocuments = connectedDocuments(platformRecords, activeRecords, adjacency, "document-expense");
    const accountableSales = roundMoney(salesDocuments.reduce((sum, record) => sum + signedDocument(record), 0));
    const accountableFees = roundMoney(feeDocuments.reduce((sum, record) => sum + record.amount, 0));
    const feeRows = platformRecords.filter(
      (record) => record.sourceKind === "etsy-statement" && record.category === "fee" && record.metadata.marketplaceTax !== true,
    );
    const feeCharges = roundMoney(feeRows.filter((record) => record.direction === "out").reduce((sum, record) => sum + record.amount, 0));
    const feeCorrections = roundMoney(feeRows.filter((record) => record.direction === "in").reduce((sum, record) => sum + record.amount, 0));
    const fees = roundMoney(feeCharges - feeCorrections);
    const refunds = statement?.refunds ?? 0;
    const payouts = statement?.payouts ?? 0;
    const carry = statement?.carry ?? 0;
    const adjustments = roundMoney(carry - (sellerRevenue - fees - refunds - payouts));
    const transferPayouts = platformRecords.filter((record) => record.sourceKind === "etsy-transfers" && record.category === "payout");
    const statementPayouts = platformRecords.filter((record) => record.sourceKind === "etsy-statement" && record.category === "payout");
    const bankPayoutRecords = transferPayouts.length ? transferPayouts : statementPayouts;
    const executedPayouts = roundMoney(bankPayoutRecords.reduce((sum, record) => sum + record.amount, 0));
    const bankEvidence = platformBankTotalIncludingRecognizableRows(bankPayoutRecords, activeRecords, adjacency);
    result.push({
      id: makeId("platform-control", "etsy", shop, year),
      platform: "Etsy",
      shop,
      period: String(year),
      currency: "EUR",
      documentAxis: controlAxis("Accountable-Rechnungen ↔ Etsy-Verkäufe-CSV", documentRevenue, accountableSales, "Rechnungsrelevanter Verkäuferumsatz ohne Marketplace Tax, Buyer Fees und vollständig erstattete Bestellungen"),
      feeDocumentAxis: controlAxis("Accountable-Eingangsrechnungen ↔ Etsy-Monatsabrechnungen", fees, accountableFees, "Etsy-Gebühren abzüglich Gutschriften; Marketplace Tax und Buyer Fees sind ausgeschlossen"),
      platformAxis: balanceAxis("Etsy-Zahlungskonto · Übertrag", carry, "Fortgeschriebene Periodenbewegung; kein Soll-Null und kein automatischer Fehler"),
      paymentAxis: controlAxis("Etsy-Auszahlungs-CSV ↔ FYRST/N26", executedPayouts, bankEvidence.total, `Alle anhand Gegenpartei oder Bankkennung eindeutig dem Shop zuordenbaren Bankbewegungen; ${bankEvidence.unmatched} ohne direkte Auszahlungsverknüpfung`),
      sellerRevenue,
      documentRevenue,
      buyerPayments,
      marketplaceTax,
      buyerFees,
      feeCharges,
      fees,
      feeCorrections,
      refunds,
      adjustments,
      payouts,
      carry,
    });
  }

  const ebay = activeRecords.filter((record) => record.sourceKind === "ebay-ledger");
  if (ebay.length) {
    const sales = ebay.filter((record) => record.category === "sale");
    const refunds = ebay.filter((record) => record.category === "refund");
    const payouts = ebay.filter((record) => record.category === "payout");
    const transfers = ebay.filter((record) => record.category === "transfer");
    const sellerRevenue = roundMoney(
      sales.reduce((sum, record) => sum + record.amount, 0) -
      refunds.reduce((sum, record) => sum + record.amount, 0),
    );
    const grossFees = roundMoney(ebay.reduce((sum, record) => {
      if ((record.category === "sale" || record.category === "refund") && (record.feeAmount ?? 0) > 0) {
        return sum + (record.feeAmount ?? 0);
      }
      if (record.category === "fee" && record.direction === "out") return sum + record.amount;
      return sum;
    }, 0));
    const feeCorrections = roundMoney(ebay.reduce((sum, record) => {
      if ((record.category === "sale" || record.category === "refund") && (record.feeAmount ?? 0) < 0) {
        return sum + Math.abs(record.feeAmount ?? 0);
      }
      if (record.category === "fee" && record.direction === "in") return sum + record.amount;
      return sum;
    }, 0));
    const fees = roundMoney(grossFees - feeCorrections);
    const netBasisMonths = new Set(
      links
        .filter((link) => link.rule.startsWith("platform-withheld-fees-net"))
        .flatMap((link) => [activeRecordMap.get(link.fromId), activeRecordMap.get(link.toId)])
        .filter((record): record is NormalizedRecord => record?.sourceKind === "ebay-ledger" && Boolean(record.date))
        .map((record) => record.date!.slice(0, 7)),
    );
    const correctionsIncludedOnInvoices = roundMoney(ebay.reduce((sum, record) => {
      if (!record.date || !netBasisMonths.has(record.date.slice(0, 7))) return sum;
      if ((record.category === "sale" || record.category === "refund") && (record.feeAmount ?? 0) < 0) {
        return sum + Math.abs(record.feeAmount ?? 0);
      }
      if (record.category === "fee" && record.direction === "in") return sum + record.amount;
      return sum;
    }, 0));
    const invoiceFeeExpected = roundMoney(grossFees - correctionsIncludedOnInvoices);
    const payoutTotal = roundMoney(payouts.reduce((sum, record) => sum + record.amount, 0));
    const platformRecords = activeRecords.filter(
      (record) => record.sourceKind === "ebay-ledger" || record.sourceKind === "ebay-orders",
    );
    const salesDocuments = connectedDocuments(platformRecords, activeRecords, adjacency, "document-income");
    const feeDocuments = [
      ...new Map([
        ...connectedDocuments(platformRecords, activeRecords, adjacency, "document-expense"),
        ...activeRecords.filter(
          (record) =>
            record.category === "document-expense" &&
            normalizeText(record.counterparty).includes("ebay"),
        ),
      ].map((record) => [record.id, record])).values(),
    ];
    const accountableSales = roundMoney(salesDocuments.reduce((sum, record) => sum + signedDocument(record), 0));
    const accountableFees = roundMoney(feeDocuments.reduce((sum, record) => sum + record.amount, 0));
    const adjustments = roundMoney(transfers.reduce((sum, record) => sum + (record.direction === "out" ? -record.amount : record.amount), 0));
    const carry = roundMoney(sellerRevenue + adjustments - fees - payoutTotal);
    const bankTotal = platformBankTotal([...payouts, ...transfers], activeRecords, adjacency);
    const expectedBank = roundMoney(payoutTotal - adjustments);
    result.push({
      id: makeId("platform-control", "ebay", year),
      platform: "eBay",
      period: String(year),
      currency: "EUR",
      documentAxis: controlAxis("Accountable-Rechnungen ↔ eBay-Verkäufe/Erstattungen aus CSV", sellerRevenue, accountableSales, "Verkäufe abzüglich Erstattungen aus der eBay-Abrechnungs-/Transaktions-CSV gegen Ausgangsrechnungen"),
      feeDocumentAxis: controlAxis("Accountable-Eingangsrechnungen ↔ eBay-Gebührenabrechnung", invoiceFeeExpected, accountableFees, "Je Abrechnungsmonat wird die ausgewiesene Brutto- oder Nettogebühr verwendet; Korrekturen bleiben separat sichtbar"),
      platformAxis: balanceAxis("eBay-Zahlungskonto · Übertrag", carry, "Fortgeschriebene Verkäufe, Erstattungen, Gebühren und Auszahlungen; kein Soll-Null"),
      paymentAxis: controlAxis("eBay-Auszahlungen/Belastungen ↔ Bank", expectedBank, bankTotal, "Auszahlungen und Rückerstattungszuführungen bis FYRST/N26 verfolgt"),
      sellerRevenue,
      documentRevenue: sellerRevenue,
      buyerPayments: roundMoney(sales.reduce((sum, record) => sum + record.amount, 0)),
      marketplaceTax: 0,
      buyerFees: 0,
      feeCharges: grossFees,
      fees,
      feeCorrections,
      refunds: roundMoney(refunds.reduce((sum, record) => sum + record.amount, 0)),
      adjustments,
      payouts: payoutTotal,
      carry,
    });
  }
  return result;
}

const SINGLE_ACCOUNTS = [
  { label: "Gelato", patterns: ["gelato"] },
  { label: "Printful", patterns: ["printful"] },
  { label: "Printler", patterns: ["printler"] },
  { label: "Art Heroes", patterns: ["art heroes", "werk aan de muur", "we make it work"] },
  { label: "Redbubble", patterns: ["redbubble"] },
  { label: "Europosters", patterns: ["europosters"] },
  { label: "Albin Michel", patterns: ["albin michel", "editions albin michel"] },
  { label: "Google", patterns: ["google"] },
  { label: "Cursor", patterns: ["cursor"] },
  { label: "Faktorino", patterns: ["faktorino", "lights more"] },
];

export function buildSingleReconciliationSummaries(
  records: NormalizedRecord[],
  links: MatchLink[],
  reviews: RecordReview[] = [],
): SingleReconciliationSummary[] {
  const adjacency = linkAdjacency(links);
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const state = reconciliationState(records, links, reviews);
  const accounts = [...SINGLE_ACCOUNTS];
  for (const shop of new Set(records.filter((record) => record.sourceKind === "shopify-orders" && record.shop).map((record) => record.shop!))) {
    accounts.push({ label: `Shopify · ${shop}`, patterns: [normalizeText(shop)] });
  }
  return accounts.flatMap((account) => {
    const anchors = records.filter((record) => {
      const text = normalizeText(`${record.counterparty} ${record.description} ${record.shop ?? ""}`);
      return account.patterns.some((pattern) => text.includes(normalizeText(pattern))) &&
        (record.category.startsWith("document") || record.category === "order");
    });
    if (!anchors.length) return [];
    const componentIds = new Set<string>();
    for (const anchor of anchors) {
      for (const id of connected(anchor.id, adjacency)) componentIds.add(id);
    }
    const component = [...componentIds].map((id) => recordMap.get(id)).filter((record): record is NormalizedRecord => Boolean(record));
    const documents = anchors.filter((record) => record.category.startsWith("document"));
    const payments = component.filter(
      (record) =>
        record.sourceKind === "paypal-business" ||
        record.sourceKind === "bank-fyrst" ||
        record.sourceKind === "bank-n26",
    );
    return [{
      id: makeId("single-summary", account.label),
      counterparty: account.label,
      documents: documents.length,
      documentAmount: roundMoney(documents.reduce((sum, record) => sum + signedDocument(record), 0)),
      payments: payments.length,
      paymentAmount: roundMoney(payments.reduce((sum, record) => sum + (record.direction === "out" ? -record.amount : record.amount), 0)),
      resolved: documents.filter((record) => state.resolved.has(record.id)).length,
      open: documents.filter((record) => state.open.has(record.id)).length,
    }];
  });
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
  })
    .filter((batch) => /^(paypal|etsy|ebay)/.test(normalizeText(batch.account)))
    .sort((left, right) => (right.date ?? "").localeCompare(left.date ?? "") || left.account.localeCompare(right.account));
}
