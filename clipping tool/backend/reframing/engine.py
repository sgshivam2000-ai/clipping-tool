"""Vertical reframe render engine.

Rendering is done with FFmpeg (final video rendering); OpenCV is used only for
sparse frame scanning and subject detection — never as the final renderer or
for invented crop positions. Every crop and scale decision is derived from
actual frame content or a recorded center-crop fallback.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from .analysis import (
    ASPECT_H, ASPECT_W, Anchor, CropGeometry, TrackingTimeline,
    build_crop_x_expression, compute_crop_geometry, interpolate_track,
)
from .detector import DetectorUnavailable, FaceBox, OpenCVFaceDetector, select_primary_face

log = logging.getLogger("clipforge.reframing")


class ReframeError(Exception):
    """A reframe failure with a user-readable message and a machine-readable code."""

    def __init__(self, message: str, code: str = "reframe_failed", http_status: int = 422):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


# Reuse the Phase 5 quality presets; 1080x1920 is the target scale, not the cap.
QUALITY_PRESETS: dict[str, dict[str, str]] = {
    "low": {"crf": "28", "preset": "veryfast", "audio_bitrate": "96k"},
    "standard": {"crf": "23", "preset": "medium", "audio_bitrate": "160k"},
    "high": {"crf": "18", "preset": "slow", "audio_bitrate": "192k"},
}
ALLOWED_QUALITIES = tuple(QUALITY_PRESETS)

OUTPUT_WIDTH = 1080
OUTPUT_HEIGHT = 1920
SAMPLE_INTERVAL_SEC = 0.5  # target cadence of subject sampling
MAX_SAMPLES = 120          # hard cap on detection scan
DETECTOR_INPUT_SIZE = (640, 640)
PROGRESS_THROTTLE_SECONDS = 0.15
FFMPEG_TIMEOUT_S = 1800
SCAN_READ_TIMEOUTS_SECONDS = 120


def ffmpeg_path() -> str:
    name = os.environ.get("CLIPFORGE_FFMPEG", "ffmpeg").strip() or "ffmpeg"
    resolved = shutil.which(name)
    if not resolved:
        raise ReframeError(
            "FFmpeg was not found. Install FFmpeg or set CLIPFORGE_FFMPEG.",
            "ffmpeg_missing", 503,
        )
    return resolved


def ffprobe_path() -> str:
    name = os.environ.get("CLIPFORGE_FFPROBE", "ffprobe").strip() or "ffprobe"
    resolved = shutil.which(name)
    if not resolved:
        raise ReframeError(
            "FFprobe was not found. Install FFmpeg or set CLIPFORGE_FFPROBE.",
            "ffmpeg_missing", 503,
        )
    return resolved


def require_ffmpeg() -> None:
    ffmpeg_path()
    ffprobe_path()


def _run_probe(cmd: list[str], timeout: int = 60, what: str = "video") -> dict:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise ReframeError(f"Reading the {what} timed out.", "ffprobe_failed") from exc
    if proc.returncode != 0:
        tail = " | ".join(line.strip() for line in (proc.stderr or "").splitlines() if line.strip())[-300:]
        raise ReframeError(f"The {what} could not be read by FFprobe. The file may be corrupt. {tail}", "corrupt_source")
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ReframeError(f"FFprobe returned unreadable output for the {what}.", "corrupt_source") from exc


def probe_source(path: Path) -> dict:
    data = _run_probe([
        ffprobe_path(), "-v", "error", "-show_format", "-show_streams",
        "-print_format", "json", str(path),
    ], timeout=120, what="source video")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ReframeError("The source does not contain a video stream.", "corrupt_source")
    duration = None
    try:
        raw = data.get("format", {}).get("duration") or video.get("duration")
        duration = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        duration = None
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    return {
        "duration": duration,
        "width": video.get("width"),
        "height": video.get("height"),
        "has_audio": bool(audio),
        "frame_rate": _frame_rate(video),
    }


def _frame_rate(video: dict) -> float:
    for key in ("r_frame_rate", "avg_frame_rate", "r_frame_rate"):
        raw = video.get(key)
        if not raw:
            continue
        try:
            if "/" in raw:
                num, den = raw.split("/")
                return float(num) / float(den) if float(den) else 0.0
            return float(raw)
        except (ValueError, ZeroDivisionError):
            continue
    return 0.0


# --------------------------------------------------------------------------- #
# Frame scanning / subject detection
# --------------------------------------------------------------------------- #

def _load_cv2():
    try:
        import cv2
        return cv2
    except ImportError as exc:
        raise DetectorUnavailable("OpenCV is not installed.") from exc


def _scan_frames(source: Path, duration: float, geometry: CropGeometry,
                 max_samples: int = MAX_SAMPLES,
                 interval: float = SAMPLE_INTERVAL_SEC,
                 on_progress=None) -> tuple[TrackingTimeline, dict]:
    """Scan the source at sparse intervals, detecting subjects.

    Returns the timeline plus provenance metadata. Detection problems are
    handled honestly: whatever cannot be detected yields center-crop behavior.
    """
    try:
        cv2 = _load_cv2()
    except DetectorUnavailable as exc:
        log.info("Frame scanning disabled: %s", exc)
        timeline = TrackingTimeline(
            method="center-crop-fallback",
            anchors=[Anchor(0.0, geometry.source_width / 2.0), Anchor(duration, geometry.source_width / 2.0)],
            has_face_tracking=False,
            samples_scanned=0, samples_with_faces=0, samples_with_subject=0,
        )
        return timeline, {"reason": "detector-unavailable"}
    detector = _safe_detector(cv2)
    if detector is None:
        # Detector unavailable: honest center-crop fallback.
        timeline = TrackingTimeline(
            method="center-crop-fallback",
            anchors=[Anchor(0.0, geometry.source_width / 2.0), Anchor(duration, geometry.source_width / 2.0)],
            has_face_tracking=False,
            samples_scanned=0, samples_with_faces=0, samples_with_subject=0,
        )
        return timeline, {"reason": "detector-unavailable"}

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        cap.release()
        raise ReframeError("Could not open the source video for frame scanning.", "source_unreadable")

    samples = []
    seen_frames = set()
    times = _sample_times(duration, interval, max_samples)
    last_faces: list[FaceBox] = []
    last_center_x: float | None = None
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        for idx, t in enumerate(times):
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok or frame is None:
                # Skip this sample point; the pipeline tolerates missing samples.
                continue
            seen_frames.add(idx)
            faces = []
            try:
                faces = detector.detect(frame)
            except DetectorUnavailable:
                # Detection unavailable from this point on — keep previous state.
                continue
            subjects = [f for f in faces if f.area > 0]
            # Lock the current subject within a fraction of the frame; fall back to
            # the most prominent face near the frame centre on first sighting.
            lock = geometry.source_width * 0.35 if last_center_x is not None else 0.0
            primary = select_primary_face(subjects, geometry.source_width / 2.0, last_center_x, lock_radius=lock)
            if primary is not None:
                cx, _ = primary.center
                # Clamp to valid crop-center range (full height kept: x-axis).
                half = geometry.crop_width / 2.0
                cx = min(max(cx, half), geometry.source_width - half)
                samples.append((t, cx))
                last_center_x = cx
            else:
                # No subject detected this sample: emit None so the timeline can
                # interpolate between valid anchors instead of snapping.
                samples.append((t, None))
            if on_progress is not None:
                on_progress(0.1 + 0.3 * (idx + 1) / max(len(times), 1))
    finally:
        cap.release()

    samples.append((duration, last_center_x if last_center_x is not None else geometry.source_width / 2.0))

    if not samples:
        # Completely failed to read frames: honest center crop.
        return _center_timeline(geometry, duration), {"reason": "scan-failed"}

    # Stitch timeline from actual samples (with interpolation).
    centers = [(t, c) for t, c in samples]
    samples_with_face = sum(1 for _, c in centers if c is not None)
    samples_with_subject = samples_with_face

    anchors = _build_anchors_from_samples(centers, geometry, duration)

    has_any = samples_with_subject > 0
    timeline = TrackingTimeline(
        method="face-tracked" if has_any else "center-crop-fallback",
        anchors=anchors,
        has_face_tracking=has_any,
        samples_scanned=len(times),
        samples_with_faces=samples_with_face,
        samples_with_subject=samples_with_subject,
    )
    return timeline, {"reason": "faces-detected" if has_any else "no-faces"}


def _safe_detector(cv2):
    try:
        return OpenCVFaceDetector()
    except DetectorUnavailable as exc:
        log.info("Face detector disabled: %s", exc)
        return None


def _sample_times(duration: float, interval: float, limit: int) -> list[float]:
    if duration <= 0:
        return [0.0]
    times: list[float] = []
    t = 0.0
    while t <= duration + 1e-6 and len(times) < limit:
        times.append(t)
        t += interval
    if times[-1] < duration:
        times.append(duration)
    return times


def _center_timeline(geometry: CropGeometry, duration: float) -> TrackingTimeline:
    center = geometry.source_width / 2.0
    return TrackingTimeline(
        method="center-crop-fallback",
        anchors=[Anchor(0.0, center), Anchor(duration, center)],
        has_face_tracking=False,
        samples_scanned=0, samples_with_faces=0, samples_with_subject=0,
    )


def _build_anchors_from_samples(samples: list[tuple[float, float | None]],
                               geometry: CropGeometry, duration: float) -> list[Anchor]:
    """Stitch a sparse set of samples into a smoothed anchor timeline."""
    from .analysis import build_anchors

    samples_sorted = sorted(samples, key=lambda s: s[0])
    result = build_anchors(samples_sorted, geometry, duration)
    # Clamp anchors to the valid crop-center range.
    half = geometry.crop_width / 2.0
    clamp = lambda cx: min(max(cx, half), geometry.source_width - half)
    return [Anchor(a.t, clamp(a.center)) for a in result]


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #

def _parse_out_time(line: str) -> float | None:
    line = line.strip()
    if line.startswith("out_time_us="):
        try:
            return float(line.split("=", 1)[1].strip()) / 1_000_000.0
        except (ValueError, IndexError):
            return None
    match = re.match(r"^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$", line)
    if match:
        try:
            return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
        except ValueError:
            return None
    return None


def _build_render_command(ffmpeg, source, target, duration, crop_expr, geometry, has_audio,
                          quality: str, output_width: int, output_height: int):
    preset = QUALITY_PRESETS[quality]
    crop_w, crop_h = geometry.crop_width, geometry.crop_height
    # Landscape path: y stays 0 (full height kept). Narrow-portrait path: center y.
    if geometry.keep_full_height:
        y_expr = "0"
    else:
        y_expr = f"({geometry.source_height} - {crop_h}) / 2"

    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-t", f"{duration:.3f}",
        "-vf", f"crop={crop_w}:{crop_h}:x='{crop_expr}':y={y_expr},scale={output_width}:{output_height}",
        "-c:v", "libx264",
        "-preset", preset["preset"],
        "-crf", preset["crf"],
        "-pix_fmt", "yuv420p",
    ]
    if has_audio:
        cmd += ["-map", "0:v:0", "-map", "0:a:0?", "-c:a", "aac", "-b:a", preset["audio_bitrate"]]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", str(target)]
    return cmd


@dataclass
class ReframeResult:
    size_bytes: int
    width: int | None
    height: int | None
    duration_seconds: float
    method: str
    anchors: int
    source_width: int | None = None
    source_height: int | None = None


def reframe_clip(source_path: Path, output_path: Path, duration_seconds: float, quality: str,
                 on_progress=None, on_stage=None) -> ReframeResult:
    """Render the vertical reframe from a generated clip.

    The crop expression is built from OpenCV-detected subject anchors; if no
    usable face detection exists, a center-crop expression is used and the
    method is reported honestly.
    """
    ffmpeg = ffmpeg_path()
    preset = QUALITY_PRESETS.get(quality)
    if preset is None:
        raise ReframeError(f"Unknown quality '{quality}'. Choose low, standard or high.", "invalid_quality")

    if not source_path.exists():
        raise ReframeError("The clip file is missing from storage.", "source_missing", 404)
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ReframeError("Clip duration must be a positive number.", "invalid_duration")

    probed = probe_source(source_path)
    source_width = probed.get("width") or 0
    source_height = probed.get("height") or 0
    if source_width <= 0 or source_height <= 0:
        raise ReframeError("The source clip has no readable video dimensions.", "corrupt_source")

    duration = float(probed.get("duration") or duration_seconds)
    if duration <= 0 or duration > 600:
        raise ReframeError("Source duration could not be determined or is unsupported.", "invalid_duration")

    geometry = compute_crop_geometry(source_width, source_height)

    on_stage = on_stage or (lambda stage: None)
    on_stage("analyzing")

    timeline, provenance = _scan_frames(source_path, duration, geometry,
                                        on_progress=lambda frac: on_progress(min(0.40, frac * 0.40)) if on_progress else None)

    on_stage("rendering")
    crop_expr = build_crop_x_expression(timeline, geometry)
    cmd = _build_render_command(
        ffmpeg, source_path, output_path, duration, crop_expr, geometry,
        probed["has_audio"], quality, OUTPUT_WIDTH, OUTPUT_HEIGHT,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as exc:
        raise ReframeError(f"Could not start FFmpeg: {exc}", "ffmpeg_failed") from exc

    last_report = 0.0
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            out_time = _parse_out_time(line)
            if out_time is not None and on_progress is not None:
                now = time.monotonic()
                if now - last_report >= PROGRESS_THROTTLE_SECONDS:
                    fraction = min(0.99, out_time / duration)
                    on_progress(int(40 + fraction * 59.999))
                    last_report = now
        _, stderr = proc.communicate(timeout=FFMPEG_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise ReframeError("Reframe rendering exceeded the time limit and was stopped.", "render_timeout") from None

    if proc.returncode != 0:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        tail = " | ".join(line.strip() for line in (stderr or "").splitlines() if line.strip())[-300:]
        raise ReframeError(f"FFmpeg failed during reframe. {tail}", "ffmpeg_failed")

    if not output_path.exists() or output_path.stat().st_size < 512:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise ReframeError("FFmpeg produced an empty or unreadable reframe.", "output_invalid")

    out_data = _run_probe([
        ffprobe_path(), "-v", "error", "-show_format", "-show_streams", "-print_format", "json", str(output_path),
    ], timeout=60, what="reframed clip")
    out_streams = out_data.get("streams") or []
    out_video = next((s for s in out_streams if s.get("codec_type") == "video"), None)
    if out_video is None:
        raise ReframeError("The reframed clip contains no video stream.", "output_invalid")
    out_duration = None
    try:
        raw = (out_data.get("format", {}) or {}).get("duration")
        out_duration = float(raw) if raw is not None else None
    except (TypeError, ValueError):
        out_duration = None
    if out_duration is None or out_duration < duration - 2.0 or out_duration > duration + 3.0:
        raise ReframeError(
            f"The reframed clip has duration {out_duration}s (expected about {duration:.1f}s).",
            "output_invalid",
        )

    return ReframeResult(
        size_bytes=output_path.stat().st_size,
        width=out_video.get("width"),
        height=out_video.get("height"),
        duration_seconds=round(out_duration, 3),
        method=timeline.method,
        anchors=len(timeline.anchors),
        source_width=source_width,
        source_height=source_height,
    )
