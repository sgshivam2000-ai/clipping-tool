"""
CLIPFORGE AI — transcription engine (Phase 3).

Pipeline for one project:
  uploaded video  ->  FFmpeg audio extraction (16 kHz mono WAV, temp dir)
                  ->  faster-whisper transcription (real model, real timestamps)
                  ->  timestamped segments returned to the caller

Nothing here is simulated. If a dependency is missing, the video has no audio
track, extraction fails, or the model cannot be loaded, a TranscriptionError
with a specific, user-readable message and code is raised instead.

Configuration (environment variables, all optional):
  CLIPFORGE_WHISPER_MODEL          tiny | base | small | medium      (default: base)
  CLIPFORGE_WHISPER_DEVICE         cpu | cuda | auto                 (default: cpu)
  CLIPFORGE_WHISPER_COMPUTE_TYPE   int8 | int8_float16 | float16 | float32 | default
                                                                     (default: int8)
  CLIPFORGE_WHISPER_MODEL_DIR      directory for model weights        (default: HF cache)
  CLIPFORGE_WHISPER_CPU_THREADS    CPU threads for ctranslate2, 0=auto (default: 0)
  CLIPFORGE_FFMPEG                 ffmpeg executable                  (default: ffmpeg)
  CLIPFORGE_FFPROBE                ffprobe executable                 (default: ffprobe)
  CLIPFORGE_AUDIO_TIMEOUT_S        max seconds for audio extraction   (default: 1800)
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

log = logging.getLogger("clipforge.transcription")

ALLOWED_MODELS: tuple[str, ...] = ("tiny", "base", "small", "medium")
ALLOWED_COMPUTE_TYPES: tuple[str, ...] = (
    "default", "int8", "int8_float16", "float16", "float32",
)
ALLOWED_DEVICES: tuple[str, ...] = ("cpu", "cuda", "auto")


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


@dataclass(frozen=True)
class EngineConfig:
    model: str
    device: str
    compute_type: str
    model_dir: Optional[str]
    cpu_threads: int
    ffmpeg: str
    ffprobe: str
    audio_timeout_s: int


def load_config() -> EngineConfig:
    model = _env("CLIPFORGE_WHISPER_MODEL", "base").lower()
    device = _env("CLIPFORGE_WHISPER_DEVICE", "cpu").lower()
    compute_type = _env("CLIPFORGE_WHISPER_COMPUTE_TYPE", "int8").lower()
    if model not in ALLOWED_MODELS:
        raise RuntimeError(
            f"CLIPFORGE_WHISPER_MODEL='{model}' is invalid. Use one of: {', '.join(ALLOWED_MODELS)}."
        )
    if device not in ALLOWED_DEVICES:
        raise RuntimeError(f"CLIPFORGE_WHISPER_DEVICE='{device}' is invalid. Use one of: {', '.join(ALLOWED_DEVICES)}.")
    if compute_type not in ALLOWED_COMPUTE_TYPES:
        raise RuntimeError(
            f"CLIPFORGE_WHISPER_COMPUTE_TYPE='{compute_type}' is invalid. Use one of: {', '.join(ALLOWED_COMPUTE_TYPES)}."
        )
    try:
        cpu_threads = int(_env("CLIPFORGE_WHISPER_CPU_THREADS", "0"))
        audio_timeout_s = int(_env("CLIPFORGE_AUDIO_TIMEOUT_S", "1800"))
    except ValueError as exc:
        raise RuntimeError("CLIPFORGE_WHISPER_CPU_THREADS and CLIPFORGE_AUDIO_TIMEOUT_S must be integers.") from exc
    model_dir = os.environ.get("CLIPFORGE_WHISPER_MODEL_DIR", "").strip() or None
    return EngineConfig(
        model=model,
        device=device,
        compute_type=compute_type,
        model_dir=model_dir,
        cpu_threads=cpu_threads,
        ffmpeg=_env("CLIPFORGE_FFMPEG", "ffmpeg"),
        ffprobe=_env("CLIPFORGE_FFPROBE", "ffprobe"),
        audio_timeout_s=audio_timeout_s,
    )


CONFIG = load_config()


class TranscriptionError(Exception):
    """A failure with a user-readable message and a machine-readable code."""

    def __init__(self, message: str, code: str = "transcription_failed") -> None:
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tail(text: str, lines: int = 3, limit: int = 300) -> str:
    kept = [line.strip() for line in (text or "").splitlines() if line.strip()][-lines:]
    msg = " | ".join(kept)
    return msg[-limit:] if len(msg) > limit else msg


# --------------------------------------------------------------------------- #
# Dependency checks
# --------------------------------------------------------------------------- #

def _resolve(binary: str) -> Optional[str]:
    return shutil.which(binary)


def faster_whisper_version() -> Optional[str]:
    if importlib.util.find_spec("faster_whisper") is None:
        return None
    try:
        return importlib.metadata.version("faster-whisper")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def engine_status() -> dict[str, Any]:
    """Report which parts of the pipeline are available on this machine."""
    ffmpeg_path = _resolve(CONFIG.ffmpeg)
    ffprobe_path = _resolve(CONFIG.ffprobe)
    fw_version = faster_whisper_version()
    missing: list[str] = []
    if not ffmpeg_path:
        missing.append("ffmpeg (install FFmpeg or set CLIPFORGE_FFMPEG)")
    if not ffprobe_path:
        missing.append("ffprobe (install FFmpeg or set CLIPFORGE_FFPROBE)")
    if fw_version is None:
        missing.append("faster-whisper (pip install -r backend/requirements.txt)")
    return {
        "available": not missing,
        "missing": missing,
        "ffmpeg": {"found": ffmpeg_path is not None},
        "ffprobe": {"found": ffprobe_path is not None},
        "fasterWhisper": {"installed": fw_version is not None, "version": fw_version},
        "config": {
            "defaultModel": CONFIG.model,
            "device": CONFIG.device,
            "computeType": CONFIG.compute_type,
            "cpuThreads": CONFIG.cpu_threads,
            "customModelDir": CONFIG.model_dir is not None,
            "audioTimeoutSeconds": CONFIG.audio_timeout_s,
        },
        "allowedModels": list(ALLOWED_MODELS),
    }


def require_engine() -> None:
    status = engine_status()
    if not status["available"]:
        raise TranscriptionError(
            "Transcription engine is not ready. Missing: " + "; ".join(status["missing"]) + ".",
            "dependency_missing",
        )


def _require_binary(path_or_name: str, label: str) -> str:
    resolved = _resolve(path_or_name)
    if not resolved:
        raise TranscriptionError(
            f"{label} was not found. Install FFmpeg (it provides ffmpeg and ffprobe) or set CLIPFORGE_{label.upper()}.",
            "ffmpeg_missing",
        )
    return resolved


# --------------------------------------------------------------------------- #
# Audio extraction
# --------------------------------------------------------------------------- #

def count_audio_streams(video_path: Path) -> int:
    ffprobe = _require_binary(CONFIG.ffprobe, "ffprobe")
    cmd = [
        ffprobe, "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        str(video_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as exc:
        raise TranscriptionError("Reading the video's streams timed out.", "audio_extraction_failed") from exc
    if proc.returncode != 0:
        raise TranscriptionError(
            "The video could not be read by FFprobe. The file may be corrupt. " + _tail(proc.stderr),
            "audio_extraction_failed",
        )
    return len([line for line in proc.stdout.splitlines() if line.strip()])


def extract_audio(video_path: Path, wav_path: Path) -> None:
    """Extract the first audio track as 16 kHz mono 16-bit PCM WAV (Whisper's native input)."""
    ffmpeg = _require_binary(CONFIG.ffmpeg, "ffmpeg")
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video_path),
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        str(wav_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=CONFIG.audio_timeout_s)
    except subprocess.TimeoutExpired as exc:
        raise TranscriptionError(
            f"Audio extraction exceeded {CONFIG.audio_timeout_s}s and was stopped. Try a shorter video.",
            "audio_timeout",
        ) from exc
    if proc.returncode != 0:
        raise TranscriptionError(
            "FFmpeg failed to extract audio from the video. " + _tail(proc.stderr),
            "audio_extraction_failed",
        )
    # A WAV header alone is 44 bytes; anything smaller means no samples were written.
    if not wav_path.exists() or wav_path.stat().st_size <= 44:
        raise TranscriptionError("Audio extraction produced no audio samples.", "audio_extraction_failed")


