import { Download, FileDown, LockKeyhole, ShieldCheck, Trash2 } from "lucide-react";

interface AppHeaderProps {
  hasData: boolean;
  year: number;
  saveState: "idle" | "saving" | "saved" | "error";
  onExportProject: () => void;
  onExportAudit: () => void;
  onDelete: () => void;
}

export function AppHeader({ hasData, year, saveState, onExportProject, onExportAudit, onDelete }: AppHeaderProps) {
  const saveLabel = {
    idle: "Noch keine Daten",
    saving: "Speichert lokal …",
    saved: "Lokal gespeichert",
    error: "Lokale Speicherung fehlgeschlagen",
  }[saveState];

  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">b</div>
        <div>
          <div className="brand-name">buchrec</div>
          <div className="brand-subtitle">Zahlungsabgleich {year}</div>
        </div>
      </div>
      <div className="header-actions">
        <div className="privacy-pill" title="Dateien werden nicht an den Server übertragen">
          <ShieldCheck size={16} />
          <span>Nur im Browser</span>
        </div>
        <div className={`save-state save-state-${saveState}`}>
          <LockKeyhole size={15} />
          <span>{saveLabel}</span>
        </div>
        {hasData && (
          <>
            <button className="button button-ghost button-compact" onClick={onExportProject}>
              <Download size={16} /> Projekt
            </button>
            <button className="button button-secondary button-compact" onClick={onExportAudit}>
              <FileDown size={16} /> Prüfbericht
            </button>
            <button className="icon-button danger" onClick={onDelete} aria-label="Alle lokalen Daten löschen" title="Alle lokalen Daten löschen">
              <Trash2 size={18} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
