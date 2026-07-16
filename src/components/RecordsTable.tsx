import { Link2, MessageSquareText, Save, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney, normalizeText } from "../lib/normalize";
import { effectiveRecordReviews, isReconciliationRecord, reconciliationAxes, reconciliationState } from "../lib/matching";
import type { Disposition, EvidenceState, MatchLink, NormalizedRecord, RecordReview, ReviewStatus } from "../types";

interface RecordsTableProps {
  records: NormalizedRecord[];
  links: MatchLink[];
  reviews: RecordReview[];
  onlyExceptions?: boolean;
  onDisposition: (ids: string[], disposition: Disposition) => void;
  onManualLink: (ids: string[]) => void;
  onReview: (ids: string[], status: ReviewStatus, note: string) => void;
}

const PAGE_SIZE = 100;

function EvidenceTag({ state, reason }: { state: EvidenceState; reason: string }) {
  const label = {
    confirmed: "bestätigt",
    open: "offen",
    excluded: "ausgeschlossen",
    "not-applicable": "nicht nötig",
  }[state];
  return <span className={`status-tag evidence-${state}`} title={reason}>{label}</span>;
}

function ReviewTag({ reviews }: { reviews: RecordReview[] }) {
  if (!reviews.length) return <span className="muted">–</span>;
  const review = reviews.find((entry) => !entry.automatic) ?? reviews[0];
  const label = {
    "manual-cleared": "manuell geklärt",
    "open-note": "offen · Notiz",
    warning: "Warnung",
    "data-error": "Datenfehler",
  }[review.status];
  return <span className={`status-tag review-${review.status}`} title={reviews.map((entry) => entry.note).join("\n")}>{label}</span>;
}

export function RecordsTable({ records, links, reviews, onlyExceptions = false, onDisposition, onManualLink, onReview }: RecordsTableProps) {
  const linkedIds = useMemo(() => new Set(links.filter((link) => !link.rejected).flatMap((link) => [link.fromId, link.toId])), [links]);
  const state = useMemo(() => reconciliationState(records, links, reviews), [records, links, reviews]);
  const axes = useMemo(() => reconciliationAxes(records, links, reviews), [records, links, reviews]);
  const reviewsByRecord = useMemo(() => {
    const result = new Map<string, RecordReview[]>();
    for (const review of reviews) result.set(review.recordId, [...(result.get(review.recordId) ?? []), review]);
    return result;
  }, [reviews]);
  const effectiveReviews = useMemo(() => effectiveRecordReviews(reviews), [reviews]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewEditor, setReviewEditor] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("manual-cleared");
  const [reviewNote, setReviewNote] = useState("");
  const filtered = useMemo(() => {
    const needle = normalizeText(query);
    return records.filter((record) => {
      const flagged = effectiveReviews.get(record.id)?.status !== "manual-cleared" && effectiveReviews.has(record.id);
      if (onlyExceptions && (record.disposition !== "active" || (!state.open.has(record.id) && !flagged) || !isReconciliationRecord(record))) return false;
      return !needle || normalizeText(`${record.sourceFile} ${record.counterparty} ${record.reference} ${record.description} ${record.amount} ${record.date}`).includes(needle);
    }).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [records, onlyExceptions, query, state.open, effectiveReviews]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  useEffect(() => { setPage(0); setSelected([]); setReviewEditor(false); }, [query, onlyExceptions]);

  const apply = (disposition: Disposition) => { onDisposition(selected, disposition); setSelected([]); };
  return (
    <div className="view-stack">
      <section className="page-heading"><div><h1>{onlyExceptions ? "Ausnahmen" : "Alle Daten"}</h1><p>{filtered.length.toLocaleString("de-DE")} Einträge</p></div></section>
      <section className="panel table-panel">
        <div className="table-toolbar">
          <label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gegenpartei, Referenz, Betrag …" /></label>
          {selected.length > 0 && <div className="selection-actions"><strong>{selected.length} gewählt</strong><button className="button button-secondary button-small" disabled={selected.length < 2} onClick={() => { onManualLink(selected); setSelected([]); }}><Link2 size={15} /> Verbinden</button><button className="button button-ghost button-small" onClick={() => setReviewEditor((current) => !current)}><MessageSquareText size={15} /> Bewerten</button><button className="button button-ghost button-small" onClick={() => apply("test")}>Test</button><button className="button button-ghost button-small" onClick={() => apply("private")}>Privat</button><button className="icon-button" aria-label="Auswahl aufheben" onClick={() => setSelected([])}><X size={16} /></button></div>}
        </div>
        {reviewEditor && selected.length > 0 && <div className="review-editor">
          <select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value as ReviewStatus)}>
            <option value="manual-cleared">Manuell geklärt</option>
            <option value="open-note">Offen mit Anmerkung</option>
            <option value="warning">Warnung</option>
            <option value="data-error">Datenfehler</option>
          </select>
          <textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} placeholder="Anmerkung …" />
          <button className="button button-primary button-small" disabled={!reviewNote.trim()} onClick={() => {
            onReview(selected, reviewStatus, reviewNote.trim());
            setSelected([]);
            setReviewEditor(false);
            setReviewNote("");
          }}><Save size={15} /> Speichern</button>
        </div>}
        <div className="table-wrap">
          <table className="records-table">
            <thead><tr><th><input type="checkbox" aria-label="Sichtbare Datensätze auswählen" checked={visible.length > 0 && visible.every((record) => selected.includes(record.id))} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((record) => record.id)])] : selected.filter((id) => !visible.some((record) => record.id === id)))} /></th><th>Datum</th><th>Quelle</th><th>Gegenpartei / Referenz</th><th>Art</th><th>Beleg</th><th>Zahlung</th><th>Konto</th><th>Bewertung</th><th className="numeric">Betrag</th></tr></thead>
            <tbody>{visible.map((record) => {
              const evidence = axes.get(record.id);
              return <tr key={record.id} className={selected.includes(record.id) ? "selected-row" : ""}>
              <td><input type="checkbox" checked={selected.includes(record.id)} onChange={() => setSelected((current) => current.includes(record.id) ? current.filter((id) => id !== record.id) : [...current, record.id])} aria-label={`${record.reference || record.description} auswählen`} /></td>
              <td>{formatDate(record.date)}</td><td><span className="source-name">{record.sourceFile}</span></td><td><strong>{record.counterparty || "–"}</strong><small>{record.reference || record.description || "–"}</small></td><td><span className="tag">{record.category}</span></td>
              <td>{evidence ? <EvidenceTag state={evidence.businessEvidence} reason={evidence.businessReason} /> : <span className="muted">–</span>}</td>
              <td>{evidence ? <EvidenceTag state={evidence.paymentEvidence} reason={evidence.paymentReason} /> : <span className="muted">–</span>}</td>
              <td>{evidence ? <EvidenceTag state={evidence.accountEvidence} reason={evidence.accountReason} /> : <span className="muted">{linkedIds.has(record.id) ? "verbunden" : "–"}</span>}</td>
              <td><ReviewTag reviews={reviewsByRecord.get(record.id) ?? []} /></td>
              <td className={`numeric amount-${record.direction}`}>{formatMoney(record.amount, record.currency)}</td>
            </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="pagination"><span>Seite {page + 1} von {pages}</span><div><button className="button button-ghost button-small" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Zurück</button><button className="button button-ghost button-small" disabled={page >= pages - 1} onClick={() => setPage((value) => value + 1)}>Weiter</button></div></div>
      </section>
    </div>
  );
}
