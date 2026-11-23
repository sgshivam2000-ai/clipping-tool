"""
CLIPFORGE AI - development backend (Phases 2-4)

Real video upload + project management API:
  - Multipart video upload with format validation and a 2 GB cap
  - Files stored on disk in ./storage, metadata in SQLite (./clipforge.db)
  - FFprobe metadata extraction when ffprobe is available on PATH
  - Project list / details / rename / delete + video file streaming

Run:
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8000

The frontend auto-detects this API at http://localhost:8000/api (or /api when
served behind a same-origin proxy). Without it, the app uses browser-local
IndexedDB storage instead — the API is optional for development.
"""

import json
import re
import shutil
import sqlite3
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from clips import engine as clip_engine
from clips.jobs import ClipQueue
from clips.storage import ClipRepository
from reframing import engine as reframe_engine
from reframing.jobs import ReframeQueue
from reframing.storage import ReframeRepository
from moments.engine import AnalysisOptions, engine_status as moment_engine_status, normalize_transcript
from moments.jobs import MomentQueue
from moments.providers import MomentError, load_provider_config
from moments.storage import MomentRepository
from transcription import (
    ALLOWED_MODELS,
    CONFIG,
    TranscribeOptions,
    TranscriptionQueue,
    engine_status,
    utc_now,
)

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = BASE_DIR / "storage"
DB_PATH = BASE_DIR / "clipforge.db"
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}
MAX_BYTES = 2 * 1024**3  # 2 GB
MIME_BY_EXT = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}

