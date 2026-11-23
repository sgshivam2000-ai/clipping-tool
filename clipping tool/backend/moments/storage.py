"""Moment jobs use the existing project SQLite database; no secondary database."""

import json
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .engine import PROMPT_VERSION, AnalysisOptions


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class MomentRepository:
    COLUMNS = {
        "status": "status", "stage": "stage", "completedWindows": "completed_windows",
        "totalWindows": "total_windows", "error": "error", "errorCode": "error_code",
        "startedAt": "started_at", "completedAt": "completed_at",
        "candidates": "candidates_json", "warnings": "warnings_json",
    }

    def __init__(self, db_path: Path):
        self.db_path = db_path
        with self.connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS moment_analyses (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    status TEXT NOT NULL DEFAULT 'none', stage TEXT,
                    provider TEXT, model TEXT, transcript_hash TEXT, prompt_version TEXT,
                    options_json TEXT, candidates_json TEXT NOT NULL DEFAULT '[]',
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    completed_windows INTEGER NOT NULL DEFAULT 0,
                    total_windows INTEGER NOT NULL DEFAULT 0,
                    error TEXT, error_code TEXT, started_at TEXT, completed_at TEXT
                )
            """)

    def connect(self):
        conn = sqlite3.connect(self.db_path, timeout=20)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def begin(self, project_id: str, provider: str, model: str, digest: str, options: AnalysisOptions):
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO moment_analyses
                    (project_id, status, provider, model, transcript_hash, prompt_version, options_json)
                VALUES (?, 'queued', ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    status='queued', stage=NULL, provider=excluded.provider, model=excluded.model,
                    transcript_hash=excluded.transcript_hash, prompt_version=excluded.prompt_version,
                    options_json=excluded.options_json, candidates_json='[]', warnings_json='[]',
                    completed_windows=0, total_windows=0, error=NULL, error_code=NULL,
                    started_at=NULL, completed_at=NULL
            """, (project_id, provider, model, digest, PROMPT_VERSION, json.dumps(asdict(options))))

    def update(self, project_id: str, fields: dict):
        assignments, values = [], []
        for key, value in fields.items():
            column = self.COLUMNS[key]
            assignments.append(f"{column} = ?")
            values.append(json.dumps(value, ensure_ascii=False) if key in ("candidates", "warnings") else value)
        if assignments:
            with self.connect() as conn:
                conn.execute(f"UPDATE moment_analyses SET {', '.join(assignments)} WHERE project_id = ?", (*values, project_id))

    def get(self, project_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM moment_analyses WHERE project_id = ?", (project_id,)).fetchone()
        if row is None:
            return {"projectId": project_id, "status": "none", "stage": None, "provider": None, "model": None,
                    "completedWindows": 0, "totalWindows": 0, "candidates": [], "candidateCount": 0,
                    "warnings": [], "error": None, "errorCode": None, "options": None,
                    "startedAt": None, "completedAt": None}
        candidates = json.loads(row["candidates_json"]) if row["status"] == "completed" else []
        return {"projectId": project_id, "status": row["status"], "stage": row["stage"],
                "provider": row["provider"], "model": row["model"],
                "completedWindows": row["completed_windows"], "totalWindows": row["total_windows"],
                "candidates": candidates, "candidateCount": len(candidates), "warnings": json.loads(row["warnings_json"]),
                "error": row["error"], "errorCode": row["error_code"],
                "options": json.loads(row["options_json"]), "startedAt": row["started_at"], "completedAt": row["completed_at"]}

    def summary(self, project_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT status, candidates_json FROM moment_analyses WHERE project_id = ?", (project_id,)).fetchone()
        return {"momentStatus": row["status"] if row else "none",
                "momentCandidateCount": len(json.loads(row["candidates_json"])) if row and row["status"] == "completed" else 0}

    def invalidate(self, project_id: str):
        with self.connect() as conn:
            conn.execute("DELETE FROM moment_analyses WHERE project_id = ?", (project_id,))

    def recover(self):
        with self.connect() as conn:
            conn.execute("""
                UPDATE moment_analyses SET status='failed', stage=NULL, completed_at=?,
                    error='The server restarted before analysis finished. Retry moment analysis.',
                    error_code='server_restarted'
                WHERE status IN ('queued', 'processing')
            """, (now(),))