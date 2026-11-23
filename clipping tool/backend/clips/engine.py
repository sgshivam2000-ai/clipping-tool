"""FFmpeg clip-cutting engine.

Every argument is passed as an argv list (never a shell string), and every
timestamp is validated as a finite number before it reaches FFmpeg. Output is
validated with ffprobe before a clip is reported as completed.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


class ClipError(Exception):
    """A clip failure with a user-readable message and a machine-readable code."""

    def __init__(self, message: str, code: str = "clip_failed", http_status: int = 422):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


# Quality presets: re-encode to a browser-friendly H.264/AAC MP4. No shell
# strings, no user-controlled arguments. Keep predictable values here.
QUALITY_PRESETS: dict[str, dict[str, str]] = {
    "low": {
        "label": "Low",
        "crf": "28",
        "preset": "veryfast",
        "audio_bitrate": "96k",
    },
    "standard": {
        "label": "Standard",
        "crf": "23",
        "preset": "medium",
        "audio_bitrate": "160k",
    },
    "high": {
        "label": "High",
        "crf": "18",
        "preset": "slow",
        "audio_bitrate": "192k",
    },
}
ALLOWED_QUALITIES = tuple(QUALITY_PRESETS)

MIN_CLIP_SECONDS = 1.0
MAX_CLIP_SECONDS = 180.0  # matches the moment analysis maximum
OUTPUT_VALIDATION_MIN_BYTES = 512
PROGRESS_THROTTLE_SECONDS = 0.15
FFMPEG_TIMEOUT_S = 900  # 15 minutes for a single clip


def ffmpeg_path() -> str:
    name = os.environ.get("CLIPFORGE_FFMPEG", "ffmpeg").strip() or "ffmpeg"
    resolved = shutil.which(name)
    if not resolved:
        raise ClipError(
            "FFmpeg was not found. Install FFmpeg (it provides ffmpeg and ffprobe) or set CLIPFORGE_FFMPEG.",
            "ffmpeg_missing", 503,
        )
    return resolved


def ffprobe_path() -> str:
    name = os.environ.get("CLIPFORGE_FFPROBE", "ffprobe").strip() or "ffprobe"
    resolved = shutil.which(name)
    if not resolved:
        raise ClipError(
            "FFprobe was not found. Install FFmpeg (it provides ffmpeg and ffprobe) or set CLIPFORGE_FFPROBE.",
            "ffmpeg_missing", 503,
        )
    return resolved


def require_ffmpeg() -> None:
    """Validate that both tools exist; raises ClipError otherwise."""
    ffmpeg_path()
    ffprobe_path()


def _run_probe(cmd: list[str], timeout: int = 60, what: str = "video") -> dict:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise ClipError(f"Reading the {what} timed out.", "ffprobe_failed") from exc
    if proc.returncode != 0:
        tail = " | ".join(line.strip() for line in (proc.stderr or "").splitlines() if line.strip())[-300:]
        raise ClipError(f"The {what} could not be read by FFprobe. The file may be corrupt. {tail}", "corrupt_source")
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ClipError(f"FFprobe returned unreadable output for the {what}.", "corrupt_source") from exc


def probe_source(path: Path) -> dict:
    """Validate a source video and report duration, size and audio presence."""
    data = _run_probe([
        ffprobe_path(), "-v", "error", "-show_format", "-show_streams",
        "-print_format", "json", str(path),
    ], timeout=120, what="source video")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ClipError("The source does not contain a video stream.", "corrupt_source")
    duration = None
    try:
        raw = data.get("format", {}).get("duration") or video.get("duration")
        duration = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        duration = None
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    return {
        "duration": duration,
        "size": (data.get("format", {}) or {}).get("size"),
        "width": video.get("width"),
        "height": video.get("height"),
        "has_audio": bool(audio),
        "video_codec": video.get("codec_name"),
    }


_RE_OUT_TIME = re.compile(r"^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*$")


def _parse_out_time(line: str) -> float | None:
    """Parse FFmpeg's -progress output into seconds. Prefer out_time_us."""
    line = line.strip()
    if line.startswith("out_time_us="):
        try:
            return float(line.split("=", 1)[1].strip()) / 1_000_000.0
        except (ValueError, IndexError):
            return None
    match = _RE_OUT_TIME.match(line)
    if match:
        try:
            return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
        except ValueError:
            return None
    return None


@dataclass(frozen=True)
class CutResult:
    size_bytes: int
    width: int | None
    height: int | None
    duration_seconds: float


