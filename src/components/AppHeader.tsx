import { Download, FileArchive, FileText, Trash2 } from "lucide-react";

interface AppHeaderProps {
  hasData: boolean;
  year: number;
  onExportProject: () => void;
  onExportAudit: () => void;
  onExportPdf: () => void;
  onDelete: () => void;
}

export function AppHeader({
  hasData,
  year,
  onExportProject,
  onExportAudit,
  onExportPdf,
  onDelete,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">b</div>
        <div>
          <div className="brand-name">buchrec</div>
          <div className="brand-subtitle">Abgleich {year}</div>
        </div>
      </div>
      {hasData && (
        <div className="header-actions">
          <button className="button button-ghost button-compact" onClick={onExportProject}>
            <Download size={16} /> Projekt
          </button>
          <button className="button button-ghost button-compact" onClick={onExportPdf}>
            <FileText size={16} /> PDF
          </button>
          <button className="button button-secondary button-compact" onClick={onExportAudit}>
            <FileArchive size={16} /> Prüfpaket
          </button>
          <button className="icon-button danger" onClick={onDelete} aria-label="Alle lokalen Daten löschen" title="Alle lokalen Daten löschen">
            <Trash2 size={18} />
          </button>
        </div>
      )}
    </header>
  );
}
