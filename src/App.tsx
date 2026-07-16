import { AlertCircle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { MatchesPanel } from "./components/MatchesPanel";
import { Overview } from "./components/Overview";
import { PlatformReports } from "./components/PlatformReports";
import { RecordsTable } from "./components/RecordsTable";
import { RulesPanel } from "./components/RulesPanel";
import { ShopifyReview } from "./components/ShopifyReview";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { SourcesPanel } from "./components/SourcesPanel";
import { UploadPanel, type PendingUpload } from "./components/UploadPanel";
import { exportAuditPackage, exportAuditPdf } from "./lib/exporter";
import { createDemoProject } from "./lib/demo";
import { applyGlobalTestIdentities, applyShopifyAllowList, parseImportFile } from "./lib/importer";
import { runMatchingInBrowser } from "./lib/matching-client";
import { coverageSummary, manualLink } from "./lib/matching";
import { createProject, mergeParsedFiles, preserveUserLinks, updateSourceShop } from "./lib/project";
import { clearProject, downloadProject, loadProject, readProjectFile, saveProject } from "./lib/storage";
import type { BuchrecProject, Disposition, MatchCandidate, MatchLink, NormalizedRecord, ProjectSettings, RecordReview, ReviewStatus } from "./types";

interface QueuedFile extends PendingUpload {
  file: File;
}

function decisionKey(link: MatchLink): string {
  return [...[link.fromId, link.toId].sort(), link.type].join("|");
}

function applyShopifyRules(records: NormalizedRecord[], project: BuchrecProject): NormalizedRecord[] {
  const withTestIdentities = applyGlobalTestIdentities(records, project.settings.testIdentities ?? []);
  return project.settings.shopifyRules.reduce(
    (current, rule) => rule.mode === "allow-list" ? applyShopifyAllowList(current, rule.shop, rule.genuineCustomers) : current,
    withTestIdentities,
  );
}

async function fileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function App() {
  const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
  const [project, setProject] = useState<BuchrecProject>(demoMode ? createDemoProject : createProject);
  const [view, setView] = useState<ViewKey>("overview");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number; fileName: string }>();
  const [error, setError] = useState<string>();
  const [pendingFiles, setPendingFiles] = useState<QueuedFile[]>([]);
  const [uploadNotice, setUploadNotice] = useState<string>();
  const hydrated = useRef(false);

  useEffect(() => {
    if (demoMode) { hydrated.current = true; return; }
    loadProject()
      .then((stored) => {
        if (stored) {
          setProject(stored);
        }
        hydrated.current = true;
      })
      .catch(() => { hydrated.current = true; setError("Das lokale Projekt konnte nicht geöffnet werden."); });
  }, [demoMode]);

  useEffect(() => {
    if (demoMode || !hydrated.current || !project.sources.length) return;
    const timer = window.setTimeout(() => {
      saveProject(project).catch(() => setError("Die lokale Speicherung ist fehlgeschlagen."));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [demoMode, project]);

  const reconcile = useCallback(async (base: BuchrecProject, records: NormalizedRecord[]): Promise<BuchrecProject> => {
    setBusy(true);
    setBusyLabel("Zuordnungen werden berechnet …");
    const matching = await runMatchingInBrowser(records, base.settings.dateToleranceDays, base.settings.amountTolerance);
    const validIds = new Set(records.map((record) => record.id));
    const previous = base.links.filter((link) => validIds.has(link.fromId) && validIds.has(link.toId));
    const links = preserveUserLinks(matching.links, previous);
    const rejected = new Set(links.filter((link) => link.rejected).map(decisionKey));
    const manualReviews = (base.reviews ?? []).filter((review) => !review.automatic && validIds.has(review.recordId));
    return {
      ...base,
      records,
      links,
      candidates: matching.candidates.filter((candidate) => !rejected.has(decisionKey(candidate))),
      reviews: [...manualReviews, ...matching.reviews],
      updatedAt: new Date().toISOString(),
    };
  }, []);

  const handleFiles = useCallback(async (files: File[]): Promise<boolean> => {
    setBusy(true); setError(undefined); setBusyLabel("Dateien werden eingelesen …");
    try {
      const parsed = [];
      for (let index = 0; index < files.length; index += 1) {
        setProgress({ current: index + 1, total: files.length, fileName: files[index].name });
        parsed.push(await parseImportFile(files[index]));
      }
      const merged = mergeParsedFiles(project, parsed);
      const withRules = applyShopifyRules(merged.records, project);
      const next = await reconcile({ ...project, ...merged }, withRules);
      setProject(next); setView("overview");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Dateien konnten nicht verarbeitet werden.");
      return false;
    } finally {
      setBusy(false); setBusyLabel(""); setProgress(undefined);
    }
  }, [project, reconcile]);

  const handleQueueFiles = useCallback(async (files: File[]) => {
    setBusy(true);
    setBusyLabel("Dateien werden vorbereitet …");
    setUploadNotice(undefined);
    try {
      const knownHashes = new Set([
        ...project.sources.map((source) => source.contentHash).filter((hash): hash is string => Boolean(hash)),
        ...pendingFiles.map((file) => file.hash),
      ]);
      const additions: QueuedFile[] = [];
      let duplicates = 0;
      for (const file of files) {
        const hash = await fileHash(file);
        if (knownHashes.has(hash)) {
          duplicates += 1;
          continue;
        }
        knownHashes.add(hash);
        additions.push({ id: `${hash}-${file.name}`, file, hash, name: file.name, size: file.size });
      }
      if (additions.length) setPendingFiles((current) => [...current, ...additions]);
      setUploadNotice(duplicates ? `${duplicates} identische Datei${duplicates === 1 ? "" : "en"} ignoriert.` : `${additions.length} Datei${additions.length === 1 ? "" : "en"} hinzugefügt.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dateien konnten nicht vorbereitet werden.");
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, [pendingFiles, project.sources]);

  const handleCheckPending = useCallback(async () => {
    if (!pendingFiles.length) return;
    const successful = await handleFiles(pendingFiles.map((entry) => entry.file));
    if (successful) {
      setPendingFiles([]);
      setUploadNotice(undefined);
    }
  }, [handleFiles, pendingFiles]);

  const updateAndReconcile = useCallback(async (base: BuchrecProject, records: NormalizedRecord[]) => {
    setError(undefined);
    try { setProject(await reconcile(base, records)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Der Abgleich ist fehlgeschlagen."); }
    finally { setBusy(false); setBusyLabel(""); }
  }, [reconcile]);

  const coverage = useMemo(() => coverageSummary(project.records, project.links, project.reviews), [project.records, project.links, project.reviews]);
  const hasData = project.sources.length > 0;
  const activeLinkCount = project.links.filter((link) => !link.rejected).length;
  const singleLinkCount = project.links.filter(
    (link) => !link.rejected && !["account-batch", "platform-settlement", "payout-bank"].includes(link.type),
  ).length;
  const warningCount = project.sources.reduce((sum, source) => sum + source.warnings.length, 0);

  const handleProjectFile = async (file: File) => {
    setError(undefined);
    try {
      const imported = await readProjectFile(file);
      setProject(imported);
      setPendingFiles([]);
      setView("overview");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Projektdatei konnte nicht geöffnet werden."); }
  };

  const handleShopChange = (sourceId: string, shop: string) => {
    const changed = updateSourceShop(project.sources, project.records, sourceId, shop);
    void updateAndReconcile({ ...project, sources: changed.sources }, changed.records);
  };

  const handleSourceRemove = (sourceId: string) => {
    const base = { ...project, sources: project.sources.filter((source) => source.id !== sourceId) };
    void updateAndReconcile(base, project.records.filter((record) => record.sourceId !== sourceId));
  };

  const handleShopifyRule = (shop: string, genuineCustomers: string[]) => {
    const rule = { shop, mode: "allow-list" as const, genuineCustomers };
    const base = { ...project, settings: { ...project.settings, shopifyRules: [...project.settings.shopifyRules.filter((item) => item.shop !== shop), rule] } };
    void updateAndReconcile(base, applyShopifyAllowList(project.records, shop, genuineCustomers));
  };

  const handleSettings = (settings: ProjectSettings) => {
    const base = { ...project, settings };
    const testIdentitiesChanged = JSON.stringify(settings.testIdentities) !== JSON.stringify(project.settings.testIdentities);
    if (settings.dateToleranceDays === project.settings.dateToleranceDays && settings.amountTolerance === project.settings.amountTolerance && !testIdentitiesChanged) {
      setProject({ ...base, updatedAt: new Date().toISOString() });
      return;
    }
    void updateAndReconcile(base, applyShopifyRules(project.records, base));
  };

  const handleDisposition = (ids: string[], disposition: Disposition) => {
    const selected = new Set(ids);
    const records = project.records.map((record) => selected.has(record.id) ? { ...record, disposition, dispositionReason: "Vom Nutzer klassifiziert" } : record);
    void updateAndReconcile(project, records);
  };

  const handleReview = (ids: string[], status: ReviewStatus, note: string) => {
    const selected = new Set(ids);
    const timestamp = new Date().toISOString();
    const additions: RecordReview[] = ids.map((recordId) => ({
      id: crypto.randomUUID(),
      recordId,
      status,
      note,
      automatic: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    setProject((current) => ({
      ...current,
      reviews: [
        ...current.reviews.filter((review) => review.automatic || !selected.has(review.recordId)),
        ...additions,
      ],
      updatedAt: timestamp,
    }));
  };

  const handleManualLink = (ids: string[]) => {
    const additions = manualLink(project.records, ids);
    setProject((current) => ({ ...current, links: [...current.links, ...additions], candidates: current.candidates.filter((candidate) => !additions.some((link) => decisionKey(link) === decisionKey(candidate))), updatedAt: new Date().toISOString() }));
  };

  const handleAccept = (candidate: MatchCandidate) => setProject((current) => ({ ...current, links: [...current.links, { ...candidate, automatic: false }], candidates: current.candidates.filter((item) => item.id !== candidate.id), updatedAt: new Date().toISOString() }));
  const handleReject = (candidate: MatchCandidate) => setProject((current) => ({ ...current, links: [...current.links, { ...candidate, rejected: true, automatic: false }], candidates: current.candidates.filter((item) => item.id !== candidate.id), updatedAt: new Date().toISOString() }));

  const handleDelete = async () => {
    if (!window.confirm("Alle in diesem Browser gespeicherten buchrec-Daten wirklich löschen?")) return;
    await clearProject(); setProject(createProject()); setPendingFiles([]); setView("overview"); setError(undefined);
  };

  return (
    <div className="app-shell">
      <AppHeader hasData={hasData} year={project.settings.year} onExportProject={() => downloadProject(project)} onExportAudit={() => void exportAuditPackage(project)} onExportPdf={() => void exportAuditPdf(project)} onDelete={() => void handleDelete()} />
      <div className="app-body">
        {hasData && <Sidebar active={view} counts={{ sources: project.sources.length, matches: singleLinkCount, exceptions: coverage.exceptions, records: project.records.length }} onChange={setView} />}
        <main className={`content ${hasData ? "with-sidebar" : "welcome-content"}`}>
          {error && <div className="error-banner" role="alert"><AlertCircle size={19} /><span>{error}</span><button onClick={() => setError(undefined)}>Schließen</button></div>}
          {busy && hasData && <div className="busy-banner" aria-live="polite"><LoaderCircle className="spin" size={18} /> {busyLabel}</div>}
          {!hasData && <UploadPanel busy={busy} progress={progress} pending={pendingFiles} notice={uploadNotice} onFiles={(files) => void handleQueueFiles(files)} onRemove={(id) => setPendingFiles((current) => current.filter((file) => file.id !== id))} onCheck={() => void handleCheckPending()} onProjectFile={handleProjectFile} />}
          {hasData && view === "overview" && <Overview coverage={coverage} hasData={hasData} candidateCount={project.candidates.length} sourceCount={project.sources.length} linkCount={activeLinkCount} warningCount={warningCount} onNavigate={setView} />}
          {hasData && view === "sources" && <div className="view-stack"><SourcesPanel sources={project.sources} onShopChange={handleShopChange} onRemove={handleSourceRemove} /><UploadPanel busy={busy} progress={progress} pending={pendingFiles} notice={uploadNotice} onFiles={(files) => void handleQueueFiles(files)} onRemove={(id) => setPendingFiles((current) => current.filter((file) => file.id !== id))} onCheck={() => void handleCheckPending()} onProjectFile={handleProjectFile} /></div>}
          {hasData && view === "single" && <MatchesPanel links={project.links} candidates={project.candidates} records={project.records} reviews={project.reviews} onAccept={handleAccept} onReject={handleReject} />}
          {hasData && view === "settlements" && <PlatformReports records={project.records} links={project.links} year={project.settings.year} />}
          {hasData && view === "exceptions" && <RecordsTable records={project.records} links={project.links} reviews={project.reviews} onlyExceptions onDisposition={handleDisposition} onManualLink={handleManualLink} onReview={handleReview} />}
          {hasData && view === "records" && <RecordsTable records={project.records} links={project.links} reviews={project.reviews} onDisposition={handleDisposition} onManualLink={handleManualLink} onReview={handleReview} />}
          {hasData && view === "rules" && <div className="view-stack"><RulesPanel settings={project.settings} onChange={handleSettings} /><ShopifyReview records={project.records} rules={project.settings.shopifyRules} onApply={handleShopifyRule} /></div>}
        </main>
      </div>
    </div>
  );
}

export default App;