def _build_command(ffmpeg: str, source: Path, target: Path, start: float, duration: float,
                   quality: str, has_audio: bool) -> list[str]:
    preset = QUALITY_PRESETS[quality]
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}",
        "-i", str(source),
        "-t", f"{duration:.3f}",
        "-c:v", "libx264",
        "-preset", preset["preset"],
        "-crf", preset["crf"],
        "-pix_fmt", "yuv420p",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", preset["audio_bitrate"]]
    else:
        cmd += ["-an"]
    cmd += [
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(target),
    ]
    return cmd


def cut_clip(source_path: Path, output_path: Path, start: float, end: float, quality: str,
             on_progress=None) -> CutResult:
    """Cut [start, end) from source into a browser-playable MP4."""
    ffmpeg = ffmpeg_path()
    presets = QUALITY_PRESETS.get(quality)
    if presets is None:
        raise ClipError(f"Unknown quality '{quality}'. Choose low, standard or high.", "invalid_quality")

    # Validate timestamps before touching media.
    if not math.isfinite(start) or not math.isfinite(end):
        raise ClipError("Candidate timestamps must be finite numbers.", "invalid_timestamps")
    if start < 0:
        raise ClipError("Clip start cannot be negative.", "invalid_timestamps")
    if end <= start:
        raise ClipError("Clip end must be after its start.", "invalid_timestamps")
    duration = end - start
    if duration < MIN_CLIP_SECONDS:
        raise ClipError(f"Clip duration is {duration:.1f}s — too short. A clip must be at least {MIN_CLIP_SECONDS:.0f}s.", "invalid_timestamps")
    if duration > MAX_CLIP_SECONDS:
        raise ClipError(f"Clip duration is {duration:.1f}s — too long. The maximum is {MAX_CLIP_SECONDS:.0f}s.", "invalid_timestamps")

    if not source_path.exists():
        raise ClipError("The source video file is missing from storage.", "source_missing", 404)

    probed = probe_source(source_path)
    source_duration = probed.get("duration")
    if source_duration is not None:
        if start >= source_duration:
            raise ClipError("The clip start is beyond the end of the source video.", "invalid_timestamps")
        if end > source_duration + 1.0:
            raise ClipError("The clip end extends beyond the source video. Adjust the candidate boundaries.", "invalid_timestamps")

    target = output_path
    target.parent.mkdir(parents=True, exist_ok=True)
    cmd = _build_command(ffmpeg, source_path, target, start, duration, quality, probed["has_audio"])

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as exc:
        raise ClipError(f"Could not start FFmpeg: {exc}", "ffmpeg_failed") from exc

    last_report = 0.0
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            out_time = _parse_out_time(line)
            if out_time is not None and on_progress is not None:
                now = time.monotonic()
                if now - last_report >= PROGRESS_THROTTLE_SECONDS:
                    fraction = min(0.99, out_time / duration)
                    on_progress(round(fraction * 100.0, 1))
                    last_report = now
        _, stderr = proc.communicate(timeout=FFMPEG_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        raise ClipError("Clip generation exceeded the time limit and was stopped.", "clip_timeout") from None

    if proc.returncode != 0:
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        tail = " | ".join(line.strip() for line in (stderr or "").splitlines() if line.strip())[-300:]
        raise ClipError(f"FFmpeg failed while cutting the clip. {tail}", "ffmpeg_failed")

    # Validate the generated file before reporting success.
    if not target.exists() or target.stat().st_size < OUTPUT_VALIDATION_MIN_BYTES:
        try:
            target.unlink(missing_ok=True)
        except Exception:
            pass
        raise ClipError("FFmpeg produced an empty or unreadable clip.", "output_invalid")

    out_data = _run_probe([
        ffprobe_path(), "-v", "error", "-show_format", "-show_streams", "-print_format", "json", str(target),
    ], timeout=60, what="generated clip")
    out_streams = out_data.get("streams") or []
    out_video = next((s for s in out_streams if s.get("codec_type") == "video"), None)
    if out_video is None:
        raise ClipError("The generated clip contains no video stream.", "output_invalid")
    out_duration = None
    try:
        raw = (out_data.get("format", {}) or {}).get("duration")
        out_duration = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        out_duration = None
    if out_duration is None:
        raise ClipError("The generated clip could not be read by FFprobe.", "output_invalid")
    if out_duration < duration - 2.0 or out_duration > duration + 3.0:
        raise ClipError(
            f"The generated clip has duration {out_duration:.1f}s (expected about {duration:.1f}s).",
            "output_invalid",
        )
    return CutResult(
        size_bytes=target.stat().st_size,
        width=out_video.get("width"),
        height=out_video.get("height"),
        duration_seconds=round(out_duration, 3),
    )
