import { ArrowRight, CheckCircle2, FileCheck2, Landmark, ShoppingBag, TriangleAlert, WalletCards } from "lucide-react";
import type { CoverageSummary } from "../types";
import type { ViewKey } from "./Sidebar";

interface OverviewProps {
  coverage: CoverageSummary;
  hasData: boolean;
  candidateCount: number;
  sourceCount: number;
  linkCount: number;
  warningCount: number;
  onNavigate: (view: ViewKey) => void;
}

function CoverageCard({
  icon: Icon,
  label,
  resolved,
  total,
  detail,
}: {
  icon: typeof FileCheck2;
  label: string;
  resolved: number;
  total: number;
  detail: string;
}) {
  const percentage = total ? Math.round((resolved / total) * 100) : 0;
  return (
    <article className="coverage-card">
      <div className="coverage-card-head">
        <span className="metric-icon"><Icon size={20} /></span>
        <strong>{label}</strong>
        <span className="percentage">{percentage} %</span>
      </div>
      <div className="coverage-number"><strong>{resolved.toLocaleString("de-DE")}</strong><span> / {total.toLocaleString("de-DE")}</span></div>
      <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
      <small>{detail}</small>
    </article>
  );
}

export function Overview({ coverage, hasData, candidateCount, sourceCount, linkCount, warningCount, onNavigate }: OverviewProps) {
  if (!hasData) return null;
  return (
    <div className="view-stack">
      <section className="page-heading">
        <div><span className="eyebrow">Prüfstand</span><h1>Wie vollständig ist der Abgleich?</h1></div>
        <button className="button button-secondary" onClick={() => onNavigate("exceptions")}>
          Offene Fälle prüfen <ArrowRight size={17} />
        </button>
      </section>

      <section className="coverage-grid">
        <CoverageCard icon={FileCheck2} label="Beleg ↔ Bestellung" resolved={coverage.documentEvidence.resolved} total={coverage.documentEvidence.total} detail={`${coverage.documentEvidence.open} Belege ohne Auftrags- oder Plattformnachweis`} />
        <CoverageCard icon={WalletCards} label="Zahlungsnachweis" resolved={coverage.paymentEvidence.resolved} total={coverage.paymentEvidence.total} detail={`${coverage.paymentEvidence.open} Belege ohne Zahlungs- oder Plattformkonto`} />
        <CoverageCard icon={Landmark} label="Kontenabstimmung" resolved={coverage.accountEvidence.resolved} total={coverage.accountEvidence.total} detail={`${coverage.accountEvidence.open} Belege mit offener Kontenkette`} />
        <CoverageCard icon={Landmark} label="Bankzahlungen" resolved={coverage.payments.resolved} total={coverage.payments.total} detail={`${coverage.payments.open} FYRST- oder N26-Buchungen offen`} />
        <CoverageCard icon={WalletCards} label="PayPal-Konto" resolved={coverage.bridges.resolved} total={coverage.bridges.total} detail={`${coverage.bridges.open} PayPal-Bewegungen ohne abgestimmtes Konto`} />
        <CoverageCard icon={ShoppingBag} label="Bestellungen" resolved={coverage.orders.resolved} total={Math.max(0, coverage.orders.total - coverage.orders.excluded)} detail={`${coverage.orders.excluded} Testbestellung${coverage.orders.excluded === 1 ? "" : "en"} ausgeschlossen`} />
      </section>

      <section className="overview-grid">
        <article className="panel attention-panel">
          <div className="panel-icon warning"><TriangleAlert size={22} /></div>
          <div>
            <span className="panel-kicker">Nächster sinnvoller Schritt</span>
            <h2>{coverage.exceptions.toLocaleString("de-DE")} offene Datensätze prüfen</h2>
            <p>Beginne mit hohen Beträgen und bestätige anschließend die vorgeschlagenen Zuordnungen.</p>
            <button className="text-button" onClick={() => onNavigate("exceptions")}>Ausnahmen öffnen <ArrowRight size={16} /></button>
          </div>
        </article>
        <article className="panel status-list">
          <div className="status-row"><CheckCircle2 size={18} /><span>Erkannte Quellen</span><strong>{sourceCount.toLocaleString("de-DE")}</strong></div>
          <div className="status-row"><CheckCircle2 size={18} /><span>Bestätigte Zuordnungen</span><strong>{linkCount.toLocaleString("de-DE")}</strong></div>
          <div className="status-row candidate"><TriangleAlert size={18} /><span>Vorschläge zur Prüfung</span><strong>{candidateCount.toLocaleString("de-DE")}</strong></div>
          <div className={`status-row ${warningCount ? "candidate" : ""}`}><TriangleAlert size={18} /><span>Importwarnungen</span><strong>{warningCount.toLocaleString("de-DE")}</strong></div>
          <button className="button button-ghost full-width" onClick={() => onNavigate("matches")}>Zuordnungen ansehen</button>
        </article>
      </section>
      <p className="audit-disclaimer">„Geklärt“ bedeutet technisch nachvollziehbar zugeordnet. Die Anwendung ersetzt keine steuerliche Prüfung durch einen Steuerberater.</p>
    </div>
  );
}
