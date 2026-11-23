import { useCallback, useEffect, useRef, useState } from "react";
import { deleteReframe, downloadReframe, getReframe, startReframe } from "./api";
import { useStore } from "./store";
import type { ReframeRecord } from "./types";

const ACTIVE = new Set(["queued", "processing"]);

const NONE_REFRAME: Omit<ReframeRecord, "projectId" | "clipId"> = {
  id: null,
  filePath: null,
  outputWidth: null,
  outputHeight: null,
  sourceWidth: null,
  sourceHeight: null,
  aspectRatio: "9:16",
  status: "none",
  progress: 0,
  method: null,
  quality: "standard",
  sizeBytes: null,
  duration: null,
  error: null,
  errorCode: null,
  createdAt: null,
  startedAt: null,
  completedAt: null,
};

/**
 * Loads one clip's reframe and polls only while queued/processing.
 * Terminal states (none, completed, failed) stop polling.
 */
export function useReframe(projectId: string, clipId: string, enabled: boolean) {
  const { toast } = useStore();
  const [reframe, setReframe] = useState<ReframeRecord>({ ...NONE_REFRAME, projectId, clipId });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const requestId = ++sequence.current;
    try {
      const next = await getReframe(projectId, clipId);
      if (mounted.current && requestId === sequence.current) {
        setReframe(next);
        setError(null);
      }
    } catch (err) {
      if (mounted.current && requestId === sequence.current) {
        setError(err instanceof Error ? err.message : "Could not load reframe status.");
      }
    } finally {
      if (mounted.current && requestId === sequence.current) setLoading(false);
    }
  }, [projectId, clipId, enabled]);

  useEffect(() => {
    setReframe({ ...NONE_REFRAME, projectId, clipId });
    setError(null);
    setLoading(true);
    void reload();
  }, [reload, projectId, clipId]);

  const active = ACTIVE.has(reframe.status);
  useEffect(() => {
    if (!enabled || !active) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      await reload();
      if (!stopped) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [active, enabled, reload]);

  const start = useCallback(
    async (quality: string) => {
      const requestId = ++sequence.current;
      setStarting(true);
      setError(null);
      try {
        const next = await startReframe(projectId, clipId, quality);
        if (mounted.current && requestId === sequence.current) setReframe(next);
      } catch (err) {
        if (mounted.current && requestId === sequence.current) {
          const msg = err instanceof Error ? err.message : "Could not start reframing.";
          setError(msg);
          toast(msg, "info");
        }
      } finally {
        if (mounted.current) setStarting(false);
      }
    },
    [projectId, clipId, toast],
  );

  const remove = useCallback(async () => {
    const requestId = ++sequence.current;
    setDeleting(true);
    setError(null);
    try {
      await deleteReframe(projectId, clipId);
      if (mounted.current && requestId === sequence.current) {
        setReframe({ ...NONE_REFRAME, projectId, clipId });
        toast("Reframed video deleted");
      }
    } catch (err) {
      if (mounted.current && requestId === sequence.current) {
        const msg = err instanceof Error ? err.message : "Could not delete reframe.";
        setError(msg);
        toast(msg, "info");
      }
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }, [projectId, clipId, toast]);

  const download = useCallback(
    async (title: string) => {
      setDownloading(true);
      try {
        const filename = `${title.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "clip"}-9x16.mp4`;
        await downloadReframe(projectId, clipId, filename);
        toast(`Download started — ${filename}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Download failed", "info");
      } finally {
        if (mounted.current) setDownloading(false);
      }
    },
    [projectId, clipId, toast],
  );

  return { reframe, error, loading, starting, deleting, downloading, start, remove, download, reload };
}
