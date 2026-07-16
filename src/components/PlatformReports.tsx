import { AlertTriangle, CheckCircle2, Layers3 } from "lucide-react";
import { useMemo, useState } from "react";
import { buildPlatformReconciliations, buildSettlementBatches } from "../lib/ledger";
import { formatDate, formatMoney } from "../lib/normalize";
import type { MatchLink, NormalizedRecord, PlatformControlAxis } from "../types";

interface PlatformReportsProps {
  records: NormalizedRecord[];
  links: MatchLink[];
  year: number;
}

const BATCH_PAGE_SIZE = 20;

function Axis({ axis }: { axis: PlatformControlAxis }) {
  return (
    <article className={`control-axis axis-${axis.state}`}>
      <div>
        {axis.state === "confirmed" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
        <strong>{axis.label}</strong>
      </div>
      <dl>
        <div><dt>Soll</dt><dd>{formatMoney(axis.expected)}</dd></div>
        <div><dt>Ist</dt><dd>{formatMoney(axis.actual)}</dd></div>
        <div><dt>Differenz</dt><dd>{formatMoney(axis.difference)}</dd></div>
      </dl>
      <small>{axis.detail}</small>
    </article>
  );
}

export function PlatformReports({ records, links, year }: PlatformReportsProps) {
  const controls = useMemo(() => buildPlatformReconciliations(records, links, year), [records, links, year]);
  const batches = useMemo(() => buildSettlementBatches(records, links), [records, links]);
  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const [batchPage, setBatchPage] = useState(0);
  const [openBatch, setOpenBatch] = useState<string>();
  const batchPages = Math.max(1, Math.ceil(batches.length / BATCH_PAGE_SIZE));
  const safeBatchPage = Math.min(batchPage, batchPages - 1);
  const visibleBatches = batches.slice(safeBatchPage * BATCH_PAGE_SIZE, (safeBatchPage + 1) * BATCH_PAGE_SIZE);

  return (
    <div className="view-stack">
      <section className="page-heading"><div><h1>Plattformabrechnungen</h1></div></section>

      <section className="platform-control-list">
        {controls.map((control) => (
          <article className="platform-control-card" key={control.id}>
            <header>
              <div><span>{control.period}</span><h2>{control.platform}{control.shop ? ` · ${control.shop}` : ""}</h2></div>
              <strong>{[control.documentAxis, control.feeDocumentAxis, control.platformAxis, control.paymentAxis].some((axis) => axis?.state === "open")
                ? "Prüfen"
                : [control.documentAxis, control.feeDocumentAxis, control.platformAxis, control.paymentAxis].some((axis) => axis?.state === "warning")
                  ? "Mit Hinweis"
                  : "Nachvollziehbar"}</strong>
            </header>
            <div className="platform-axis-grid">
              <Axis axis={control.documentAxis} />
              <Axis axis={control.platformAxis} />
              <Axis axis={control.paymentAxis} />
            </div>
            {control.feeDocumentAxis && <div className="fee-control"><Axis axis={control.feeDocumentAxis} /></div>}
            <dl className="platform-formula">
              <div><dt>Käuferzahlungen</dt><dd>{formatMoney(control.buyerPayments)}</dd></div>
              <div><dt>Marketplace Tax</dt><dd>{formatMoney(control.marketplaceTax)}</dd></div>
              <div><dt>Verkäuferumsatz</dt><dd>{formatMoney(control.sellerRevenue)}</dd></div>
              <div><dt>Gebühren brutto</dt><dd>{formatMoney(control.feeCharges)}</dd></div>
              {control.feeCorrections > 0 && <div><dt>davon Gebührenkorrekturen</dt><dd>{formatMoney(-control.feeCorrections)}</dd></div>}
              <div><dt>Gebühren netto</dt><dd>{formatMoney(control.fees)}</dd></div>
              <div><dt>Erstattungen</dt><dd>{formatMoney(control.refunds)}</dd></div>
              <div><dt>Anpassungen</dt><dd>{formatMoney(control.adjustments)}</dd></div>
              <div><dt>Auszahlungen</dt><dd>{formatMoney(control.payouts)}</dd></div>
              <div className="formula-result"><dt>Differenz / Übertrag</dt><dd>{formatMoney(control.carry)}</dd></div>
            </dl>
          </article>
        ))}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><span className="panel-kicker">Tatsächliche Sammelvorgänge</span><h2>{batches.length.toLocaleString("de-DE")} Gruppen</h2></div>
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
                  <span className={`control-status ${batch.verified ? "control-balanced" : "control-attention"}`}>{batch.verified ? "Bestätigt" : "Prüfen"}</span>
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
        {batches.length > 0 && <div className="pagination"><span>Seite {safeBatchPage + 1} von {batchPages}</span><div><button className="button button-ghost button-small" disabled={safeBatchPage === 0} onClick={() => setBatchPage((page) => page - 1)}>Zurück</button><button className="button button-ghost button-small" disabled={safeBatchPage >= batchPages - 1} onClick={() => setBatchPage((page) => page + 1)}>Weiter</button></div></div>}
      </section>
    </div>
  );
}
