"""Reframe jobs persist through the same project SQLite database."""

from __future__ import annotations

import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


REFRAME_STATUS = ("queued", "processing", "completed", "failed")


class ReframeRepository:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        with self.connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS reframes (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    clip_id TEXT NOT NULL UNIQUE REFERENCES clips(id) ON DELETE CASCADE,
                    file_path TEXT,
                    output_width INTEGER,
                    output_height INTEGER,
                    source_width INTEGER,
                    source_height INTEGER,
                    aspect_ratio TEXT NOT NULL DEFAULT '9:16',
                    status TEXT NOT NULL DEFAULT 'queued',
                    progress REAL NOT NULL DEFAULT 0,
                    method TEXT,
                    size_bytes INTEGER,
                    duration REAL,
                    quality TEXT NOT NULL DEFAULT 'standard',
                    error TEXT,
                    error_code TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_reframes_project ON reframes(project_id)")

    def connect(self):
        conn = sqlite3.connect(self.db_path, timeout=20)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def upsert_for_clip(self, project_id: str, clip_id: str, quality: str) -> dict:
        """Create or restart the reframe row for this clip. Returns the row."""
        existing = self.get_for_clip(clip_id)
        reframe_id = existing["id"] if existing else str(uuid.uuid4())
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO reframes (
                    id, project_id, clip_id, status, progress, quality,
                    created_at, started_at, completed_at, error, error_code, file_path,
                    output_width, output_height, source_width, source_height,
                    aspect_ratio, method, size_bytes, duration
                ) VALUES (?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '9:16', NULL, NULL, NULL)
                ON CONFLICT(clip_id) DO UPDATE SET
                    status = 'queued', progress = 0, quality = excluded.quality,
                    started_at = NULL, completed_at = NULL, error = NULL, error_code = NULL,
                    file_path = NULL, method = NULL, size_bytes = NULL, duration = NULL,
                    output_width = NULL, output_height = NULL, source_width = NULL, source_height = NULL
            """, (reframe_id, project_id, clip_id, quality,
                  existing["createdAt"] if existing else now()))
        return self.get_for_clip(clip_id)

    def update(self, reframe_id: str, fields: dict):
        columns = {
            "status": "status", "progress": "progress", "method": "method",
            "error": "error", "errorCode": "error_code",
            "filePath": "file_path", "sizeBytes": "size_bytes", "duration": "duration",
            "outputWidth": "output_width", "outputHeight": "output_height",
            "sourceWidth": "source_width", "sourceHeight": "source_height",
            "startedAt": "started_at", "completedAt": "completed_at",
            "aspectRatio": "aspect_ratio", "quality": "quality",
        }
        assignments, values = [], []
        for key, value in fields.items():
            column = columns.get(key)
            if column is None:
                raise ValueError(f"Unknown reframe field: {key}")
            assignments.append(f"{column} = ?")
            values.append(value)
        if assignments:
            with self.connect() as conn:
                conn.execute(f"UPDATE reframes SET {', '.join(assignments)} WHERE id = ?", (*values, reframe_id))

    def row_to_reframe(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "clipId": row["clip_id"],
            "filePath": row["file_path"],
            "outputWidth": row["output_width"],
            "outputHeight": row["output_height"],
            "sourceWidth": row["source_width"],
            "sourceHeight": row["source_height"],
            "aspectRatio": row["aspect_ratio"],
            "status": row["status"],
            "progress": row["progress"] or 0.0,
            "method": row["method"],
            "quality": row["quality"],
            "sizeBytes": row["size_bytes"],
            "duration": row["duration"],
            "error": row["error"],
            "errorCode": row["error_code"],
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
        }

    def get_for_clip(self, clip_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM reframes WHERE clip_id = ?", (clip_id,)).fetchone()
        return self.row_to_reframe(row) if row else None

    def get(self, reframe_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM reframes WHERE id = ?", (reframe_id,)).fetchone()
        return self.row_to_reframe(row) if row else None

    def list_for_project(self, project_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM reframes WHERE project_id = ? ORDER BY created_at ASC, rowid ASC",
                (project_id,),
            ).fetchall()
        return [self.row_to_reframe(r) for r in rows]

    def summary(self, project_id: str) -> dict:
        reframes = self.list_for_project(project_id)
        counts = {"queued": 0, "processing": 0, "completed": 0, "failed": 0}
        for r in reframes:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        return {
            "projectId": project_id,
            "total": len(reframes),
            "queued": counts.get("queued", 0),
            "processing": counts.get("processing", 0),
            "completed": counts.get("completed", 0),
            "failed": counts.get("failed", 0),
            "reframes": reframes,
        }

    def recover(self):
        with self.connect() as conn:
            conn.execute("""
                UPDATE reframes SET status='failed', error='The server restarted before this reframe was rendered. Retry reframing.',
                    error_code='server_restarted', completed_at=?
                WHERE status IN ('queued', 'processing')
            """, (now(),))

    def delete_for_clip(self, clip_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM reframes WHERE clip_id = ?", (clip_id,))

    def delete_for_project(self, project_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM reframes WHERE project_id = ?", (project_id,))
