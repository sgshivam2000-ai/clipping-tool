import { useCallback, useEffect, useRef, useState } from "react";
import { generateClips, getClips } from "./api";
import { useStore } from "./store";
import type { ClipsSummary } from "./types";

/**
 * Loads the clips for one project and polls while queued/processing.
 * Every status change comes from the server; nothing is faked.
 */
export function useClips(projectId: string, enabled: boolean) {
  const { refreshProjects, toast } = useStore();
  const [summary, setSummary] = useState<ClipsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const previousPhase = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  const apply = useCallback((next: ClipsSummary) => {
    setSummary(next);
    setError(null);
    const phase = next.queued + next.processing > 0 ? "busy" : "idle";
    if (previousPhase.current === "busy" && phase === "idle") void refreshProjects();
    previousPhase.current = phase;
  }, [refreshProjects]);

  const reload = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    const requestId = ++sequence.current;
    try {
      apply(await getClips(projectId));
    } catch (err) {
      if (mounted.current && requestId === sequence.current) {
        setError(err instanceof Error ? err.message : "Could not load clips.");
      }
    } finally {
      if (mounted.current && requestId === sequence.current) setLoading(false);
    }
  }, [projectId, enabled, apply]);

  useEffect(() => { void reload(); }, [reload]);

  const active = !!summary && (summary.queued > 0 || summary.processing > 0);
  useEffect(() => {
    if (!enabled || !active) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await reload();
      if (!stopped) timer = window.setTimeout(poll, 1800);
    };
    timer = window.setTimeout(poll, 1800);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [active, enabled, reload]);

  const start = useCallback(async (candidateIds: string[], quality: string) => {
    if (!enabled || !candidateIds.length) return;
    const requestId = ++sequence.current;
    setStarting(true);
    setError(null);
    try {
      apply(await generateClips(projectId, candidateIds, quality));
    } catch (err) {
      if (mounted.current && requestId === sequence.current) {
        const msg = err instanceof Error ? err.message : "Could not start clip generation.";
        setError(msg);
        toast(msg, "info");
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [enabled, projectId, apply, toast]);

  return { summary, error, loading, starting, start, reload };
}
