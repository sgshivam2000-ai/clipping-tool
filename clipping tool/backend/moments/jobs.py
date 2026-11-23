"""Bounded single-worker jobs, following the Phase 3 persisted queue pattern."""

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from .engine import AnalysisOptions, analyze, transcript_hash
from .providers import MomentError, ProviderConfig, create_provider
from .storage import MomentRepository, now

log = logging.getLogger("clipforge.moments")


class MomentQueue:
    def __init__(self, repository: MomentRepository, current_transcript: Callable[[str], list[dict]],
                 provider_factory=create_provider):
        self.repository = repository
        self.current_transcript = current_transcript
        self.provider_factory = provider_factory
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clipforge-moments")
        self._lock = threading.Lock()
        self._active: set[str] = set()

    def is_active(self, project_id: str) -> bool:
        with self._lock:
            return project_id in self._active

    def submit(self, project_id: str, segments: list[dict], duration: float | None,
               options: AnalysisOptions, config: ProviderConfig) -> bool:
        with self._lock:
            if project_id in self._active:
                return False
            if len(self._active) >= 8:
                raise MomentError("The moment analysis queue is full. Try again after a job finishes.", "queue_full", 429)
            self._active.add(project_id)
        try:
            digest = transcript_hash(segments)
            self.repository.begin(project_id, config.provider, config.model, digest, options)
            self._pool.submit(self._run, project_id, segments, duration, options, config, digest)
        except Exception:
            try:
                self.repository.update(project_id, {"status": "failed", "stage": None, "completedAt": now(),
                                                   "error": "Could not enqueue moment analysis. Retry after checking backend storage.",
                                                   "errorCode": "queue_error"})
            except Exception:
                log.error("Could not persist queue failure for %s", project_id)
            finally:
                with self._lock:
                    self._active.discard(project_id)
            raise
        return True

    def _run(self, project_id, segments, duration, options, config, digest):
        try:
            self.repository.update(project_id, {"status": "processing", "stage": "preparing_context", "startedAt": now()})
            result = analyze(segments, duration, options, self.provider_factory(config),
                             lambda fields: self.repository.update(project_id, fields))
            if transcript_hash(self.current_transcript(project_id)) != digest:
                raise MomentError("The transcript changed during analysis. Run analysis again on the latest transcript.", "transcript_changed")
            self.repository.update(project_id, {"status": "completed", "stage": None,
                                               "completedAt": now(), **result})
        except Exception as exc:
            known = isinstance(exc, MomentError)
            message = str(exc) if known else "Moment analysis failed unexpectedly. Check the backend and retry."
            code = exc.code if known else "analysis_failed"
            log.warning("Moment analysis failed for %s (%s)", project_id, code)
            self.repository.update(project_id, {"status": "failed", "stage": None, "completedAt": now(),
                                               "error": message, "errorCode": code, "candidates": []})
        finally:
            with self._lock:
                self._active.discard(project_id)

    def shutdown(self):
        self._pool.shutdown(wait=True)