import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Info } from "lucide-react";
import { cn } from "@/utils/cn";
import type { CaptionPrefs, Project, StorageMode, UploadState } from "./types";
import {
  ApiError,
  UploadCancelled,
  deleteProjectById,
  getVideoUrl,
  initApi,
  listProjects,
  patchProject,
  uploadProject,
} from "./api";
import { captureThumbnail, probeVideo } from "./video";

export type ToastTone = "success" | "info";
interface Toast {
  id: number;
  msg: string;
  tone: ToastTone;
}

interface StoreValue {
  projects: Project[];
  loading: boolean;
  mode: StorageMode;
  upload: UploadState | null;
  startUpload: (file: File, name: string) => Promise<Project>;
  cancelUpload: () => void;
  dismissUpload: () => void;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  saveCaptionPrefs: (id: string, prefs: CaptionPrefs) => Promise<void>;
  videoUrl: (id: string) => Promise<string>;
  refreshProjects: () => Promise<void>;
  toast: (msg: string, tone?: ToastTone) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<StorageMode>("detecting");
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(1);
  const cancelRef = useRef<(() => void) | null>(null);

  const toast = useCallback((msg: string, tone: ToastTone = "success") => {
    const id = Date.now() * 1000 + idRef.current++;
    setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // Initial load: detect storage backend, then fetch real projects.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const detected = await initApi();
        if (!alive) return;
        setMode(detected);
        const list = await listProjects();
        if (alive) setProjects(list);
      } catch (err) {
        if (alive) toast(err instanceof Error ? err.message : "Could not load projects", "info");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [toast]);

  const startUpload = useCallback(
    async (file: File, name: string): Promise<Project> => {
      setUpload({ fileName: file.name, progress: 0, status: "uploading" });
      try {
        // Real metadata + a real thumbnail frame from the actual file.
        const meta = await probeVideo(file);
        const thumbnail = meta.previewAvailable ? await captureThumbnail(file, meta.durationSeconds) : null;
        const project = await uploadProject(file, name, {
          meta,
          thumbnail,
          onProgress: (pct) => setUpload((u) => (u ? { ...u, progress: pct } : u)),
          registerCancel: (fn) => {
            cancelRef.current = fn;
          },
        });
        cancelRef.current = null;
        setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
        setUpload(null);
        toast(`“${project.name}” uploaded successfully`);
        return project;
      } catch (err) {
        cancelRef.current = null;
        if (err instanceof UploadCancelled) {
          setUpload(null);
          toast("Upload cancelled", "info");
          throw err;
        }
        const msg = err instanceof ApiError ? err.message : "Upload failed unexpectedly. Please try again.";
        setUpload({ fileName: file.name, progress: 0, status: "error", error: msg });
        throw err;
      }
    },
    [toast]
  );

  const cancelUpload = useCallback(() => {
    cancelRef.current?.();
  }, []);

  const dismissUpload = useCallback(() => setUpload(null), []);

  const renameProject = useCallback(
    async (id: string, name: string) => {
      const updated = await patchProject(id, { name });
      setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
      toast(`Project renamed to “${name}”`);
    },
    [toast]
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await deleteProjectById(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast("Project and its video file deleted");
    },
    [toast]
  );

  const saveCaptionPrefs = useCallback(
    async (id: string, prefs: CaptionPrefs) => {
      const updated = await patchProject(id, { captionPrefs: prefs });
      setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
      toast("Caption style saved for this project");
    },
    [toast]
  );

  const videoUrl = useCallback((id: string) => getVideoUrl(id), []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch {
      // Keep the current list if a background refresh fails.
    }
  }, []);

  const value: StoreValue = {
    projects,
    loading,
    mode,
    upload,
    startUpload,
    cancelUpload,
    dismissUpload,
    renameProject,
    deleteProject,
    saveCaptionPrefs,
    videoUrl,
    refreshProjects,
    toast,
  };

  return (
    <StoreContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(92vw,340px)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "animate-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-raised/95 px-4 py-3 text-[13px] font-medium text-fg shadow-2xl shadow-black/50 backdrop-blur",
              t.tone === "success" ? "border-accent/30" : "border-line-2"
            )}
          >
            {t.tone === "success" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-2" />
            )}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </StoreContext.Provider>
  );
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
