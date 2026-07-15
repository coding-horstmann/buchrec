import { AlertCircle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { MatchesPanel } from "./components/MatchesPanel";
import { Overview } from "./components/Overview";
import { RecordsTable } from "./components/RecordsTable";
import { RulesPanel } from "./components/RulesPanel";
import { ShopifyReview } from "./components/ShopifyReview";
import { Sidebar, type ViewKey } from "./components/Sidebar";
import { SourcesPanel } from "./components/SourcesPanel";
import { UploadPanel } from "./components/UploadPanel";
import { exportAuditWorkbook } from "./lib/exporter";
import { createDemoProject } from "./lib/demo";
import { applyShopifyAllowList, parseImportFile } from "./lib/importer";
import { runMatchingInBrowser } from "./lib/matching-client";
import { coverageSummary, manualLink } from "./lib/matching";
import { createProject, mergeParsedFiles, preserveUserLinks, updateSourceShop } from "./lib/project";
import { clearProject, downloadProject, loadProject, readProjectFile, saveProject } from "./lib/storage";
import type { BuchrecProject, Disposition, MatchCandidate, MatchLink, NormalizedRecord, ProjectSettings } from "./types";

type SaveState = "idle" | "saving" | "saved" | "error";

function decisionKey(link: MatchLink): string {
  return [...[link.fromId, link.toId].sort(), link.type].join("|");
}

function applyShopifyRules(records: NormalizedRecord[], project: BuchrecProject): NormalizedRecord[] {
  return project.settings.shopifyRules.reduce(
    (current, rule) => rule.mode === "allow-list" ? applyShopifyAllowList(current, rule.shop, rule.genuineCustomers) : current,
    records,
  );
}

function App() {
  const demoMode = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
  const [project, setProject] = useState<BuchrecProject>(demoMode ? createDemoProject : createProject);
  const [view, setView] = useState<ViewKey>("overview");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [progress, setProgress] = useState<{ current: number; total: number; fileName: string }>();
  const [saveState, setSaveState] = useState<SaveState>(demoMode ? "saved" : "idle");
  const [error, setError] = useState<string>();
  const hydrated = useRef(false);

  useEffect(() => {
    if (demoMode) { hydrated.current = true; return; }
    loadProject()
      .then((stored) => {
        if (stored) { setProject(stored); setSaveState("saved"); }
        hydrated.current = true;
      })
      .catch(() => { hydrated.current = true; setSaveState("error"); });
  }, [demoMode]);

  useEffect(() => {
    if (demoMode || !hydrated.current || !project.sources.length) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      saveProject(project).then(() => setSaveState("saved")).catch(() => setSaveState("error"));
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
    return {
      ...base,
      records,
      links,
      candidates: matching.candidates.filter((candidate) => !rejected.has(decisionKey(candidate))),
      updatedAt: new Date().toISOString(),
    };
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Die Dateien konnten nicht verarbeitet werden.");
    } finally {
      setBusy(false); setBusyLabel(""); setProgress(undefined);
    }
  }, [project, reconcile]);

  const updateAndReconcile = useCallback(async (base: BuchrecProject, records: NormalizedRecord[]) => {
    setError(undefined);
    try { setProject(await reconcile(base, records)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Der Abgleich ist fehlgeschlagen."); }
    finally { setBusy(false); setBusyLabel(""); }
  }, [reconcile]);

  const coverage = useMemo(() => coverageSummary(project.records, project.links), [project.records, project.links]);
  const hasData = project.sources.length > 0;
  const activeLinkCount = project.links.filter((link) => !link.rejected).length;

  const handleProjectFile = async (file: File) => {
    setError(undefined);
    try { const imported = await readProjectFile(file); setProject(imported); setView("overview"); }
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
    if (settings.dateToleranceDays === project.settings.dateToleranceDays && settings.amountTolerance === project.settings.amountTolerance) {
      setProject({ ...base, updatedAt: new Date().toISOString() });
      return;
    }
    void updateAndReconcile(base, project.records);
  };

  const handleDisposition = (ids: string[], disposition: Disposition) => {
    const selected = new Set(ids);
    const records = project.records.map((record) => selected.has(record.id) ? { ...record, disposition, dispositionReason: "Vom Nutzer klassifiziert" } : record);
    void updateAndReconcile(project, records);
  };

  const handleManualLink = (ids: string[]) => {
    const additions = manualLink(project.records, ids);
    setProject((current) => ({ ...current, links: [...current.links, ...additions], candidates: current.candidates.filter((candidate) => !additions.some((link) => decisionKey(link) === decisionKey(candidate))), updatedAt: new Date().toISOString() }));
  };

  const handleAccept = (candidate: MatchCandidate) => setProject((current) => ({ ...current, links: [...current.links, { ...candidate, automatic: false }], candidates: current.candidates.filter((item) => item.id !== candidate.id), updatedAt: new Date().toISOString() }));
  const handleReject = (candidate: MatchCandidate) => setProject((current) => ({ ...current, links: [...current.links, { ...candidate, rejected: true, automatic: false }], candidates: current.candidates.filter((item) => item.id !== candidate.id), updatedAt: new Date().toISOString() }));

  const handleDelete = async () => {
    if (!window.confirm("Alle in diesem Browser gespeicherten buchrec-Daten wirklich löschen?")) return;
    await clearProject(); setProject(createProject()); setView("overview"); setSaveState("idle"); setError(undefined);
  };

  return (
    <div className="app-shell">
      <AppHeader hasData={hasData} year={project.settings.year} saveState={saveState} onExportProject={() => downloadProject(project)} onExportAudit={() => exportAuditWorkbook(project)} onDelete={() => void handleDelete()} />
      <div className="app-body">
        {hasData && <Sidebar active={view} counts={{ sources: project.sources.length, matches: activeLinkCount, exceptions: coverage.exceptions, records: project.records.length }} onChange={setView} />}
        <main className={`content ${hasData ? "with-sidebar" : "welcome-content"}`}>
          {error && <div className="error-banner" role="alert"><AlertCircle size={19} /><span>{error}</span><button onClick={() => setError(undefined)}>Schließen</button></div>}
          {busy && hasData && <div className="busy-banner" aria-live="polite"><LoaderCircle className="spin" size={18} /> {busyLabel}</div>}
          {!hasData && <><section className="welcome-heading"><span className="eyebrow">Nachvollziehbarer Zahlungsabgleich</span><h1>Belege und Zahlungen.<br />Endlich auf einer Linie.</h1><p>Importiere alle Exporte gemeinsam. buchrec erkennt die Strukturen, bildet Sammelauszahlungen ab und zeigt offen, was noch geprüft werden muss.</p></section><UploadPanel busy={busy} progress={progress} onFiles={handleFiles} onProjectFile={handleProjectFile} /></>}
          {hasData && view === "overview" && <Overview coverage={coverage} hasData={hasData} candidateCount={project.candidates.length} sourceCount={project.sources.length} linkCount={activeLinkCount} onNavigate={setView} />}
          {hasData && view === "sources" && <div className="view-stack"><SourcesPanel sources={project.sources} onShopChange={handleShopChange} onRemove={handleSourceRemove} /><UploadPanel busy={busy} progress={progress} onFiles={handleFiles} onProjectFile={handleProjectFile} /></div>}
          {hasData && view === "matches" && <MatchesPanel links={project.links} candidates={project.candidates} records={project.records} onAccept={handleAccept} onReject={handleReject} />}
          {hasData && view === "exceptions" && <RecordsTable records={project.records} links={project.links} onlyExceptions onDisposition={handleDisposition} onManualLink={handleManualLink} />}
          {hasData && view === "records" && <RecordsTable records={project.records} links={project.links} onDisposition={handleDisposition} onManualLink={handleManualLink} />}
          {hasData && view === "rules" && <div className="view-stack"><RulesPanel settings={project.settings} onChange={handleSettings} /><ShopifyReview records={project.records} rules={project.settings.shopifyRules} onApply={handleShopifyRule} /></div>}
        </main>
      </div>
    </div>
  );
}

export default App;
