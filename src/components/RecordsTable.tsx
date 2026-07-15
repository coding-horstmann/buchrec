import { CheckCircle2, Link2, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney, normalizeText } from "../lib/normalize";
import { isReconciliationRecord } from "../lib/matching";
import type { Disposition, MatchLink, NormalizedRecord } from "../types";

interface RecordsTableProps {
  records: NormalizedRecord[];
  links: MatchLink[];
  onlyExceptions?: boolean;
  onDisposition: (ids: string[], disposition: Disposition) => void;
  onManualLink: (ids: string[]) => void;
}

const PAGE_SIZE = 100;

export function RecordsTable({ records, links, onlyExceptions = false, onDisposition, onManualLink }: RecordsTableProps) {
  const linkedIds = useMemo(() => new Set(links.filter((link) => !link.rejected).flatMap((link) => [link.fromId, link.toId])), [links]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const filtered = useMemo(() => {
    const needle = normalizeText(query);
    return records.filter((record) => {
      if (onlyExceptions && (record.disposition !== "active" || linkedIds.has(record.id) || !isReconciliationRecord(record))) return false;
      return !needle || normalizeText(`${record.sourceFile} ${record.counterparty} ${record.reference} ${record.description} ${record.amount} ${record.date}`).includes(needle);
    }).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [records, linkedIds, onlyExceptions, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); setSelected([]); }, [query, onlyExceptions]);

  const apply = (disposition: Disposition) => { onDisposition(selected, disposition); setSelected([]); };
  return (
    <div className="view-stack">
      <section className="page-heading"><div><span className="eyebrow">{onlyExceptions ? "Handarbeit" : "Datenbestand"}</span><h1>{onlyExceptions ? "Offene Ausnahmen" : "Alle Datensätze"}</h1><p>{filtered.length.toLocaleString("de-DE")} Einträge · nach Betrag sortiert</p></div></section>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gegenpartei, Referenz, Betrag …" /></label>
          {selected.length > 0 && <div className="selection-actions"><strong>{selected.length} gewählt</strong><button className="button button-secondary button-small" disabled={selected.length < 2} onClick={() => { onManualLink(selected); setSelected([]); }}><Link2 size={15} /> Verbinden</button><button className="button button-ghost button-small" onClick={() => apply("resolved")}><CheckCircle2 size={15} /> Geklärt</button><button className="button button-ghost button-small" onClick={() => apply("test")}>Test</button><button className="button button-ghost button-small" onClick={() => apply("private")}>Privat</button><button className="icon-button" aria-label="Auswahl aufheben" onClick={() => setSelected([])}><X size={16} /></button></div>}
        </div>
        <div className="table-wrap">
          <table className="records-table">
            <thead><tr><th><input type="checkbox" aria-label="Sichtbare Datensätze auswählen" checked={visible.length > 0 && visible.every((record) => selected.includes(record.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((record) => record.id)])] : selected.filter((id) => !visible.some((record) => record.id === id)))} /></th><th>Datum</th><th>Quelle</th><th>Gegenpartei / Referenz</th><th>Art</th><th>Status</th><th className="numeric">Betrag</th></tr></thead>
            <tbody>{visible.map((record) => <tr key={record.id} className={selected.includes(record.id) ? "selected-row" : ""}>
              <td><input type="checkbox" checked={selected.includes(record.id)} onChange={() => setSelected((current) => current.includes(record.id) ? current.filter((id) => id !== record.id) : [...current, record.id])} aria-label={`${record.reference || record.description} auswählen`} /></td>
              <td>{formatDate(record.date)}</td><td><span className="source-name">{record.sourceFile}</span></td><td><strong>{record.counterparty || "–"}</strong><small>{record.reference || record.description || "–"}</small></td><td><span className="tag">{record.category}</span></td><td><span className={`status-tag status-${linkedIds.has(record.id) ? "linked" : record.disposition}`}>{linkedIds.has(record.id) ? "zugeordnet" : record.disposition}</span></td><td className={`numeric amount-${record.direction}`}>{formatMoney(record.amount, record.currency)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="pagination"><span>Seite {page + 1} von {pages}</span><div><button className="button button-ghost button-small" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Zurück</button><button className="button button-ghost button-small" disabled={page >= pages - 1} onClick={() => setPage((value) => value + 1)}>Weiter</button></div></div>
      </section>
    </div>
  );
}
