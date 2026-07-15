import { Check, ShoppingBag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { NormalizedRecord, ShopifyRule } from "../types";

interface ShopifyReviewProps {
  records: NormalizedRecord[];
  rules: ShopifyRule[];
  onApply: (shop: string, customers: string[]) => void;
}

export function ShopifyReview({ records, rules, onApply }: ShopifyReviewProps) {
  const groups = useMemo(() => {
    const map = new Map<string, Map<string, { count: number; total: number }>>();
    records.filter((record) => record.sourceKind === "shopify-orders").forEach((record) => {
      const shop = record.shop || "Unbekannter Shopify-Shop";
      const customer = record.counterparty || "Unbekannter Kunde";
      const customers = map.get(shop) ?? new Map();
      const current = customers.get(customer) ?? { count: 0, total: 0 };
      customers.set(customer, { count: current.count + 1, total: current.total + record.amount });
      map.set(shop, customers);
    });
    return map;
  }, [records]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setSelected(Object.fromEntries(rules.map((rule) => [rule.shop, rule.genuineCustomers])));
  }, [rules]);

  if (!groups.size) return <section className="empty-panel"><ShoppingBag size={30} /><h2>Noch keine Shopify-Bestellungen</h2><p>Lade eine Shopify-Datei hoch, um echte Bestellungen von Tests zu trennen.</p></section>;

  return (
    <div className="view-stack">
      <section className="page-heading"><div><span className="eyebrow">Shopify-Regeln</span><h1>Echte Kunden festlegen</h1><p>0-Euro-Bestellungen sind immer Tests. Markiere darüber hinaus nur echte Bestellungen.</p></div></section>
      {[...groups].map(([shop, customers]) => (
        <section className="panel" key={shop}>
          <div className="panel-heading"><div><span className="panel-kicker">Shopify-Shop</span><h2>{shop}</h2></div><button className="button button-primary" onClick={() => onApply(shop, selected[shop] ?? [])}><Check size={17} /> Regel anwenden</button></div>
          <div className="customer-grid">
            {[...customers].map(([customer, summary]) => {
              const checked = (selected[shop] ?? []).includes(customer);
              const automaticallyTest = Math.abs(summary.total) < 0.005;
              return (
                <label className={`customer-option ${checked && !automaticallyTest ? "selected" : ""} ${automaticallyTest ? "auto-test" : ""}`} key={customer}>
                  <input type="checkbox" disabled={automaticallyTest} checked={automaticallyTest ? false : checked} onChange={() => setSelected((current) => {
                    const values = current[shop] ?? [];
                    return { ...current, [shop]: checked ? values.filter((value) => value !== customer) : [...values, customer] };
                  })} />
                  <span className="custom-check">{checked && !automaticallyTest && <Check size={14} />}</span>
                  <span><strong>{customer}</strong><small>{automaticallyTest ? "Automatisch als 0-Euro-Test ausgeschlossen" : `${summary.count} Bestellung${summary.count === 1 ? "" : "en"} · ${summary.total.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}`}</small></span>
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