app = FastAPI(title="CLIPFORGE AI API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Database (SQLite via stdlib — no extra dependency)
# --------------------------------------------------------------------------- #

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'Upload',
                status TEXT NOT NULL DEFAULT 'Ready',
                created_at TEXT NOT NULL,
                duration_seconds REAL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                mime_type TEXT NOT NULL DEFAULT '',
                width INTEGER,
                height INTEGER,
                thumbnail TEXT,
                preview_available INTEGER NOT NULL DEFAULT 1,
                caption_prefs TEXT
            )
            """
        )
        # Idempotent migration for Phase 3 transcript columns (safe on Phase 2 databases).
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
        for column, ddl in TRANSCRIPT_COLUMNS.items():
            if column not in existing:
                conn.execute(f"ALTER TABLE projects ADD COLUMN {column} {ddl}")


TRANSCRIPT_COLUMNS: dict[str, str] = {
    "transcript_status": "TEXT NOT NULL DEFAULT 'none'",
    "transcript_stage": "TEXT",
    "transcript_progress": "REAL NOT NULL DEFAULT 0",
    "transcript_model": "TEXT",
    "transcript_language": "TEXT",
    "transcript_language_probability": "REAL",
    "transcript_duration": "REAL",
    "transcript_segments": "TEXT",
    "transcript_error": "TEXT",
    "transcript_started_at": "TEXT",
    "transcript_completed_at": "TEXT",
}


init_db()
moment_repository = MomentRepository(DB_PATH)
moment_repository.recover()
clip_repository = ClipRepository(DB_PATH)
clip_repository.recover()
reframe_repository = ReframeRepository(DB_PATH)
reframe_repository.recover()
project_job_lock = threading.Lock()


def reframe_output_path(project_id: str, clip_id: str) -> Path:
    return STORAGE_DIR / "projects" / project_id / "reframes" / f"{clip_id}.mp4"


def _reframe_source_for(project_id: str, clip_id: str) -> Path | None:
    try:
        clip = clip_repository.get(clip_id)
    except Exception:
        return None
    if clip is None or clip["projectId"] != project_id:
        return None
    file_path = clip.get("filePath")
    if not file_path:
        return None
    return BASE_DIR / file_path


def _reframe_clip_duration_for(project_id: str, clip_id: str) -> float | None:
    try:
        clip = clip_repository.get(clip_id)
    except Exception:
        return None
    if clip is None or clip["projectId"] != project_id:
        return None
    duration = clip.get("duration")
    if isinstance(duration, (int, float)) and float(duration) > 0:
        return float(duration)
    return None


reframe_queue = ReframeQueue(
    reframe_repository, _reframe_source_for, reframe_output_path, _reframe_clip_duration_for, BASE_DIR
)


def clip_output_path(project_id: str, clip_id: str) -> Path:
    return STORAGE_DIR / "projects" / project_id / "clips" / f"{clip_id}.mp4"


def _source_path_for(project_id: str) -> Path | None:
    try:
        row = fetch_project(project_id)
    except HTTPException:
        return None
    if row is None:
        return None
    return BASE_DIR / row["storage_path"]


clip_queue = ClipQueue(clip_repository, _source_path_for, clip_output_path, BASE_DIR)


def _project_clip_counts(project_id: str) -> dict:
    completed, total = clip_repository.counts_for_project(project_id)
    return {"clipsCompleted": completed, "clipsTotal": total}


def row_to_project(row: sqlite3.Row) -> dict:
    prefs = None
    if row["caption_prefs"]:
        try:
            prefs = json.loads(row["caption_prefs"])
        except json.JSONDecodeError:
            prefs = None
    return {
        "id": row["id"],
        "name": row["name"],
        "originalFileName": row["original_filename"],
        "storagePath": row["storage_path"],
        "source": row["source"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "durationSeconds": row["duration_seconds"],
        "sizeBytes": row["size_bytes"],
        "mimeType": row["mime_type"],
        "width": row["width"],
        "height": row["height"],
        "thumbnail": row["thumbnail"],
        "previewAvailable": bool(row["preview_available"]),
        "captionPrefs": prefs,
        "transcriptStatus": row["transcript_status"] or "none",
        "transcriptLanguage": row["transcript_language"],
        **moment_repository.summary(row["id"]),
        **_project_clip_counts(row["id"]),
    }


def fetch_project(project_id: str) -> sqlite3.Row:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    return row


# --------------------------------------------------------------------------- #
# FFprobe metadata extraction (used when available)
# --------------------------------------------------------------------------- #

def probe_with_ffprobe(path: Path):
    """Return {'duration', 'width', 'height'}, 'corrupt', or None if no ffprobe."""
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    try:
        proc = subprocess.run(
            [
                exe, "-v", "error",
                "-print_format", "json",
                "-show_format", "-show_streams",
                str(path),
            ],
            capture_output=True, text=True, timeout=120,
        )
        if proc.returncode != 0:
            return "corrupt"
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), None)
        if video is None:
            return "corrupt"
        fmt = data.get("format", {})
        raw_duration = fmt.get("duration") or video.get("duration")
        return {
            "duration": float(raw_duration) if raw_duration else None,
            "width": video.get("width"),
            "height": video.get("height"),
        }
    except Exception:
        return "corrupt"


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #

@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "clipforge-api",
        "ffprobe": shutil.which("ffprobe") is not None,
        "storage": str(STORAGE_DIR),
    }


@app.post("/api/projects/upload")
async def upload_project(
    file: UploadFile = File(...),
    name: str = Form(""),
    thumbnail: str = Form(""),
    duration_seconds: float | None = Form(None),
    width: int | None = Form(None),
    height: int | None = Form(None),
    preview_available: str = Form("1"),
) -> dict:
    original_filename = file.filename or "video"
    ext = Path(original_filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{ext or 'unknown'}'. Supported formats: MP4, MOV, MKV, WebM.",
        )

    project_id = str(uuid.uuid4())
    stored_name = f"{project_id}{ext}"
    dest = STORAGE_DIR / stored_name

    # Stream to disk with a hard size cap (never trusts Content-Length).
    size = 0
    too_large = False
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    too_large = True
                    break
                out.write(chunk)
    except Exception:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="Storage failure while saving the upload.")

    if too_large:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="File exceeds the 2 GB per-video limit.")
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")

    # Verify + extract metadata with FFprobe when available.
    probed = probe_with_ffprobe(dest)
    if probed == "corrupt":
        dest.unlink(missing_ok=True)
        raise HTTPException(
            status_code=422,
            detail="This video appears to be corrupt or unreadable (FFprobe could not parse it).",
        )
    if isinstance(probed, dict):
        duration_seconds = probed["duration"] if probed["duration"] is not None else duration_seconds
        width = probed["width"] if probed["width"] is not None else width
        height = probed["height"] if probed["height"] is not None else height

    created_at = datetime.now(timezone.utc).isoformat()
    project_name = (name or Path(original_filename).stem).strip()[:200] or Path(original_filename).stem
    relative_path = f"storage/{stored_name}"

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO projects (
                id, name, original_filename, storage_path, source, status, created_at,
                duration_seconds, size_bytes, mime_type, width, height, thumbnail, preview_available
            ) VALUES (?, ?, ?, ?, 'Upload', 'Ready', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id, project_name, original_filename, relative_path, created_at,
                duration_seconds, size, MIME_BY_EXT.get(ext, file.content_type or ""),
                width, height, thumbnail or None, 1 if preview_available == "1" else 0,
            ),
        )
    return row_to_project(fetch_project(project_id))


@app.get("/api/projects")
def list_projects() -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
    return [row_to_project(r) for r in rows]


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    return row_to_project(fetch_project(project_id))


@app.get("/api/projects/{project_id}/file")
def get_project_file(project_id: str):
    row = fetch_project(project_id)
    path = BASE_DIR / row["storage_path"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="The video file is missing from server storage.")
    return FileResponse(
        path,
        media_type=row["mime_type"] or "application/octet-stream",
        filename=row["original_filename"],
    )


class ProjectPatch(BaseModel):
    name: str | None = None
    thumbnail: str | None = None
    captionPrefs: dict | None = None


@app.patch("/api/projects/{project_id}")
def patch_project(project_id: str, patch: ProjectPatch) -> dict:
    fetch_project(project_id)  # 404 if missing
    updates: dict[str, object] = {}
    if patch.name is not None:
        cleaned = patch.name.strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="Project name cannot be empty.")
        updates["name"] = cleaned[:200]
    if patch.thumbnail is not None:
        updates["thumbnail"] = patch.thumbnail
    if patch.captionPrefs is not None:
        updates["caption_prefs"] = json.dumps(patch.captionPrefs)
    if updates:
        assignments = ", ".join(f"{col} = ?" for col in updates)
        with get_db() as conn:
            conn.execute(
                f"UPDATE projects SET {assignments} WHERE id = ?",
                (*updates.values(), project_id),
            )
    return row_to_project(fetch_project(project_id))


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    with project_job_lock:
        row = fetch_project(project_id)
        if transcription_queue.is_active(project_id) or moment_queue.is_active(project_id) or clip_queue.is_active(project_id) or reframe_queue.is_active(project_id):
            raise HTTPException(status_code=409, detail="A job is running for this project. Wait for it to finish before deleting.")
        with get_db() as conn:
            conn.execute("DELETE FROM moment_analyses WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        reframe_repository.delete_for_project(project_id)
        clip_repository.delete_for_project(project_id)
        (BASE_DIR / row["storage_path"]).unlink(missing_ok=True)
        clips_dir = STORAGE_DIR / "projects" / project_id
        if clips_dir.exists():
            shutil.rmtree(clips_dir)
    return {"ok": True, "id": project_id}


# --------------------------------------------------------------------------- #
# Transcription (Phase 3) — FFmpeg audio extraction + faster-whisper
# --------------------------------------------------------------------------- #

_TRANSCRIPT_FIELD_COLUMNS: dict[str, str] = {
    "status": "transcript_status",
    "stage": "transcript_stage",
    "progress": "transcript_progress",
    "model": "transcript_model",
    "language": "transcript_language",
    "languageProbability": "transcript_language_probability",
    "durationSeconds": "transcript_duration",
    "segments": "transcript_segments",
    "error": "transcript_error",
    "startedAt": "transcript_started_at",
    "completedAt": "transcript_completed_at",
}

LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")  # Whisper uses ISO 639-1/3 codes such as "en", "es", "pt"


def write_transcript_state(project_id: str, fields: dict) -> None:
    """Persist transcription state changes. Called from the worker thread."""
    assignments: list[str] = []
    values: list = []
    for key, value in fields.items():
        column = _TRANSCRIPT_FIELD_COLUMNS.get(key)
        if column is None:
            raise ValueError(f"Unknown transcript field: {key}")
        if key == "segments" and value is not None:
            value = json.dumps(value)
        assignments.append(f"{column} = ?")
        values.append(value)
    if not assignments:
        return
    with get_db() as conn:
        conn.execute(
            f"UPDATE projects SET {', '.join(assignments)} WHERE id = ?",
            (*values, project_id),
        )


def recover_interrupted_transcripts() -> None:
    """A restart kills in-flight jobs; mark them failed instead of leaving them 'processing' forever."""
    with get_db() as conn:
        conn.execute(
            """
            UPDATE projects
               SET transcript_status = 'failed',
                   transcript_stage = NULL,
                   transcript_error = 'The server restarted before transcription finished. Run transcription again.',
                   transcript_completed_at = ?
             WHERE transcript_status IN ('queued', 'processing')
            """,
            (utc_now(),),
        )


recover_interrupted_transcripts()
transcription_queue = TranscriptionQueue(sink=write_transcript_state, max_workers=1)


def transcript_payload(row: sqlite3.Row) -> dict:
    status = row["transcript_status"] or "none"
    segments: list = []
    if status == "completed" and row["transcript_segments"]:
        try:
            segments = json.loads(row["transcript_segments"])
        except json.JSONDecodeError:
            segments = []
    return {
        "projectId": row["id"],
        "status": status,
        "stage": row["transcript_stage"],
        "progress": row["transcript_progress"] or 0.0,
        "model": row["transcript_model"],
        "language": row["transcript_language"],
        "languageProbability": row["transcript_language_probability"],
        "durationSeconds": row["transcript_duration"],
        "segmentCount": len(segments),
        "segments": segments,
        "error": row["transcript_error"],
        "startedAt": row["transcript_started_at"],
        "completedAt": row["transcript_completed_at"],
    }


class TranscribeRequest(BaseModel):
    model: str | None = None  # tiny | base | small | medium (default: CLIPFORGE_WHISPER_MODEL)
    language: str | None = None  # e.g. "en"; omit or "auto" for automatic detection


@app.get("/api/transcription/engine")
def get_transcription_engine() -> dict:
    """Which parts of the pipeline (FFmpeg, FFprobe, faster-whisper) are available."""
    return engine_status()


@app.post("/api/projects/{project_id}/transcribe", status_code=202)
def start_transcription(project_id: str, body: TranscribeRequest | None = None) -> dict:
    row = fetch_project(project_id)

    model = ((body.model if body else None) or CONFIG.model).strip().lower()
    if model not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model '{model}'. Choose one of: {', '.join(ALLOWED_MODELS)}.",
        )

    language = ((body.language if body else None) or "").strip().lower() or None
    if language == "auto":
        language = None
    if language is not None and not LANGUAGE_RE.match(language):
        raise HTTPException(
            status_code=400,
            detail="Language must be a short code such as 'en', 'es' or 'pt', or omitted for automatic detection.",
        )

    video_path = BASE_DIR / row["storage_path"]
    if not video_path.exists():
        raise HTTPException(
            status_code=404,
            detail="The source video file is missing from server storage. Re-upload the video to transcribe it.",
        )

    engine = engine_status()
    if not engine["available"]:
        raise HTTPException(
            status_code=503,
            detail="Transcription engine is not ready. Missing: " + "; ".join(engine["missing"]) + ".",
        )

    with project_job_lock:
        fetch_project(project_id)
        if moment_queue.is_active(project_id) or clip_queue.is_active(project_id):
            raise HTTPException(status_code=409, detail="Moment analysis or clip generation is running. Wait before replacing their context.")
        if not transcription_queue.submit(project_id, video_path, TranscribeOptions(model=model, language=language)):
            raise HTTPException(status_code=409, detail="This project is already being transcribed. Wait for the current job to finish.")
        moment_repository.invalidate(project_id)
    return transcript_payload(fetch_project(project_id))


@app.get("/api/projects/{project_id}/transcript")
def get_transcript(project_id: str) -> dict:
    return transcript_payload(fetch_project(project_id))


# Phase 4 selects transcript-backed candidates only; no media files are generated.
def moment_source(project_id: str) -> list[dict]:
    row = fetch_project(project_id)
    if row["transcript_status"] != "completed":
        raise MomentError("Complete transcription before analyzing moments.", "transcript_required", 409)
    try:
        segments = json.loads(row["transcript_segments"] or "[]")
    except (ValueError, TypeError):
        raise MomentError("The stored transcript is unreadable. Re-transcribe this project.", "invalid_transcript") from None
    return normalize_transcript(segments, row["duration_seconds"] or row["transcript_duration"])


moment_queue = MomentQueue(moment_repository, moment_source)


class MomentRequest(BaseModel):
    minDuration: int = 15
    maxDuration: int = 90
    maxCandidates: int = 6


@app.get("/api/moments/engine")
def get_moment_engine() -> dict:
    return moment_engine_status()


@app.post("/api/projects/{project_id}/analyze-moments", status_code=202)
def analyze_moments(project_id: str, body: MomentRequest | None = None) -> dict:
    with project_job_lock:
        row = fetch_project(project_id)
        if transcription_queue.is_active(project_id) or moment_queue.is_active(project_id) or clip_queue.is_active(project_id):
            raise HTTPException(status_code=409, detail="A job is already running for this project.")
        try:
            options = AnalysisOptions(body.minDuration, body.maxDuration, body.maxCandidates) if body else AnalysisOptions()
            options.validate()
            segments = moment_source(project_id)
            if segments[-1]["end"] - segments[0]["start"] < options.min_duration:
                raise MomentError("This transcript is shorter than the minimum candidate duration. Lower the minimum or use a longer video.", "insufficient_context")
            config = load_provider_config()
            moment_queue.submit(project_id, segments, row["duration_seconds"] or row["transcript_duration"], options, config)
        except MomentError as exc:
            raise HTTPException(status_code=exc.http_status, detail=str(exc)) from None
    return moment_repository.get(project_id)


@app.get("/api/projects/{project_id}/moments")
def get_moments(project_id: str) -> dict:
    fetch_project(project_id)
    return moment_repository.get(project_id)


# --------------------------------------------------------------------------- #
# Clip generation (Phase 5) — real FFmpeg cutting from validated candidates
# --------------------------------------------------------------------------- #

MIN_CLIP_SECONDS = 1.0


def _fetch_moment_candidates(project_id: str) -> tuple[sqlite3.Row, dict, dict[str, dict]]:
    row = fetch_project(project_id)
    moment = moment_repository.get(project_id)
    if moment.get("status") != "completed":
        raise MomentError(
            "Complete AI moment analysis before generating clips.", "moments_required", 409
        )
    by_id = {c["id"]: c for c in moment.get("candidates", [])}
    return row, moment, by_id


def _validate_candidate(project_id: str, candidate: dict, source_duration: float | None) -> dict:
    start = float(candidate.get("start", -1))
    end = float(candidate.get("end", -1))
    if not (0 <= start < end):
        raise MomentError(f"Candidate '{candidate.get('title', candidate.get('id'))}' has invalid start/end timestamps.", "invalid_timestamps")
    if end - start < MIN_CLIP_SECONDS:
        raise MomentError(f"Candidate '{candidate.get('title')}' is shorter than {MIN_CLIP_SECONDS:.0f}s.", "invalid_timestamps")
    if end - start > 180:
        raise MomentError(f"Candidate '{candidate.get('title')}' is longer than 180s.", "invalid_timestamps")
    if source_duration is not None and end > source_duration + 1.0:
        raise MomentError(f"Candidate '{candidate.get('title')}' extends beyond the source video.", "invalid_timestamps")
    return candidate


class GenerateClipsRequest(BaseModel):
    candidateIds: list[str] = []
    quality: str = "standard"


class ClipResponse(BaseModel):
    projectId: str
    total: int
    queued: int
    processing: int
    completed: int
    failed: int
    currentClip: dict | None
    clips: list[dict]


def _clip_summary(project_id: str) -> dict:
    summary = clip_repository.summary(project_id)
    current = next((c for c in summary["clips"] if c["status"] == "processing"), None)
    summary["currentClip"] = current
    return summary


@app.post("/api/projects/{project_id}/generate-clips", status_code=202)
def generate_clips(project_id: str, body: GenerateClipsRequest | None = None) -> dict:
    with project_job_lock:
        row = fetch_project(project_id)
        if transcription_queue.is_active(project_id) or moment_queue.is_active(project_id) or clip_queue.is_active(project_id):
            raise HTTPException(status_code=409, detail="A job is already running for this project.")

        quality = (body.quality if body else None) or "standard"
        quality = quality.strip().lower()
        if quality not in clip_engine.ALLOWED_QUALITIES:
            raise HTTPException(status_code=422, detail=f"Unknown quality '{quality}'. Choose low, standard or high.")

        candidate_ids = body.candidateIds if body else []
        if not isinstance(candidate_ids, list) or not candidate_ids:
            raise HTTPException(status_code=422, detail="Select at least one candidate to generate.")
        if len(candidate_ids) > 20:
            raise HTTPException(status_code=422, detail="Generate at most 20 clips in one request.")
        candidate_ids = list(dict.fromkeys(candidate_ids))  # dedupe, keep order
        if any(not isinstance(cid, str) or not cid.strip() for cid in candidate_ids):
            raise HTTPException(status_code=422, detail="Candidate IDs must be non-empty strings.")

        source_path = BASE_DIR / row["storage_path"]
        if not source_path.exists():
            raise HTTPException(status_code=404, detail="The source video file is missing from storage. Re-upload the video first.")

        try:
            clip_engine.require_ffmpeg()
        except clip_engine.ClipError as exc:
            raise HTTPException(status_code=exc.http_status, detail=str(exc)) from None

        try:
            row, moment, by_id = _fetch_moment_candidates(project_id)
            selected = []
            missing = []
            for cid in candidate_ids:
                candidate = by_id.get(cid)
                if candidate is None:
                    missing.append(cid)
                    continue
                _validate_candidate(project_id, candidate, row["duration_seconds"])
                selected.append(candidate)
        except MomentError as exc:
            raise HTTPException(status_code=exc.http_status, detail=str(exc)) from None
        if missing:
            raise HTTPException(
                status_code=422,
                detail="Unknown candidate id(s): " + ", ".join(missing[:5]) + ("..." if len(missing) > 5 else ""),
            )

        clips = []
        for candidate in selected:
            existing = clip_repository.exists_for_candidate(project_id, candidate["id"])
            if existing and existing.get("filePath"):
                stale = BASE_DIR / existing["filePath"]
                if stale.exists():
                    stale.unlink()
            clip = clip_repository.upsert_for_candidate(project_id, candidate, quality)
            clips.append(clip)

        if not clip_queue.submit(project_id, [c["id"] for c in clips]):
            raise HTTPException(status_code=409, detail="Clip generation is already running for this project.")
        return _clip_summary(project_id)


@app.get("/api/projects/{project_id}/clips")
def get_project_clips(project_id: str) -> dict:
    fetch_project(project_id)
    return _clip_summary(project_id)


@app.get("/api/clips/{clip_id}")
def get_clip(clip_id: str) -> dict:
    row = clip_repository.get(clip_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Clip not found.")
    return row


def _clip_file_response(clip_id: str, download: bool) -> FileResponse:
    row = clip_repository.get(clip_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Clip not found.")
    if row["status"] != "completed" or not row.get("filePath"):
        raise HTTPException(status_code=404, detail="This clip has no downloadable file yet.")
    path = BASE_DIR / row["filePath"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="The clip file is missing from storage. Regenerate the clip.")
    safe_title = re.sub(r"[^A-Za-z0-9._-]+", "-", row["title"])[:60].strip("-") or "clip"
    return FileResponse(
        str(path),
        media_type="video/mp4",
        filename=f"{safe_title}-{row['id'][:8]}.mp4",
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/api/clips/{clip_id}/file")
def get_clip_file(clip_id: str):
    return _clip_file_response(clip_id, download=False)


@app.get("/api/clips/{clip_id}/download")
def download_clip(clip_id: str):
    return _clip_file_response(clip_id, download=True)


# --------------------------------------------------------------------------- #
# Reframe (Phase 6) — smart vertical 9:16 rendering of generated clips
# --------------------------------------------------------------------------- #

class ReframeRequest(BaseModel):
    quality: str = "standard"


def _get_reframe_or_404(clip_id: str) -> dict:
    row = reframe_repository.get_for_clip(clip_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No reframe has been created for this clip.")
    return row


@app.post("/api/projects/{project_id}/clips/{clip_id}/reframe", status_code=202)
def start_reframe(project_id: str, clip_id: str, body: ReframeRequest | None = None) -> dict:
    with project_job_lock:
        row = fetch_project(project_id)
        if transcription_queue.is_active(project_id) or moment_queue.is_active(project_id) or clip_queue.is_active(project_id) or reframe_queue.is_active(project_id):
            raise HTTPException(status_code=409, detail="A job is already running for this project.")
        clip_row = clip_repository.get(clip_id)
        if clip_row is None or clip_row["projectId"] != project_id:
            raise HTTPException(status_code=404, detail="Clip not found for this project.")
        if clip_row["status"] != "completed" or not clip_row.get("filePath"):
            raise HTTPException(
                status_code=409,
                detail="This clip is not completed yet. Generate the clip first, then reframe it.",
            )
        clip_file = BASE_DIR / clip_row["filePath"]
        if not clip_file.exists():
            raise HTTPException(status_code=404, detail="The clip file is missing from storage. Regenerate the clip.")

        quality = (body.quality if body else None) or "standard"
        quality = quality.strip().lower()
        if quality not in reframe_engine.ALLOWED_QUALITIES:
            raise HTTPException(status_code=422, detail=f"Unknown quality '{quality}'. Choose low, standard or high.")

        try:
            reframe_engine.require_ffmpeg()
        except reframe_engine.ReframeError as exc:
            raise HTTPException(status_code=exc.http_status, detail=str(exc)) from None

        existing = reframe_repository.get_for_clip(clip_id)
        if existing and existing["status"] in ("queued", "processing"):
            raise HTTPException(status_code=409, detail="This clip is already being reframed.")

        # Row created/reset; remove a previous output only when it has a real path.
        reframe = reframe_repository.upsert_for_clip(project_id, clip_id, quality)
        stale_path = existing.get("filePath") if existing else None
        if stale_path:
            stale_file = BASE_DIR / stale_path
            if stale_file.is_file() and stale_file != reframe_output_path(project_id, clip_id):
                stale_file.unlink()

        if not reframe_queue.submit(project_id, clip_id):
            raise HTTPException(status_code=409, detail="Reframe is already running for this project.")
        return reframe


@app.get("/api/projects/{project_id}/clips/{clip_id}/reframe")
def get_reframe(project_id: str, clip_id: str) -> dict:
    fetch_project(project_id)
    row = reframe_repository.get_for_clip(clip_id)
    if row is None:
        return {"projectId": project_id, "clipId": clip_id, "status": "none", "progress": 0, "method": None,
                "filePath": None, "outputWidth": None, "outputHeight": None, "duration": None,
                "sizeBytes": None, "aspectRatio": "9:16", "error": None, "errorCode": None,
                "createdAt": None, "startedAt": None, "completedAt": None}
    if row["projectId"] != project_id:
        raise HTTPException(status_code=404, detail="Reframe not found for this clip.")
    return row


@app.get("/api/projects/{project_id}/reframes")
def get_all_reframes(project_id: str) -> dict:
    fetch_project(project_id)
    return reframe_repository.summary(project_id)


def _reframe_file_response(project_id: str, clip_id: str, download: bool) -> FileResponse:
    row = reframe_repository.get_for_clip(clip_id)
    if row is None or row["projectId"] != project_id:
        raise HTTPException(status_code=404, detail="Reframe not found for this clip.")
    if row["status"] != "completed" or not row.get("filePath"):
        raise HTTPException(status_code=404, detail="This reframe is not ready yet.")
    path = BASE_DIR / row["filePath"]
    if not path.exists():
        raise HTTPException(status_code=404, detail="The reframed file is missing from storage. Retry reframing.")
    safe_title = re.sub(r"[^A-Za-z0-9._-]+", "-", row.get("clipId") or "")[:60].strip("-") or "reframe"
    safe_title = f"{safe_title}-{row['id'][:8]}"
    return FileResponse(
        str(path),
        media_type="video/mp4",
        filename=f"{safe_title}-9x16.mp4",
        content_disposition_type="attachment" if download else "inline",
    )


@app.get("/api/projects/{project_id}/clips/{clip_id}/reframe/file")
def get_reframe_file(project_id: str, clip_id: str):
    return _reframe_file_response(project_id, clip_id, download=False)


@app.get("/api/projects/{project_id}/clips/{clip_id}/reframe/download")
def download_reframe(project_id: str, clip_id: str):
    return _reframe_file_response(project_id, clip_id, download=True)


@app.delete("/api/projects/{project_id}/clips/{clip_id}/reframe")
def delete_reframe(project_id: str, clip_id: str):
    fetch_project(project_id)
    row = reframe_repository.get_for_clip(clip_id)
    if row is None or row["projectId"] != project_id:
        raise HTTPException(status_code=404, detail="Reframe not found for this clip.")
    if reframe_queue.is_clip_active(clip_id):
        raise HTTPException(status_code=409, detail="Reframe is running for this clip. Wait for it to finish.")
    file_path = row.get("filePath")
    if file_path:
        stale = BASE_DIR / file_path
        if stale.exists():
            stale.unlink()
    reframe_repository.delete_for_clip(clip_id)
    return {"ok": True, "clipId": clip_id}
