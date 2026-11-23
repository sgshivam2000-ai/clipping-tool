import { useCallback, useEffect, useRef, useState } from "react";
import { getTranscript, startTranscription, type TranscribeOptions } from "./api";
import { useStore } from "./store";
import type { TranscriptResult } from "./types";

const POLL_INTERVAL_MS = 1200;
const IN_PROGRESS = new Set(["queued", "processing"]);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

/**
 * Loads a project's transcript from the backend and, while a job is queued or
 * processing, polls the persisted job state. Nothing is simulated: every status
 * change comes from the server.
 */
export function useTranscript(projectId: string, enabled: boolean) {
  const { refreshProjects } = useStore();
  const [transcript, setTranscript] = useState<TranscriptResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const lastStatus = useRef<string | null>(null);

  const apply = useCallback(
    (next: TranscriptResult) => {
      setTranscript(next);
      setRequestError(null);
      const previous = lastStatus.current;
      lastStatus.current = next.status;
      // When a job leaves the queue/processing states, refresh the project list summary.
      if (previous && IN_PROGRESS.has(previous) && !IN_PROGRESS.has(next.status)) {
        void refreshProjects();
      }
    },
    [refreshProjects]
  );

  const reload = useCallback(async () => {
    if (!enabled || !projectId) return;
    try {
      apply(await getTranscript(projectId));
    } catch (err) {
      setRequestError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [enabled, projectId, apply]);

  // New project (or mode change): reset and load its transcript.
  useEffect(() => {
    setTranscript(null);
    setRequestError(null);
    setLoaded(false);
    lastStatus.current = null;
    void reload();
  }, [projectId, enabled, reload]);

  const status = transcript?.status;
  useEffect(() => {
    if (!status || !enabled || !IN_PROGRESS.has(status)) return;
    const id = window.setInterval(() => void reload(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [status, enabled, reload]);

  const start = useCallback(
    async (opts: TranscribeOptions) => {
      if (!enabled || !projectId) return;
      setStarting(true);
      setRequestError(null);
      try {
        apply(await startTranscription(projectId, opts));
      } catch (err) {
        setRequestError(errorMessage(err));
      } finally {
        setStarting(false);
      }
    },
    [enabled, projectId, apply]
  );

  return { transcript, requestError, starting, loaded, start, reload };
}