# --------------------------------------------------------------------------- #
# faster-whisper model management
# --------------------------------------------------------------------------- #

_model_lock = threading.Lock()
_model_cache: dict[str, Any] = {}


def get_model(size: str) -> Any:
    """Load (and cache) a faster-whisper model. Only one size is kept in memory."""
    from faster_whisper import WhisperModel  # imported lazily: heavy, and optional at import time

    with _model_lock:
        cached = _model_cache.get(size)
        if cached is not None:
            return cached
        _model_cache.clear()  # bound RAM: drop any other model size first
        log.info("Loading faster-whisper model '%s' (device=%s, compute=%s)", size, CONFIG.device, CONFIG.compute_type)
        try:
            model = WhisperModel(
                size,
                device=CONFIG.device,
                compute_type=CONFIG.compute_type,
                download_root=CONFIG.model_dir,
                cpu_threads=CONFIG.cpu_threads,
            )
        except Exception as exc:  # network/download/CUDA/format errors all land here
            raise TranscriptionError(
                f"Could not load the Whisper '{size}' model ({_tail(str(exc), lines=1, limit=200)}). "
                "On first use the model is downloaded from Hugging Face, so the server needs internet access "
                "unless CLIPFORGE_WHISPER_MODEL_DIR points to a local copy.",
                "model_load_failed",
            ) from exc
        _model_cache[size] = model
        return model


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class TranscribeOptions:
    model: str
    language: Optional[str] = None  # None = automatic language detection


