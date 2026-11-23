import type { CaptionPrefs, ClipRecord, ClipsSummary, Project, ReframeRecord, StorageMode, TranscriptResult, TranscriptStatus, MomentEngineStatus, MomentOptions, MomentResult, MomentStatus } from "./types";
import { formatBytes, formatDuration } from "./format";
import * as idb from "./idb";
import type { VideoMeta } from "./video";

/**
 * Data layer with two interchangeable backends:
 *  - "server": the optional FastAPI backend (backend/main.py), auto-detected
 *    at "/api" (same-origin proxy) or "http://localhost:8000/api" (local dev).
 *  - "local":  IndexedDB in the browser — project metadata + video Blobs.
 * Detection runs once at startup; if the backend is unreachable the app
 * falls back to local mode and surfaces clear connection errors on demand.
 */

export class ApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelled";
  }
}

let mode: StorageMode = "detecting";
let apiBase: string | null = null;

export function getStorageMode(): StorageMode {
  return mode;
}
export function getApiBase(): string | null {
  return apiBase;
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    window.clearTimeout(t);
  }
}

export async function initApi(): Promise<StorageMode> {
  if (mode !== "detecting") return mode;
  // A relative "/api" only makes sense when the app is served over http(s), not from file://.
  const candidates = window.location.protocol.startsWith("http") ? ["/api", "http://localhost:8000/api"] : ["http://localhost:8000/api"];
  for (const candidate of candidates) {
    try {
      const res = await fetchWithTimeout(`${candidate}/health`, 1500);
      if (!res.ok) continue;
      const json = (await res.json().catch(() => null)) as { status?: string } | null;
      if (json?.status === "ok") {
        apiBase = candidate;
        mode = "server";
        return mode;
      }
    } catch {
      // unreachable — try next candidate
    }
  }
  mode = "local";
  return mode;
}

/* ------------------------------- normalization ------------------------------ */

type RawProject = Record<string, unknown>;

function normalizeProject(raw: RawProject): Project {
  const durationSeconds = typeof raw.durationSeconds === "number" ? raw.durationSeconds : null;
  const sizeBytes = typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0;
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "Untitled project"),
    originalFileName: String(raw.originalFileName ?? raw.name ?? ""),
    storagePath: String(raw.storagePath ?? ""),
    source: (raw.source as Project["source"]) ?? "Upload",
    status: (raw.status as Project["status"]) ?? "Ready",
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    durationSeconds,
    duration: typeof raw.duration === "string" ? raw.duration : formatDuration(durationSeconds),
    sizeBytes,
    size: typeof raw.size === "string" ? raw.size : formatBytes(sizeBytes),
    mimeType: String(raw.mimeType ?? ""),
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
    thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : null,
    previewAvailable: raw.previewAvailable !== false,
    captionPrefs: (raw.captionPrefs as CaptionPrefs | undefined) ?? undefined,
    transcriptStatus: (raw.transcriptStatus as TranscriptStatus | undefined) ?? "none",
    transcriptLanguage: typeof raw.transcriptLanguage === "string" ? raw.transcriptLanguage : null,
    momentStatus: (raw.momentStatus as MomentStatus | undefined) ?? "none",
    momentCandidateCount: typeof raw.momentCandidateCount === "number" ? raw.momentCandidateCount : 0,
    clipsTotal: typeof raw.clipsTotal === "number" ? raw.clipsTotal : 0,
    clipsCompleted: typeof raw.clipsCompleted === "number" ? raw.clipsCompleted : 0,
  };
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const EXT_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

async function serverError(res: Response, fallback: string): Promise<ApiError> {
  let detail = "";
  try {
    const json = (await res.json()) as { detail?: string };
    detail = json?.detail ?? "";
  } catch {
    // non-JSON error body
  }
  return new ApiError(detail || `${fallback} (HTTP ${res.status})`, res.status);
}

/* --------------------------------- projects -------------------------------- */

