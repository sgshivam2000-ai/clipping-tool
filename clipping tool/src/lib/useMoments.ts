import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeMoments, getMomentEngine, getMoments } from "./api";
import { useStore } from "./store";
import type { MomentEngineStatus, MomentOptions, MomentResult, TranscriptStatus } from "./types";


// The containing panel is keyed by project ID, so requests cannot cross projects.
export function useMoments(projectId: string, enabled: boolean, transcriptStatus: TranscriptStatus): MomentApi {
  const { refreshProjects } = useStore();
  const [result, setResult] = useState<MomentResult | null>(null);
  const [engine, setEngine] = useState<MomentEngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const previousStatus = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  const apply = useCallback((next: MomentResult) => {
    setResult(next);
    setError(null);
    if (previousStatus.current !== next.status) void refreshProjects();
    previousStatus.current = next.status;
  }, [refreshProjects]);

  const reload = useCallback(async () => {
    if (!enabled) { setLoading(false); return; }
    const requestId = ++sequence.current;
    try {
      const [state, config] = await Promise.all([getMoments(projectId), getMomentEngine()]);
      if (mounted.current && requestId === sequence.current) {
        apply(state);
        setEngine(config);
      }
    } catch (err) {
      if (mounted.current && requestId === sequence.current) setError(err instanceof Error ? err.message : "Could not load moment analysis.");
    } finally {
      if (mounted.current && requestId === sequence.current) setLoading(false);
    }
  }, [projectId, enabled, apply]);

  useEffect(() => { void reload(); }, [reload, transcriptStatus]);

  useEffect(() => {
    if (!enabled || !result || !["queued", "processing"].includes(result.status)) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      await reload();
      if (!stopped) timer = window.setTimeout(poll, 1800);
    };
    timer = window.setTimeout(poll, 1800);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [result?.status, enabled, reload]);

  const start = useCallback(async (options: MomentOptions) => {
    const requestId = ++sequence.current;
    setStarting(true);
    setError(null);
    try {
      const next = await analyzeMoments(projectId, options);
      if (mounted.current && requestId === sequence.current) apply(next);
    } catch (err) {
      if (mounted.current && requestId === sequence.current) setError(err instanceof Error ? err.message : "Could not start moment analysis.");
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [projectId, apply]);

  return { result, engine, error, loading, starting, start, reload };
}
export interface MomentApi {
  result: MomentResult | null;
  engine: MomentEngineStatus | null;
  error: string | null;
  loading: boolean;
  starting: boolean;
  start: (options: MomentOptions) => Promise<void>;
  reload: () => Promise<void>;
}
