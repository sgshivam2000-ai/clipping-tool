"""Clip jobs persist through the same project SQLite database as everything else."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


CLIP_STATUS = ("queued", "processing", "completed", "failed")


class ClipRepository:
    COLUMNS = {
        "status": "status", "progress": "progress",
        "error": "error", "errorCode": "error_code",
        "startedAt": "started_at", "completedAt": "completed_at",
        "filePath": "file_path", "sizeBytes": "size_bytes",
        "width": "width", "height": "height",
        "quality": "quality", "title": "title", "duration": "duration",
        "rank": "rank", "category": "category", "engagementScore": "engagement_score",
        "startSeconds": "start_seconds", "endSeconds": "end_seconds",
        "candidateId": "candidate_id",
    }

    def __init__(self, db_path: Path):
        self.db_path = db_path
        with self.connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS clips (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    rank INTEGER,
                    category TEXT,
                    engagement_score REAL,
                    start_seconds REAL NOT NULL,
                    end_seconds REAL NOT NULL,
                    duration REAL NOT NULL,
                    quality TEXT NOT NULL DEFAULT 'standard',
                    status TEXT NOT NULL DEFAULT 'queued',
                    progress REAL NOT NULL DEFAULT 0,
                    error TEXT,
                    error_code TEXT,
                    file_path TEXT,
                    size_bytes INTEGER,
                    width INTEGER,
                    height INTEGER,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    UNIQUE(project_id, candidate_id)
                )
            """)

    def connect(self):
        conn = sqlite3.connect(self.db_path, timeout=20)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def upsert_for_candidate(self, project_id: str, candidate: dict, quality: str) -> dict:
        """Create or restart the clip row for this candidate. Returns the clip.

        Existing rows keep their id and created_at so retry/regeneration does
        not orphan the old video file; the caller is responsible for removing
        any previous output file before reprocessing.
        """
        existing = self.exists_for_candidate(project_id, candidate["id"])
        clip_id = existing["id"] if existing else str(uuid.uuid4())
        start = float(candidate["start"])
        end = float(candidate["end"])
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO clips (
                    id, project_id, candidate_id, title, rank, category, engagement_score,
                    start_seconds, end_seconds, duration, quality, status, progress,
                    error, error_code, file_path, size_bytes, width, height,
                    created_at, started_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)
                ON CONFLICT(project_id, candidate_id) DO UPDATE SET
                    title = excluded.title, rank = excluded.rank,
                    category = excluded.category, engagement_score = excluded.engagement_score,
                    start_seconds = excluded.start_seconds, end_seconds = excluded.end_seconds,
                    duration = excluded.duration, quality = excluded.quality, status = 'queued',
                    progress = 0, error = NULL, error_code = NULL, file_path = NULL,
                    size_bytes = NULL, width = NULL, height = NULL, started_at = NULL, completed_at = NULL
            """, (
                clip_id, project_id, candidate["id"], candidate.get("title") or "Clip",
                candidate.get("rank"), candidate.get("category"), candidate.get("engagementScore"),
                start, end, end - start, quality, existing["createdAt"] if existing else now(),
            ))
        return self.get(clip_id)

    def update(self, clip_id: str, fields: dict):
        assignments: list[str] = []
        values: list = []
        for key, value in fields.items():
            column = self.COLUMNS.get(key)
            if column is None:
                raise ValueError(f"Unknown clip field: {key}")
            assignments.append(f"{column} = ?")
            values.append(value)
        if assignments:
            with self.connect() as conn:
                conn.execute(
                    f"UPDATE clips SET {', '.join(assignments)} WHERE id = ?",
                    (*values, clip_id),
                )

    def row_to_clip(self, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "candidateId": row["candidate_id"],
            "title": row["title"],
            "rank": row["rank"],
            "category": row["category"],
            "engagementScore": row["engagement_score"],
            "startSeconds": row["start_seconds"],
            "endSeconds": row["end_seconds"],
            "duration": row["duration"],
            "quality": row["quality"],
            "status": row["status"],
            "progress": row["progress"] or 0.0,
            "error": row["error"],
            "errorCode": row["error_code"],
            "filePath": row["file_path"],
            "sizeBytes": row["size_bytes"],
            "width": row["width"],
            "height": row["height"],
            "createdAt": row["created_at"],
            "startedAt": row["started_at"],
            "completedAt": row["completed_at"],
        }

    def get(self, clip_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM clips WHERE id = ?", (clip_id,)).fetchone()
        return self.row_to_clip(row) if row else None

    def list_for_project(self, project_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM clips WHERE project_id = ? ORDER BY created_at ASC, rowid ASC",
                (project_id,),
            ).fetchall()
        return [self.row_to_clip(r) for r in rows]

    def exists_for_candidate(self, project_id: str, candidate_id: str) -> dict | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM clips WHERE project_id = ? AND candidate_id = ?",
                (project_id, candidate_id),
            ).fetchone()
        return self.row_to_clip(row) if row else None

    def summary(self, project_id: str) -> dict:
        clips = self.list_for_project(project_id)
        counts = {"queued": 0, "processing": 0, "completed": 0, "failed": 0}
        for c in clips:
            counts[c["status"]] = counts.get(c["status"], 0) + 1
        return {
            "projectId": project_id,
            "total": len(clips),
            "queued": counts.get("queued", 0),
            "processing": counts.get("processing", 0),
            "completed": counts.get("completed", 0),
            "failed": counts.get("failed", 0),
            "clips": clips,
        }

    def counts_for_project(self, project_id: str) -> tuple[int, int]:
        """(completed, total) — used for the project list summary."""
        clips = self.list_for_project(project_id)
        return sum(1 for c in clips if c["status"] == "completed"), len(clips)

    def recover(self):
        with self.connect() as conn:
            conn.execute("""
                UPDATE clips SET status='failed', error='The server restarted before this clip was generated. Retry generation.',
                    error_code='server_restarted', completed_at=?
                WHERE status IN ('queued', 'processing')
            """, (now(),))

    def delete_for_project(self, project_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM clips WHERE project_id = ?", (project_id,))
