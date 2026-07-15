import { FileJson, FileSpreadsheet, FolderOpen, ShieldCheck, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

interface UploadPanelProps {
  busy: boolean;
  progress?: { current: number; total: number; fileName: string };
  onFiles: (files: File[]) => void;
  onProjectFile: (file: File) => void;
}

export function UploadPanel({ busy, progress, onFiles, onProjectFile }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (files: File[]) => {
    const spreadsheets = files.filter((file) => /\.(csv|xlsx|xls)$/i.test(file.name));
    if (spreadsheets.length) onFiles(spreadsheets);
  };

  return (
    <section className="upload-layout">
      <div
        className={`upload-zone ${dragging ? "dragging" : ""} ${busy ? "busy" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          acceptFiles([...event.dataTransfer.files]);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.CSV,.xlsx,.xls"
          hidden
          onChange={(event) => acceptFiles([...(event.target.files ?? [])])}
        />
        <div className="upload-icon"><UploadCloud size={30} /></div>
        <span className="eyebrow">Dateien einlesen</span>
        <h2>{busy ? "Dateien werden lokal verarbeitet" : "CSV- und Excel-Dateien hier ablegen"}</h2>
        <p>Accountable, FYRST, Business-PayPal, N26, Etsy, eBay, Shopify, Printful und Gelato.</p>
        {busy && progress ? (
          <div className="import-progress" aria-live="polite">
            <div className="progress-track"><span style={{ width: `${(progress.current / progress.total) * 100}%` }} /></div>
            <span>{progress.current} von {progress.total} · {progress.fileName}</span>
          </div>
        ) : (
          <button className="button button-primary" onClick={() => inputRef.current?.click()}>
            <FolderOpen size={18} /> Dateien auswählen
          </button>
        )}
        <div className="upload-security"><ShieldCheck size={15} /> Die Dateien verlassen diesen Browser nicht.</div>
      </div>
      <div className="upload-sidecards">
        <article className="mini-card">
          <FileSpreadsheet size={21} />
          <div><strong>Struktur statt Dateiname</strong><span>Die Spalten entscheiden, welcher Importer verwendet wird.</span></div>
        </article>
        <article className="mini-card">
          <FileJson size={21} />
          <div><strong>Projekt fortsetzen</strong><span>Eine zuvor lokal exportierte buchrec-Datei wieder öffnen.</span></div>
          <input ref={projectRef} type="file" accept=".json,.buchrec.json" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onProjectFile(file);
          }} />
          <button className="button button-ghost button-small" onClick={() => projectRef.current?.click()}>Projekt öffnen</button>
        </article>
      </div>
    </section>
  );
}