export async function listProjects(): Promise<Project[]> {
  if (mode === "server" && apiBase) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${apiBase}/projects`, 10000);
    } catch {
      throw new ApiError("Could not reach the CLIPFORGE server. Check that the backend is running, then reload.");
    }
    if (!res.ok) throw await serverError(res, "Could not load projects");
    const data = (await res.json()) as RawProject[];
    return data.map(normalizeProject);
  }
  try {
    const all = await idb.getAllProjects();
    return all
      .map((p) => normalizeProject(p as unknown as RawProject))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    throw new ApiError("Local browser storage is unavailable. Check your browser settings and try again.");
  }
}

export interface UploadOptions {
  meta: VideoMeta;
  thumbnail: string | null;
  onProgress: (pct: number) => void;
  registerCancel: (fn: () => void) => void;
}

export async function uploadProject(file: File, name: string, opts: UploadOptions): Promise<Project> {
  if (mode === "server" && apiBase) return uploadToServer(file, name, opts);
  return uploadToLocal(file, name, opts);
}

function uploadToServer(file: File, name: string, opts: UploadOptions): Promise<Project> {
  return new Promise<Project>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    opts.registerCancel(() => xhr.abort());
    xhr.open("POST", `${apiBase}/projects/upload`);

    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", name);
    if (opts.thumbnail) fd.append("thumbnail", opts.thumbnail);
    if (opts.meta.durationSeconds != null) fd.append("duration_seconds", String(opts.meta.durationSeconds));
    if (opts.meta.width != null) fd.append("width", String(opts.meta.width));
    if (opts.meta.height != null) fd.append("height", String(opts.meta.height));
    fd.append("preview_available", opts.meta.previewAvailable ? "1" : "0");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(normalizeProject(JSON.parse(xhr.responseText) as RawProject));
        } catch {
          reject(new ApiError("The server returned an unexpected response."));
        }
      } else {
        let detail = "";
        try {
          detail = (JSON.parse(xhr.responseText) as { detail?: string })?.detail ?? "";
        } catch {
          // ignore
        }
        reject(new ApiError(detail || `Upload failed (HTTP ${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () =>
      reject(new ApiError("Could not reach the CLIPFORGE server. Check that the backend is running, then try again."));
    xhr.onabort = () => reject(new UploadCancelled());
    xhr.send(fd);
  });
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const paint = () => new Promise((r) => window.setTimeout(r, 0));

async function uploadToLocal(file: File, name: string, opts: UploadOptions): Promise<Project> {
  const id = uid();
  const record: Project = {
    id,
    name,
    originalFileName: file.name,
    storagePath: `indexeddb://clipforge/videos/${id}`,
    source: "Upload",
    status: "Uploading",
    createdAt: new Date().toISOString(),
    durationSeconds: opts.meta.durationSeconds,
    duration: formatDuration(opts.meta.durationSeconds),
    sizeBytes: file.size,
    size: formatBytes(file.size),
    mimeType: mimeFor(file),
    width: opts.meta.width,
    height: opts.meta.height,
    thumbnail: opts.thumbnail,
    previewAvailable: opts.meta.previewAvailable,
    transcriptStatus: "none",
    transcriptLanguage: null,
    momentStatus: "none",
    momentCandidateCount: 0,
    clipsTotal: 0,
    clipsCompleted: 0,
  };

  try {
    await idb.putProject(record);
  } catch {
    throw new ApiError("Could not access local storage. Your browser may be blocking it or storage is full.");
  }

  let cancelled = false;
  opts.registerCancel(() => {
    cancelled = true;
  });

  try {
    // Read the file in chunks so progress reflects real bytes processed and
    // the upload can be cancelled mid-flight.
    let offset = 0;
    while (offset < file.size) {
      if (cancelled) throw new UploadCancelled();
      const buf = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
      offset += buf.byteLength;
      opts.onProgress(Math.round((offset / file.size) * 100));
      await paint();
    }
    if (cancelled) throw new UploadCancelled();
    await idb.putVideo(id, file);
  } catch (err) {
    await idb.deleteProjectRecord(id).catch(() => undefined);
    if (err instanceof UploadCancelled) throw err;
    throw new ApiError("Could not save the video to local storage. Your browser storage may be full — free up space and retry.");
  }

  const ready: Project = { ...record, status: "Ready" };
  await idb.putProject(ready).catch(() => undefined);
  return ready;
}

export async function patchProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "thumbnail" | "captionPrefs">>
): Promise<Project> {
  if (mode === "server" && apiBase) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${apiBase}/projects/${id}`, 10000, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      throw new ApiError("Could not reach the CLIPFORGE server. Check that the backend is running, then try again.");
    }
    if (!res.ok) throw await serverError(res, "Could not update project");
    return normalizeProject((await res.json()) as RawProject);
  }
  const existing = await idb.getProject(id).catch(() => undefined);
  if (!existing) throw new ApiError("Project not found in local storage.", 404);
  const updated: Project = { ...existing, ...patch };
  await idb.putProject(updated);
  return normalizeProject(updated as unknown as RawProject);
}

export async function deleteProjectById(id: string): Promise<void> {
  revokeVideoUrl(id);
  if (mode === "server" && apiBase) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${apiBase}/projects/${id}`, 10000, { method: "DELETE" });
    } catch {
      throw new ApiError("Could not reach the CLIPFORGE server. Check that the backend is running, then try again.");
    }
    if (!res.ok && res.status !== 404) throw await serverError(res, "Could not delete project");
    return;
  }
  await idb.deleteProjectRecord(id).catch(() => undefined);
  await idb.deleteVideo(id).catch(() => undefined);
}

/* ---------------------------------- video ---------------------------------- */

