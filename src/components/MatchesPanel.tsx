import { Check, Link2, Sparkles, X } from "lucide-react";
import type { MatchCandidate, MatchLink, NormalizedRecord } from "../types";
import { formatDate, formatMoney } from "../lib/normalize";

interface MatchesPanelProps {
  links: MatchLink[];
  candidates: MatchCandidate[];
  records: NormalizedRecord[];
  onAccept: (candidate: MatchCandidate) => void;
  onReject: (candidate: MatchCandidate) => void;
}

function RecordSide({ record }: { record?: NormalizedRecord }) {
  if (!record) return <div className="match-side"><span className="muted">Datensatz nicht gefunden</span></div>;
  return <div className="match-side"><span className="tag">{record.sourceFile}</span><strong>{record.counterparty || record.reference || record.description}</strong><small>{formatDate(record.date)} · {formatMoney(record.amount, record.currency)}</small></div>;
}

export function MatchesPanel({ links, candidates, records, onAccept, onReject }: MatchesPanelProps) {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const activeLinks = links.filter((link) => !link.rejected);
  return (
    <div className="view-stack">
      <section className="page-heading"><div><span className="eyebrow">Nachvollziehbarkeit</span><h1>Zuordnungen</h1><p>Jeder Match zeigt Regel, Sicherheit, Datum und Betragsdifferenz.</p></div></section>
      {candidates.length > 0 && <section className="panel">
        <div className="panel-heading"><div><span className="panel-kicker">Entscheidung nötig</span><h2>{candidates.length.toLocaleString("de-DE")} Vorschläge</h2></div></div>
        <div className="match-list">
          {candidates.map((candidate) => <article className="match-card candidate-card" key={candidate.id}>
            <RecordSide record={recordMap.get(candidate.fromId)} /><div className="match-connector"><Sparkles size={18} /><strong>{candidate.confidence} %</strong><small>{candidate.reason}</small></div><RecordSide record={recordMap.get(candidate.toId)} />
            <div className="match-actions"><button className="icon-button success" aria-label="Zuordnung bestätigen" onClick={() => onAccept(candidate)}><Check size={18} /></button><button className="icon-button danger" aria-label="Vorschlag ablehnen" onClick={() => onReject(candidate)}><X size={18} /></button></div>
          </article>)}
        </div>
      </section>}
      <section className="panel">
        <div className="panel-heading"><div><span className="panel-kicker">Bestätigt</span><h2>{activeLinks.length.toLocaleString("de-DE")} Verbindungen</h2></div></div>
        {activeLinks.length ? <div className="match-list compact">
          {activeLinks.slice(0, 500).map((link) => <article className="match-card" key={link.id}>
            <RecordSide record={recordMap.get(link.fromId)} /><div className="match-connector"><Link2 size={17} /><strong>{link.confidence} %</strong><small>{link.rule}</small></div><RecordSide record={recordMap.get(link.toId)} />
          </article>)}
          {activeLinks.length > 500 && <p className="table-note">Aus Leistungsgründen werden die ersten 500 Zuordnungen angezeigt. Der Prüfbericht enthält alle.</p>}
        </div> : <div className="empty-inline">Noch keine Zuordnungen vorhanden.</div>}
      </section>
    </div>
  );
}
