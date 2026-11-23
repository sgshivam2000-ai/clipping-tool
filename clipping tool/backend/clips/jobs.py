"""Bounded single-worker clip queue. One project at a time, one clip at a time."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from . import engine
from .storage import ClipRepository, now

log = logging.getLogger("clipforge.clips")


class ClipQueue:
    def __init__(self, repository: ClipRepository, source_path_for: Callable[[str], Optional[Path]],
                 output_path_for: Callable[[str, str], Path], base_dir: Path):
        self.repository = repository
        self.source_path_for = source_path_for
        self.output_path_for = output_path_for
        self.base_dir = base_dir
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clipforge-clips")
        self._lock = threading.Lock()
        self._active: set[str] = set()

    def is_active(self, project_id: str) -> bool:
        with self._lock:
            return project_id in self._active

    def submit(self, project_id: str, clip_ids: list[str]) -> bool:
        with self._lock:
            if project_id in self._active:
                return False
            self._active.add(project_id)
        try:
            self._pool.submit(self._run, project_id, list(clip_ids))
        except Exception:
            with self._lock:
                self._active.discard(project_id)
            raise
        return True

    def _run(self, project_id: str, clip_ids: list[str]) -> None:
        try:
            for clip_id in clip_ids:
                clip = self.repository.get(clip_id)
                if clip is None or clip["projectId"] != project_id:
                    continue  # row deleted between submission and processing

                source = self.source_path_for(project_id)
                if source is None or not source.exists():
                    self.repository.update(clip_id, {
                        "status": "failed",
                        "error": "The source video file is missing from storage. Re-upload the video.",
                        "errorCode": "source_missing",
                        "completedAt": now(),
                    })
                    continue

                self.repository.update(clip_id, {
                    "status": "processing", "progress": 0.0,
                    "startedAt": now(), "error": None, "errorCode": None,
                })
                output = self.output_path_for(project_id, clip_id)
                try:
                    result = engine.cut_clip(
                        source, output,
                        clip["startSeconds"], clip["endSeconds"],
                        clip["quality"],
                        on_progress=lambda pct, _id=clip_id: self.repository.update(_id, {"progress": pct}),
                    )
                    relative = output.resolve().relative_to(self.base_dir.resolve()).as_posix()
                    self.repository.update(clip_id, {
                        "status": "completed", "progress": 100.0,
                        "completedAt": now(),
                        "filePath": relative,
                        "sizeBytes": result.size_bytes,
                        "width": result.width,
                        "height": result.height,
                        "duration": result.duration_seconds,
                    })
                    log.info("Clip %s completed (%d bytes)", clip_id, result.size_bytes)
                except engine.ClipError as exc:
                    log.warning("Clip %s failed [%s]: %s", clip_id, exc.code, str(exc))
                    self.repository.update(clip_id, {
                        "status": "failed",
                        "error": str(exc),
                        "errorCode": exc.code,
                        "completedAt": now(),
                    })
                except Exception as exc:  # never kill the worker silently
                    log.exception("Unexpected clip failure for %s", clip_id)
                    self.repository.update(clip_id, {
                        "status": "failed",
                        "error": "Clip generation failed unexpectedly. Check the backend logs.",
                        "errorCode": "clip_failed",
                        "completedAt": now(),
                    })
        finally:
            with self._lock:
                self._active.discard(project_id)

    def shutdown(self):
        self._pool.shutdown(wait=True)