const objectUrlCache = new Map<string, string>();

export function revokeVideoUrl(id: string): void {
  const url = objectUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrlCache.delete(id);
  }
}

export async function getVideoUrl(id: string): Promise<string> {
  if (mode === "server" && apiBase) return `${apiBase}/projects/${id}/file`;
  const cached = objectUrlCache.get(id);
  if (cached) return cached;
  const blob = await idb.getVideo(id).catch(() => undefined);
  if (!blob) throw new ApiError("The video file is missing from local storage. It may have been cleared by the browser.", 404);
  const url = URL.createObjectURL(blob);
  objectUrlCache.set(id, url);
  return url;
}

/* -------------------------------- transcription ------------------------------ */

export interface TranscribeOptions {
  model: string; // tiny | base | small | medium
  language: string | null; // null = automatic detection
}

export interface EngineStatus {
  available: boolean;
  missing: string[];
  ffmpeg: { found: boolean };
  ffprobe: { found: boolean };
  fasterWhisper: { installed: boolean; version: string | null };
  config: {
    defaultModel: string;
    device: string;
    computeType: string;
    cpuThreads: number;
    customModelDir: boolean;
    audioTimeoutSeconds: number;
  };
  allowedModels: string[];
}

/** AI processing only exists on the backend. Every call goes through here. */
async function serverCall<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  if (mode !== "server" || !apiBase) {
    throw new ApiError(
      "AI processing requires the CLIPFORGE backend, which is not connected. Start the server (see backend/README.md) and reload."
    );
  }
  let res: Response;
  try {
    res = await fetchWithTimeout(`${apiBase}${path}`, timeoutMs, init);
  } catch {
    throw new ApiError("Could not reach the CLIPFORGE server. Check that the backend is running, then try again.");
  }
  if (!res.ok) throw await serverError(res, "Request failed");
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("The server returned an unexpected response.");
  }
}

export function getEngineStatus(): Promise<EngineStatus> {
  return serverCall<EngineStatus>("/transcription/engine");
}

export function getTranscript(projectId: string): Promise<TranscriptResult> {
  return serverCall<TranscriptResult>(`/projects/${projectId}/transcript`);
}

export function startTranscription(projectId: string, opts: TranscribeOptions): Promise<TranscriptResult> {
  return serverCall<TranscriptResult>(`/projects/${projectId}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
}

export function getMomentEngine(): Promise<MomentEngineStatus> {
  return serverCall<MomentEngineStatus>("/moments/engine");
}

export function getMoments(projectId: string): Promise<MomentResult> {
  return serverCall<MomentResult>(`/projects/${encodeURIComponent(projectId)}/moments`);
}

export function analyzeMoments(projectId: string, options: MomentOptions): Promise<MomentResult> {
  return serverCall<MomentResult>(`/projects/${encodeURIComponent(projectId)}/analyze-moments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
}

/* ---------------------------------- clips ---------------------------------- */

function normalizeClip(raw: Record<string, unknown>): ClipRecord {
  const start = typeof raw.startSeconds === "number" ? raw.startSeconds : 0;
  const end = typeof raw.endSeconds === "number" ? raw.endSeconds : 0;
  return {
    id: String(raw.id ?? ""),
    projectId: String(raw.projectId ?? ""),
    candidateId: String(raw.candidateId ?? ""),
    title: String(raw.title ?? "Clip"),
    rank: typeof raw.rank === "number" ? raw.rank : null,
    category: typeof raw.category === "string" ? raw.category : null,
    engagementScore: typeof raw.engagementScore === "number" ? raw.engagementScore : null,
    startSeconds: start,
    endSeconds: end,
    duration: typeof raw.duration === "number" ? raw.duration : Math.max(0, end - start),
    quality: (raw.quality as ClipRecord["quality"]) ?? "standard",
    status: (raw.status as ClipRecord["status"]) ?? "queued",
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    error: typeof raw.error === "string" ? raw.error : null,
    errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
    filePath: typeof raw.filePath === "string" ? raw.filePath : null,
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    width: typeof raw.width === "number" ? raw.width : null,
    height: typeof raw.height === "number" ? raw.height : null,
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

function normalizeSummary(raw: Record<string, unknown>): ClipsSummary {
  const clips = Array.isArray(raw.clips) ? raw.clips.map((c) => normalizeClip(c as Record<string, unknown>)) : [];
  const current = raw.currentClip ? normalizeClip(raw.currentClip as Record<string, unknown>) : (clips.find((c) => c.status === "processing") ?? null);
  return {
    projectId: String(raw.projectId ?? ""),
    total: typeof raw.total === "number" ? raw.total : clips.length,
    queued: typeof raw.queued === "number" ? raw.queued : clips.filter((c) => c.status === "queued").length,
    processing: typeof raw.processing === "number" ? raw.processing : clips.filter((c) => c.status === "processing").length,
    completed: typeof raw.completed === "number" ? raw.completed : clips.filter((c) => c.status === "completed").length,
    failed: typeof raw.failed === "number" ? raw.failed : clips.filter((c) => c.status === "failed").length,
    currentClip: current,
    clips,
  };
}

export function generateClips(projectId: string, candidateIds: string[], quality: string): Promise<ClipsSummary> {
  return serverCall<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/generate-clips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateIds, quality }),
  }).then((raw) => normalizeSummary(raw));
}