# Segment refinement -------------------------------------------------------- #
# Whisper occasionally falls into a repetition loop (one phrase emitted dozens of
# times inside a single very long segment). Those segments have unusable
# timestamps, so they are repaired from per-word timings. Sane segments are kept
# exactly as Whisper produced them.

MAX_SEGMENT_SECONDS = 12.0   # caption-friendly upper bound for one segment
MAX_SEGMENT_WORDS = 28
MIN_REPEAT_LENGTH = 4        # words in a repeated phrase
MAX_REPEAT_LENGTH = 20
MIN_REPEAT_COUNT = 3         # consecutive copies needed to count as a runaway loop


def _norm(word: str) -> str:
    return word.strip().lower().strip(".,!?;:\"'()[]")


def _collapse_repetitions(words: list[dict]) -> tuple[list[dict], bool]:
    """Keep one copy of any phrase repeated MIN_REPEAT_COUNT+ times in a row.

    Each kept word retains its own timestamps, so the timing of what remains is real.
    """
    texts = [_norm(w["word"]) for w in words]
    total = len(words)
    out: list[dict] = []
    changed = False
    i = 0
    while i < total:
        collapsed = False
        for n in range(MIN_REPEAT_LENGTH, MAX_REPEAT_LENGTH + 1):
            if i + n * MIN_REPEAT_COUNT > total:
                break
            phrase = texts[i:i + n]
            copies = 1
            while i + (copies + 1) * n <= total and texts[i + copies * n:i + (copies + 1) * n] == phrase:
                copies += 1
            if copies >= MIN_REPEAT_COUNT:
                out.extend(words[i:i + n])  # keep the first copy only
                i += copies * n
                changed = True
                collapsed = True
                break
        if not collapsed:
            out.append(words[i])
            i += 1
    return out, changed


