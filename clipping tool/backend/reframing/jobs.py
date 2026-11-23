"""Bounded single-worker reframe queue. One reframe at a time per project."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from . import engine
from .storage import ReframeRepository, now

log = logging.getLogger("clipforge.reframing")


class ReframeQueue:
    def __init__(self, repository: ReframeRepository,
                 clip_source_for: Callable[[str, str], Optional[Path]],
                 output_path_for: Callable[[str, str], Path],
                 clip_duration_for: Callable[[str, str], Optional[float]],
                 base_dir: Path):
        self.repository = repository
        self.clip_source_for = clip_source_for
        self.output_path_for = output_path_for
        self.clip_duration_for = clip_duration_for
        self.base_dir = base_dir
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clipforge-reframe")
        self._lock = threading.Lock()
        self._active: set[str] = set()
        self._active_clips: set[str] = set()

    def is_active(self, project_id: str) -> bool:
        with self._lock:
            return project_id in self._active

    def is_clip_active(self, clip_id: str) -> bool:
        with self._lock:
            return clip_id in self._active_clips

    def submit(self, project_id: str, clip_id: str) -> bool:
        with self._lock:
            if project_id in self._active:
                return False
            self._active.add(project_id)
            self._active_clips.add(clip_id)
        try:
            self._pool.submit(self._run, project_id, clip_id)
        except Exception:
            with self._lock:
                self._active.discard(project_id)
                self._active_clips.discard(clip_id)
            raise
        return True

    def _run(self, project_id: str, clip_id: str) -> None:
        reframe = self.repository.get_for_clip(clip_id)
        try:
            if reframe is None or reframe["projectId"] != project_id:
                return  # row deleted between submission and processing

            source = self.clip_source_for(project_id, clip_id)
            if source is None or not source.exists():
                self.repository.update(reframe["id"], {
                    "status": "failed",
                    "error": "The source clip file is missing from storage. Regenerate the clip.",
                    "errorCode": "source_missing",
                    "completedAt": now(),
                })
                return

            duration = self.clip_duration_for(project_id, clip_id)
            if duration is None or duration <= 0:
                self.repository.update(reframe["id"], {
                    "status": "failed",
                    "error": "The clip duration is unknown. Regenerate the clip and retry.",
                    "errorCode": "invalid_duration",
                    "completedAt": now(),
                })
                return

            self.repository.update(reframe["id"], {
                "status": "processing", "progress": 0.0,
                "startedAt": now(), "error": None, "errorCode": None,
            })

            output = self.output_path_for(project_id, clip_id)
            result = engine.reframe_clip(
                source, output, duration, reframe.get("quality") or "standard",
                on_progress=lambda pct, _id=reframe["id"]: self.repository.update(_id, {"progress": pct}),
            )
            relative = output.resolve().relative_to(self.base_dir.resolve()).as_posix()
            self.repository.update(reframe["id"], {
                "status": "completed", "progress": 100.0,
                "completedAt": now(),
                "filePath": relative,
                "sizeBytes": result.size_bytes,
                "outputWidth": result.width,
                "outputHeight": result.height,
                "duration": result.duration_seconds,
                "method": result.method,
                "sourceWidth": result.source_width,
                "sourceHeight": result.source_height,
            })
            log.info("Reframe %s completed (%s, %d bytes)", reframe["id"], result.method, result.size_bytes)
        except engine.ReframeError as exc:
            log.warning("Reframe %s failed [%s]: %s", reframe.get("id") if reframe else clip_id, exc.code, str(exc))
            if reframe is not None:
                self.repository.update(reframe["id"], {
                    "status": "failed",
                    "error": str(exc),
                    "errorCode": exc.code,
                    "completedAt": now(),
                })
        except Exception as exc:  # never kill the worker silently
            log.exception("Unexpected reframe failure for %s", clip_id)
            if reframe is not None:
                self.repository.update(reframe["id"], {
                    "status": "failed",
                    "error": "Reframe failed unexpectedly. Check the backend logs.",
                    "errorCode": "reframe_failed",
                    "completedAt": now(),
                })
        finally:
            with self._lock:
                self._active.discard(project_id)
                self._active_clips.discard(clip_id)

    def shutdown(self):
        self._pool.shutdown(wait=True)
