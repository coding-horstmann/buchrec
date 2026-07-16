import { Check, Link2, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { buildSingleReconciliationSummaries } from "../lib/ledger";
import { formatDate, formatMoney } from "../lib/normalize";
import type { MatchCandidate, MatchLink, NormalizedRecord, RecordReview } from "../types";

interface MatchesPanelProps {
  links: MatchLink[];
  candidates: MatchCandidate[];
  records: NormalizedRecord[];
  reviews: RecordReview[];
  onAccept: (candidate: MatchCandidate) => void;
  onReject: (candidate: MatchCandidate) => void;
}

const PAGE_SIZE = 50;

function RecordSide({ record }: { record?: NormalizedRecord }) {
  if (!record) return <div className="match-side"><span className="muted">Datensatz nicht gefunden</span></div>;
  return <div className="match-side"><span className="tag">{record.sourceFile}</span><strong>{record.counterparty || record.reference || record.description}</strong><small>{formatDate(record.date)} · {formatMoney(record.amount, record.currency)}</small></div>;
}

function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return <div className="pagination"><span>Seite {page + 1} von {pages}</span><div><button className="button button-ghost button-small" disabled={page === 0} onClick={() => onChange(page - 1)}>Zurück</button><button className="button button-ghost button-small" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>Weiter</button></div></div>;
}

const BATCH_LINKS = new Set<MatchLink["type"]>(["account-batch", "platform-settlement", "payout-bank"]);

export function MatchesPanel({ links, candidates, records, reviews, onAccept, onReject }: MatchesPanelProps) {
  const recordMap = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const summaries = useMemo(() => buildSingleReconciliationSummaries(records, links, reviews), [records, links, reviews]);
  const activeLinks = useMemo(() => links.filter((link) => !link.rejected && !BATCH_LINKS.has(link.type)), [links]);
  const singleCandidates = useMemo(() => candidates.filter((candidate) => !BATCH_LINKS.has(candidate.type)), [candidates]);
  const [candidatePage, setCandidatePage] = useState(0);
  const [linkPage, setLinkPage] = useState(0);
  const candidatePages = Math.max(1, Math.ceil(singleCandidates.length / PAGE_SIZE));
  const linkPages = Math.max(1, Math.ceil(activeLinks.length / PAGE_SIZE));
  const safeCandidatePage = Math.min(candidatePage, candidatePages - 1);
  const safeLinkPage = Math.min(linkPage, linkPages - 1);
  const visibleCandidates = singleCandidates.slice(safeCandidatePage * PAGE_SIZE, (safeCandidatePage + 1) * PAGE_SIZE);
  const visibleLinks = activeLinks.slice(safeLinkPage * PAGE_SIZE, (safeLinkPage + 1) * PAGE_SIZE);

  return (
    <div className="view-stack">
      <section className="page-heading"><div><h1>Einzelabgleich</h1></div></section>
      <section className="single-summary-grid">
        {summaries.map((summary) => (
          <article className="single-summary-card" key={summary.id}>
            <div><strong>{summary.counterparty}</strong><span>{summary.resolved}/{summary.documents} Belege geklärt</span></div>
            <dl>
              <div><dt>Belege</dt><dd>{formatMoney(summary.documentAmount)}</dd></div>
              <div><dt>Zahlungen</dt><dd>{summary.payments} · {formatMoney(Math.abs(summary.paymentAmount))}</dd></div>
              <div><dt>Offen</dt><dd>{summary.open}</dd></div>
            </dl>
          </article>
        ))}
      </section>
      {singleCandidates.length > 0 && <section className="panel">
        <div className="panel-heading"><div><span className="panel-kicker">Mehrdeutig</span><h2>{singleCandidates.length.toLocaleString("de-DE")} Vorschläge</h2></div></div>
        <div className="match-list">
          {visibleCandidates.map((candidate) => <article className="match-card candidate-card" key={candidate.id}>
            <RecordSide record={recordMap.get(candidate.fromId)} /><div className="match-connector"><Sparkles size={18} /><strong>Prüfen</strong><small>{candidate.reason}</small></div><RecordSide record={recordMap.get(candidate.toId)} />
            <div className="match-actions"><button className="icon-button success" aria-label="Zuordnung bestätigen" onClick={() => onAccept(candidate)}><Check size={18} /></button><button className="icon-button danger" aria-label="Vorschlag ablehnen" onClick={() => onReject(candidate)}><X size={18} /></button></div>
          </article>)}
        </div>
        <Pagination page={safeCandidatePage} pages={candidatePages} onChange={setCandidatePage} />
      </section>}
      <section className="panel">
        <div className="panel-heading"><div><span className="panel-kicker">Automatisch oder manuell bestätigt</span><h2>{activeLinks.length.toLocaleString("de-DE")} Verbindungen</h2></div></div>
        {activeLinks.length ? <div className="match-list compact">
          {visibleLinks.map((link) => <article className="match-card" key={link.id}>
            <RecordSide record={recordMap.get(link.fromId)} /><div className="match-connector"><Link2 size={17} /><strong>{link.confidence} %</strong><small>{link.rule}</small></div><RecordSide record={recordMap.get(link.toId)} />
          </article>)}
        </div> : <div className="empty-inline">Noch keine Zuordnungen vorhanden.</div>}
        <Pagination page={safeLinkPage} pages={linkPages} onChange={setLinkPage} />
      </section>
    </div>
  );
}
