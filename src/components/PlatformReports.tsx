import { AlertTriangle, CheckCircle2, Layers3, WalletCards } from "lucide-react";
import { useMemo, useState } from "react";
import { buildPlatformSummaries, buildSettlementBatches } from "../lib/ledger";
import { formatDate, formatMoney } from "../lib/normalize";
import type { MatchLink, NormalizedRecord } from "../types";

interface PlatformReportsProps {
  records: NormalizedRecord[];
  links: MatchLink[];
  year: number;
}

const BATCH_PAGE_SIZE = 20;

function statusLabel(status: "balanced" | "roll-forward" | "attention"): string {
  if (status === "balanced") return "Rechnerisch abgestimmt";
  if (status === "roll-forward") return "Fortschreibung";
  return "Prüfung nötig";
}

export function PlatformReports({ records, links, year }: PlatformReportsProps) {
  const summaries = useMemo(() => buildPlatformSummaries(records, links, year), [records, links, year]);
  const batches = useMemo(() => buildSettlementBatches(records, links), [records, links]);
  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const annual = summaries.filter((summary) => summary.period === String(year));
  const monthly = summaries.filter((summary) => summary.period !== String(year));
  const [batchPage, setBatchPage] = useState(0);
  const [openBatch, setOpenBatch] = useState<string>();
  const batchPages = Math.max(1, Math.ceil(batches.length / BATCH_PAGE_SIZE));
  const safeBatchPage = Math.min(batchPage, batchPages - 1);
  const visibleBatches = batches.slice(safeBatchPage * BATCH_PAGE_SIZE, (safeBatchPage + 1) * BATCH_PAGE_SIZE);

  return (
    <div className="view-stack">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Kontenfortschreibung</span>
          <h1>Plattformen und Sammelzahlungen</h1>
          <p>Einzelgeschäft, Zahlungskonto und Auszahlung bleiben getrennt nachvollziehbar.</p>
        </div>
      </section>

      <section className="panel account-explainer">
        <WalletCards size={22} />
        <div>
          <strong>PayPal ist ein eigenes Zwischenkonto.</strong>
          <p>Eine Ausgabe kann aus PayPal-Guthaben bezahlt und trotzdem vollständig nachgewiesen sein. Etsy-Carry wird am Jahresende fortgeschrieben, statt künstlich einer Bankzeile zugeordnet zu werden.</p>
        </div>
      </section>

      <section className="account-grid">
        {annual.map((summary) => (
          <article className="account-card" key={summary.id}>
            <div className="account-card-head">
              <div><span>{summary.currency}</span><h2>{summary.account}</h2></div>
              <span className={`control-status control-${summary.status}`}>
                {summary.status === "attention" ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                {statusLabel(summary.status)}
              </span>
            </div>
            <dl>
              <div><dt>Verkäuferumsatz / Rechnungen</dt><dd>{formatMoney(summary.sellerRevenue, summary.currency)}</dd></div>
              <div><dt>Zahlungseingänge</dt><dd>{formatMoney(summary.inflows, summary.currency)}</dd></div>
              <div><dt>Marketplace Tax</dt><dd>{formatMoney(summary.marketplaceTax, summary.currency)}</dd></div>
              <div><dt>Gebühren</dt><dd>{formatMoney(summary.fees, summary.currency)}</dd></div>
              <div><dt>Erstattungen</dt><dd>{formatMoney(summary.refunds, summary.currency)}</dd></div>
              <div><dt>Auszahlungen / Belastungen</dt><dd>{formatMoney(summary.payouts + summary.charges, summary.currency)}</dd></div>
              <div className="account-carry"><dt>{summary.reportedClosing != null ? "Gemeldeter Endbestand" : "Carry / Periodenbewegung"}</dt><dd>{formatMoney(summary.reportedClosing ?? summary.carry, summary.currency)}</dd></div>
            </dl>
            <p>{summary.note}</p>
          </article>
        ))}
      </section>

      <section className="panel table-panel">
        <div className="panel-heading account-table-heading">
          <div><span className="panel-kicker">Monatliche Kontrolle</span><h2>{monthly.length.toLocaleString("de-DE")} Kontenperioden</h2></div>
        </div>
        <div className="table-wrap">
          <table className="account-table">
            <thead><tr><th>Periode</th><th>Konto</th><th>Währung</th><th className="numeric">Umsatz</th><th className="numeric">Steuer</th><th className="numeric">Gebühren</th><th className="numeric">Erstattungen</th><th className="numeric">Carry</th><th>Status</th></tr></thead>
            <tbody>{monthly.map((summary) => (
              <tr key={summary.id}>
                <td>{summary.period}</td><td><strong>{summary.account}</strong></td><td>{summary.currency}</td>
                <td className="numeric">{formatMoney(summary.sellerRevenue || summary.inflows, summary.currency)}</td>
                <td className="numeric">{formatMoney(summary.marketplaceTax, summary.currency)}</td>
                <td className="numeric">{formatMoney(summary.fees, summary.currency)}</td>
                <td className="numeric">{formatMoney(summary.refunds, summary.currency)}</td>
                <td className="numeric">{formatMoney(summary.reportedClosing ?? summary.carry, summary.currency)}</td>
                <td><span className={`control-status control-${summary.status}`}>{statusLabel(summary.status)}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><span className="panel-kicker">Aufklappbare Beweisketten</span><h2>{batches.length.toLocaleString("de-DE")} Sammelgruppen</h2></div>
        </div>
        <div className="batch-list">
          {visibleBatches.map((batch) => {
            const expanded = openBatch === batch.id;
            return (
              <article className="batch-card" key={batch.id}>
                <button className="batch-summary" aria-expanded={expanded} onClick={() => setOpenBatch(expanded ? undefined : batch.id)}>
                  <Layers3 size={18} />
                  <span><strong>{batch.label}</strong><small>{batch.rule}</small></span>
                  <span>{formatMoney(batch.amount, batch.currency)}</span>
                  <span className={`control-status ${batch.verified ? "control-balanced" : "control-attention"}`}>{batch.verified ? "Rechnerisch bestätigt" : "Prüfung nötig"}</span>
                </button>
                {expanded && <div className="batch-members">
                  {batch.memberIds.map((id) => {
                    const record = recordMap.get(id);
                    if (!record) return null;
                    return <div key={id}><span>{formatDate(record.date)}</span><span>{record.counterparty || record.description}</span><span>{record.reference || "–"}</span><strong>{formatMoney(record.amount, record.currency)}</strong></div>;
                  })}
                </div>}
              </article>
            );
          })}
        </div>
        <div className="pagination"><span>Seite {safeBatchPage + 1} von {batchPages}</span><div><button className="button button-ghost button-small" disabled={safeBatchPage === 0} onClick={() => setBatchPage((page) => page - 1)}>Zurück</button><button className="button button-ghost button-small" disabled={safeBatchPage >= batchPages - 1} onClick={() => setBatchPage((page) => page + 1)}>Weiter</button></div></div>
      </section>
    </div>
  );
}
