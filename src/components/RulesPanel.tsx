import { CalendarRange, CircleDollarSign, ShieldCheck } from "lucide-react";
import type { ProjectSettings } from "../types";

interface RulesPanelProps { settings: ProjectSettings; onChange: (settings: ProjectSettings) => void; }

export function RulesPanel({ settings, onChange }: RulesPanelProps) {
  return <div className="view-stack">
    <section className="page-heading"><div><span className="eyebrow">Abgleichslogik</span><h1>Regeln und Datenschutz</h1><p>Änderungen lösen einen neuen Abgleich aus.</p></div></section>
    <section className="settings-grid">
      <article className="panel setting-card"><CalendarRange size={22} /><div><h2>Jahr und Datumsfenster</h2><p>Das Prüfjahr benennt den Bericht. Rechnung und Zahlung dürfen bis zu so viele Tage auseinanderliegen.</p><label>Prüfjahr<input key={settings.year} type="number" min="2000" max="2100" defaultValue={settings.year} onBlur={(event) => onChange({ ...settings, year: Math.min(2100, Math.max(2000, Number(event.target.value) || new Date().getFullYear() - 1)) })} /></label><label>Tage<input key={settings.dateToleranceDays} type="number" min="1" max="90" defaultValue={settings.dateToleranceDays} onBlur={(event) => onChange({ ...settings, dateToleranceDays: Math.min(90, Math.max(1, Number(event.target.value) || 20)) })} /></label></div></article>
      <article className="panel setting-card"><CircleDollarSign size={22} /><div><h2>Betragstoleranz</h2><p>Kleine Rundungsdifferenzen innerhalb dieser Grenze gelten als exakt.</p><label>Euro<input key={settings.amountTolerance} type="number" min="0" max="100" step="0.01" defaultValue={settings.amountTolerance} onBlur={(event) => onChange({ ...settings, amountTolerance: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })} /></label></div></article>
      <article className="panel setting-card privacy-card"><ShieldCheck size={22} /><div><h2>Nur im Browser</h2><p>CSV-, Excel- und Projektdateien werden lokal eingelesen. Railway liefert nur die Anwendung aus und erhält keine Finanzdaten.</p><strong>Speicherort: IndexedDB dieses Browsers</strong></div></article>
    </section>
  </div>;
}
