import { FileSpreadsheet, Pencil, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { SourceImport } from "../types";

interface SourcesPanelProps {
  sources: SourceImport[];
  onShopChange: (sourceId: string, shop: string) => void;
  onRemove: (sourceId: string) => void;
}

export function SourcesPanel({ sources, onShopChange, onRemove }: SourcesPanelProps) {
  const [editing, setEditing] = useState<string>();
  return (
    <div className="view-stack">
      <section className="page-heading"><div><span className="eyebrow">Importkontrolle</span><h1>Erkannte Dateien</h1><p>Shopnamen lassen sich korrigieren, ohne die Datei neu einzulesen.</p></div></section>
      <section className="panel table-panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Datei</th><th>Erkannter Typ</th><th>Shop</th><th>Zeitraum</th><th className="numeric">Zeilen</th><th>Hinweise</th><th /></tr></thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td><div className="file-cell"><FileSpreadsheet size={18} /><div><strong>{source.fileName}</strong>{source.sheetName && <small>{source.sheetName}</small>}</div></div></td>
                  <td><span className="tag">{source.label}</span></td>
                  <td>
                    {editing === source.id ? (
                      <input className="inline-input" autoFocus defaultValue={source.shop ?? ""} onBlur={(event) => { onShopChange(source.id, event.target.value.trim()); setEditing(undefined); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                    ) : (
                      <button className="shop-edit" onClick={() => setEditing(source.id)}>{source.shop || "–"}<Pencil size={13} /></button>
                    )}
                  </td>
                  <td>{source.dateMin && source.dateMax ? `${source.dateMin} – ${source.dateMax}` : "–"}</td>
                  <td className="numeric">{source.rowCount.toLocaleString("de-DE")}</td>
                  <td>{source.warnings.length ? <details className="warning-details"><summary className="warning-label"><TriangleAlert size={15} /> {source.warnings.length}</summary><ul>{source.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></details> : <span className="muted">Keine</span>}</td>
                  <td><button className="icon-button" aria-label={`${source.fileName} entfernen`} onClick={() => onRemove(source.id)}><Trash2 size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