def _chunk_words(words: list[dict]) -> list[dict]:
    """Group timed words into caption-sized segments, breaking on pauses and sentence ends."""
    chunks: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if current:
            text = "".join(w["word"] for w in current).strip()
            if text:
                chunks.append({"start": current[0]["start"], "end": current[-1]["end"], "text": text})
            current.clear()

    for w in words:
        if current:
            gap = w["start"] - current[-1]["end"]
            span = w["end"] - current[0]["start"]
            if gap > 1.0 or span > MAX_SEGMENT_SECONDS or len(current) >= MAX_SEGMENT_WORDS:
                flush()
        current.append(w)
        if w["word"].rstrip().endswith((".", "?", "!")) and current[-1]["end"] - current[0]["start"] >= 3.0:
            flush()
    flush()
    return chunks


MIN_PIECE_SECONDS = 0.2  # shorter fragments are merged into the previous segment


def _merge_tiny(pieces: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for p in pieces:
        if merged and p["end"] - p["start"] < MIN_PIECE_SECONDS:
            merged[-1]["text"] = f"{merged[-1]['text']} {p['text']}".strip()
            merged[-1]["end"] = max(merged[-1]["end"], p["end"])
        else:
            merged.append(dict(p))
    return merged


def refine_segments(raw: list[dict]) -> list[dict]:
    """Turn Whisper's raw segments into clean, time-ordered transcript segments.

    - Repetition loops are detected over the whole word stream, so loops that
      straddle Whisper's internal windows are also caught.
    - If nothing is pathological, Whisper's own segments are returned unchanged.
    - If a loop was removed or a segment is too long, the transcript is re-chunked
      from the real per-word timings.
    """
    if raw and all(seg["words"] for seg in raw):
        words = [w for seg in raw for w in seg["words"]]
        kept, changed = _collapse_repetitions(words)
        too_long = any(seg["end"] - seg["start"] > MAX_SEGMENT_SECONDS for seg in raw)
        if changed or too_long:
            pieces = _chunk_words(kept)
        else:
            pieces = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in raw]
    else:
        # Word timings unavailable: keep Whisper's segments as they are.
        pieces = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()} for s in raw]

    pieces = [p for p in _merge_tiny(pieces) if p["text"]]
    return [
        {"id": i, "start": round(p["start"], 2), "end": round(p["end"], 2), "text": p["text"]}
        for i, p in enumerate(pieces)
    ]


StageCallback = Callable[[str], None]
ProgressCallback = Callable[[float], None]


def transcribe_video(
    video_path: Path,
    options: TranscribeOptions,
    on_stage: StageCallback,
    on_progress: ProgressCallback,
) -> dict[str, Any]:
    """Synchronous pipeline. Designed to run on a worker thread."""
    if not video_path.exists():
        raise TranscriptionError("The source video file is missing from server storage.", "source_missing")
    require_engine()

    if count_audio_streams(video_path) == 0:
        raise TranscriptionError("This video has no audio track, so there is nothing to transcribe.", "no_audio_track")

    # Temporary WAV lives in a private directory that is always removed, even on failure.
    with tempfile.TemporaryDirectory(prefix="clipforge-audio-") as tmp:
        wav_path = Path(tmp) / "audio.wav"

        on_stage("extracting_audio")
        extract_audio(video_path, wav_path)

        on_stage("loading_model")
        model = get_model(options.model)

        on_stage("transcribing")
        try:
            segment_iter, info = model.transcribe(
                str(wav_path),
                language=options.language,
                task="transcribe",
                beam_size=5,
                vad_filter=True,  # skip silence; reduces hallucinated text
                word_timestamps=True,  # per-word timing, used to repair looping segments
                condition_on_previous_text=False,  # stops errors/loops carrying across 30 s windows
            )
            duration = float(info.duration or 0.0)
            raw: list[dict[str, Any]] = []
            last_report = 0.0
            for seg in segment_iter:  # lazily decodes; each item is a real timed segment
                raw.append(
                    {
                        "start": float(seg.start),
                        "end": float(seg.end),
                        "text": seg.text,
                        "words": [
                            {"word": w.word, "start": float(w.start), "end": float(w.end)}
                            for w in (seg.words or [])
                        ],
                    }
                )
                now = time.monotonic()
                if duration > 0 and now - last_report >= 1.5:
                    # Real progress: how far into the audio decoding has advanced.
                    on_progress(min(99.0, float(seg.end) / duration * 100.0))
                    last_report = now
            segments = refine_segments(raw)
        except TranscriptionError:
            raise
        except Exception as exc:
            raise TranscriptionError(
                "Whisper failed while transcribing this audio. " + _tail(str(exc), lines=1, limit=240),
                "transcription_failed",
            ) from exc

    return {
        "language": info.language,
        "languageProbability": round(float(info.language_probability), 4),
        "durationSeconds": round(duration, 3),
        "segments": segments,
    }