export function getClips(projectId: string): Promise<ClipsSummary> {
  return serverCall<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/clips`).then(
    (raw) => normalizeSummary(raw)
  );
}

export function getClip(clipId: string): Promise<ClipRecord> {
  return serverCall<Record<string, unknown>>(`/clips/${encodeURIComponent(clipId)}`).then((raw) =>
    normalizeClip(raw)
  );
}

export function getClipFileUrl(clipId: string): string {
  const base = apiBase ?? "";
  return `${base}/clips/${encodeURIComponent(clipId)}/file`;
}

/** Fetch the clip blob and trigger a real browser download. */
export async function downloadClip(clipId: string, filename: string): Promise<void> {
  const base = apiBase;
  if (!base) throw new ApiError("Clip downloads need the CLIPFORGE backend.");
  const res = await fetchWithTimeout(`${base}/clips/${encodeURIComponent(clipId)}/download`, 60000).catch(() => null);
  if (!res || !res.ok) {
    let detail = "Download failed";
    try {
      const json = (await (res as Response).json().catch(() => null)) as { detail?: string } | null;
      detail = json?.detail ?? detail;
    } catch {
      // keep default
    }
    throw new ApiError(detail, res?.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/* --------------------------------- reframing -------------------------------- */

function normalizeReframe(raw: Record<string, unknown>, projectId: string, clipId: string): ReframeRecord {
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    projectId: String(raw.projectId ?? projectId),
    clipId: String(raw.clipId ?? clipId),
    filePath: typeof raw.filePath === "string" ? raw.filePath : null,
    outputWidth: typeof raw.outputWidth === "number" ? raw.outputWidth : null,
    outputHeight: typeof raw.outputHeight === "number" ? raw.outputHeight : null,
    sourceWidth: typeof raw.sourceWidth === "number" ? raw.sourceWidth : null,
    sourceHeight: typeof raw.sourceHeight === "number" ? raw.sourceHeight : null,
    aspectRatio: typeof raw.aspectRatio === "string" ? raw.aspectRatio : "9:16",
    status: (raw.status as ReframeRecord["status"]) ?? "none",
    progress: typeof raw.progress === "number" ? raw.progress : 0,
    method: typeof raw.method === "string" ? (raw.method as ReframeRecord["method"]) : null,
    quality: (raw.quality as ReframeRecord["quality"]) ?? "standard",
    sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : null,
    duration: typeof raw.duration === "number" ? raw.duration : null,
    error: typeof raw.error === "string" ? raw.error : null,
    errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
  };
}

const projectClipPath = (projectId: string, clipId: string, suffix = "") =>
  `/projects/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(clipId)}/reframe${suffix}`;

export function getReframe(projectId: string, clipId: string): Promise<ReframeRecord> {
  return serverCall<Record<string, unknown>>(projectClipPath(projectId, clipId)).then((raw) =>
    normalizeReframe(raw, projectId, clipId)
  );
}

export function startReframe(projectId: string, clipId: string, quality: string): Promise<ReframeRecord> {
  return serverCall<Record<string, unknown>>(projectClipPath(projectId, clipId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quality }),
  }).then((raw) => normalizeReframe(raw, projectId, clipId));
}

export function deleteReframe(projectId: string, clipId: string): Promise<{ ok: boolean; clipId: string }> {
  return serverCall<{ ok: boolean; clipId: string }>(projectClipPath(projectId, clipId), { method: "DELETE" });
}

export function getReframeFileUrl(projectId: string, clipId: string): string {
  const base = apiBase ?? "";
  return `${base}${projectClipPath(projectId, clipId, "/file")}`;
}

/** Fetch the finished vertical clip and trigger a real browser download. */
export async function downloadReframe(projectId: string, clipId: string, filename: string): Promise<void> {
  const base = apiBase;
  if (!base) throw new ApiError("Reframe downloads need the CLIPFORGE backend.");
  const res = await fetchWithTimeout(`${base}${projectClipPath(projectId, clipId, "/download")}`, 60000).catch(() => null);
  if (!res || !res.ok) {
    let detail = "Download failed";
    try {
      const json = (await (res as Response).json().catch(() => null)) as { detail?: string } | null;
      detail = json?.detail ?? detail;
    } catch {
      // keep default
    }
    throw new ApiError(detail, res?.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
