import type { BuchrecProject } from "../types";

const DATABASE = "buchrec-browser-only";
const STORE = "projects";
const KEY = "active-project";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProject(project: BuchrecProject): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(project, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function loadProject(): Promise<BuchrecProject | undefined> {
  const db = await database();
  const project = await new Promise<BuchrecProject | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result as BuchrecProject | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return project;
}

export async function clearProject(): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export function downloadProject(project: BuchrecProject): void {
  const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}.buchrec.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readProjectFile(file: File): Promise<BuchrecProject> {
  const parsed = JSON.parse(await file.text()) as BuchrecProject;
  if (parsed.version !== 1 || !Array.isArray(parsed.sources) || !Array.isArray(parsed.records)) {
    throw new Error("Die Projektdatei hat kein unterstütztes buchrec-Format.");
  }
  return parsed;
}
