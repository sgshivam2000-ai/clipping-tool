import type { Project } from "./types";

/**
 * IndexedDB persistence for local (no-backend) mode.
 * - "projects" store: project metadata records (keyPath: id)
 * - "videos" store: the actual uploaded video Blobs, keyed by project id
 */

const DB_NAME = "clipforge";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("videos")) db.createObjectStore("videos");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function getAllProjects(): Promise<Project[]> {
  return run("projects", "readonly", (s) => s.getAll() as IDBRequest<Project[]>);
}

export function getProject(id: string): Promise<Project | undefined> {
  return run("projects", "readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
}

export function putProject(project: Project): Promise<void> {
  return run("projects", "readwrite", (s) => s.put(project) as unknown as IDBRequest<void>);
}

export function deleteProjectRecord(id: string): Promise<void> {
  return run("projects", "readwrite", (s) => s.delete(id) as unknown as IDBRequest<void>);
}

export function putVideo(id: string, blob: Blob): Promise<void> {
  return run("videos", "readwrite", (s) => s.put(blob, id) as unknown as IDBRequest<void>);
}

export function getVideo(id: string): Promise<Blob | undefined> {
  return run("videos", "readonly", (s) => s.get(id) as IDBRequest<Blob | undefined>);
}

export function deleteVideo(id: string): Promise<void> {
  return run("videos", "readwrite", (s) => s.delete(id) as unknown as IDBRequest<void>);
}
