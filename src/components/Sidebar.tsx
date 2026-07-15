import { Database, FileSpreadsheet, LayoutDashboard, Link2, Settings2, TriangleAlert } from "lucide-react";

export type ViewKey = "overview" | "sources" | "matches" | "exceptions" | "records" | "rules";

interface SidebarProps {
  active: ViewKey;
  counts: { sources: number; matches: number; exceptions: number; records: number };
  onChange: (view: ViewKey) => void;
}

const items = [
  { key: "overview" as const, label: "Übersicht", icon: LayoutDashboard },
  { key: "sources" as const, label: "Dateien", icon: FileSpreadsheet, count: "sources" as const },
  { key: "matches" as const, label: "Zuordnungen", icon: Link2, count: "matches" as const },
  { key: "exceptions" as const, label: "Ausnahmen", icon: TriangleAlert, count: "exceptions" as const },
  { key: "records" as const, label: "Alle Daten", icon: Database, count: "records" as const },
  { key: "rules" as const, label: "Regeln", icon: Settings2 },
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
              <span>{item.label}</span>
              {item.count && counts[item.count] > 0 && <strong>{counts[item.count].toLocaleString("de-DE")}</strong>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-note">
        <span className="local-dot" />
        <div>
          <strong>Browser-Speicher</strong>
          <small>Keine Finanzdaten auf Railway</small>
        </div>
      </div>
    </aside>
  );
}
