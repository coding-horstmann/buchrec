import { Database, FileSpreadsheet, Layers3, LayoutDashboard, Link2, Settings2, TriangleAlert } from "lucide-react";

export type ViewKey = "overview" | "sources" | "single" | "settlements" | "exceptions" | "records" | "rules";

interface SidebarProps {
  active: ViewKey;
  counts: { sources: number; matches: number; exceptions: number; records: number };
  onChange: (view: ViewKey) => void;
}

const items = [
  { key: "overview" as const, label: "Übersicht", mobileLabel: "Start", icon: LayoutDashboard },
  { key: "sources" as const, label: "Dateien", mobileLabel: "Dateien", icon: FileSpreadsheet, count: "sources" as const },
  { key: "single" as const, label: "Einzelabgleich", mobileLabel: "Abgleich", icon: Link2, count: "matches" as const },
  { key: "settlements" as const, label: "Plattformabrechnungen", mobileLabel: "Plattform", icon: Layers3 },
  { key: "exceptions" as const, label: "Ausnahmen", mobileLabel: "Offen", icon: TriangleAlert, count: "exceptions" as const },
  { key: "records" as const, label: "Alle Daten", mobileLabel: "Daten", icon: Database, count: "records" as const },
  { key: "rules" as const, label: "Regeln", mobileLabel: "Regeln", icon: Settings2 },
];

export function Sidebar({ active, counts, onChange }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Hauptnavigation">
      <nav>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={`nav-item ${active === item.key ? "active" : ""}`}
              onClick={() => onChange(item.key)}
            >
              <Icon size={19} />
              <span data-mobile-label={item.mobileLabel}>{item.label}</span>
              {item.count && counts[item.count] > 0 && <strong>{counts[item.count].toLocaleString("de-DE")}</strong>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