# --------------------------------------------------------------------------- #
# Job queue (single worker = one transcription at a time; keeps RAM/CPU bounded)
# --------------------------------------------------------------------------- #

Sink = Callable[[str, dict[str, Any]], None]


class TranscriptionQueue:
    def __init__(self, sink: Sink, max_workers: int = 1) -> None:
        self._sink = sink
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="clipforge-transcribe")
        self._lock = threading.Lock()
        self._active: set[str] = set()

    def is_active(self, project_id: str) -> bool:
        with self._lock:
            return project_id in self._active

    def submit(self, project_id: str, video_path: Path, options: TranscribeOptions) -> bool:
        """Reserve the project and enqueue a job. Returns False if it is already queued/running."""
        with self._lock:
            if project_id in self._active:
                return False
            self._active.add(project_id)
        try:
            self._sink(project_id, {
                "status": "queued", "stage": None, "progress": 0.0, "model": options.model,
                "language": None, "languageProbability": None, "durationSeconds": None,
                "segments": None, "error": None, "startedAt": None, "completedAt": None,
            })
            self._pool.submit(self._run, project_id, video_path, options)
        except Exception:
            with self._lock:
                self._active.discard(project_id)
            raise
        return True

    def _run(self, project_id: str, video_path: Path, options: TranscribeOptions) -> None:
        try:
            self._sink(project_id, {
                "status": "processing", "stage": "extracting_audio", "progress": 0.0,
                "error": None, "startedAt": utc_now(), "completedAt": None,
            })
            result = transcribe_video(
                video_path,
                options,
                on_stage=lambda stage: self._sink(project_id, {"stage": stage}),
                on_progress=lambda pct: self._sink(project_id, {"progress": round(pct, 1)}),
            )
            self._sink(project_id, {
                "status": "completed", "stage": None, "progress": 100.0,
                "language": result["language"],
                "languageProbability": result["languageProbability"],
                "durationSeconds": result["durationSeconds"],
                "segments": result["segments"],
                "error": None, "completedAt": utc_now(),
            })
            log.info("Transcription complete for %s: %d segments, language=%s",
                     project_id, len(result["segments"]), result["language"])
        except TranscriptionError as exc:
            log.warning("Transcription failed for %s [%s]: %s", project_id, exc.code, exc)
            self._fail(project_id, str(exc))
        except Exception as exc:  # never let a worker die silently
            log.exception("Unexpected transcription error for %s", project_id)
            self._fail(project_id, f"Unexpected transcription error: {exc}")
        finally:
            with self._lock:
                self._active.discard(project_id)

    def _fail(self, project_id: str, message: str) -> None:
        try:
            self._sink(project_id, {
                "status": "failed", "stage": None, "error": message, "completedAt": utc_now(),
            })
        except Exception:
            log.exception("Could not persist failure state for %s", project_id)
