import { FileJson, FilePlus2, Play, Trash2, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

export interface PendingUpload {
  id: string;
  name: string;
  size: number;
  hash: string;
}

interface UploadPanelProps {
  busy: boolean;
  progress?: { current: number; total: number; fileName: string };
  pending: PendingUpload[];
  notice?: string;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onCheck: () => void;
  onProjectFile: (file: File) => void;
}

export function UploadPanel({
  busy,
  progress,
  pending,
  notice,
  onFiles,
  onRemove,
  onCheck,
  onProjectFile,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (files: File[]) => {
    const spreadsheets = files.filter((file) => /\.(csv|xlsx|xls)$/i.test(file.name));
    if (spreadsheets.length) onFiles(spreadsheets);
  };

  return (
    <section className="upload-panel panel">
      <div
        className={`upload-drop ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          acceptFiles([...event.dataTransfer.files]);
        }}
      >
        <UploadCloud size={26} />
        <div><strong>Upload</strong><span>{pending.length ? `${pending.length} Datei${pending.length === 1 ? "" : "en"} bereit` : "Dateien hinzufügen"}</span></div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.CSV,.xlsx,.xls"
          hidden
          onChange={(event) => {
            acceptFiles([...(event.target.files ?? [])]);
            event.currentTarget.value = "";
          }}
        />
        <button className="button button-ghost" disabled={busy} onClick={() => inputRef.current?.click()}>
          <FilePlus2 size={17} /> Dateien hinzufügen
        </button>
      </div>

      {notice && <div className="upload-notice" role="status">{notice}</div>}

      {pending.length > 0 && (
        <div className="upload-queue">
          {pending.map((file) => (
            <div key={file.id}>
              <span><strong>{file.name}</strong><small>{(file.size / 1024).toLocaleString("de-DE", { maximumFractionDigits: 0 })} KB</small></span>
              <button className="icon-button" disabled={busy} aria-label={`${file.name} entfernen`} onClick={() => onRemove(file.id)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      {busy && progress && (
        <div className="import-progress" aria-live="polite">
          <div className="progress-track"><span style={{ width: `${(progress.current / progress.total) * 100}%` }} /></div>
          <span>{progress.current} von {progress.total} · {progress.fileName}</span>
        </div>
      )}

      <div className="upload-actions">
        <button className="button button-primary" disabled={busy || pending.length === 0} onClick={onCheck}>
          <Play size={17} /> Prüfen
        </button>
        <input ref={projectRef} type="file" accept=".json,.buchrec.json" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onProjectFile(file);
          event.currentTarget.value = "";
        }} />
        <button className="button button-ghost" disabled={busy} onClick={() => projectRef.current?.click()}>
          <FileJson size={17} /> Projekt öffnen
        </button>
      </div>
    </section>
  );
}
