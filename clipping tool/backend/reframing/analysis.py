"""Tracking-timeline computation: crop geometry, smoothing, interpolation.

The pure functions in this module never import OpenCV and never touch media.
They are fully unit-testable. The OpenCV-backed frame scan lives in the render
engine.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

ASPECT_W = 9
ASPECT_H = 16
DETECTOR_INPUT_W = 640
DETECTOR_INPUT_H = 640

# Crop vertical output size when the source is wide enough (full height kept).
MIN_CROP_DIM = 112  # smallest allowed crop side (even)


@dataclass(frozen=True)
class CropGeometry:
    source_width: int
    source_height: int
    crop_width: int
    crop_height: int
    # Starting + maximum offsets — clamp x into [0, max_x] and y into [0, max_y].
    max_x: int
    max_y: int
    keep_full_height: bool  # landscape path vs narrow portrait path

    @property
    def even_crop_width(self) -> int:
        return self.crop_width - (self.crop_width % 2)

    @property
    def even_crop_height(self) -> int:
        return self.crop_height - (self.crop_height % 2)


def compute_crop_geometry(source_width: int, source_height: int,
                         aspect_w: int = ASPECT_W, aspect_h: int = ASPECT_H) -> CropGeometry:
    """Compute the largest 9:16 crop window for the source.

    Landscape / wide sources keep the full height; sources narrower than 9:16
    keep the full width instead — never upscaling beyond source dims.
    """
    if source_width <= 0 or source_height <= 0:
        raise ValueError("Source dimensions must be positive")
    if source_height <= 0 or source_width <= 0:
        raise ValueError("Source dimensions must be positive")
    aspect = aspect_w / aspect_h
    if source_width * aspect_h >= source_height * aspect_w:
        # Wide enough: keep full height, crop width to 9:16.
        crop_height = source_height
        crop_width = int(round(source_height * aspect))
        keep_full_height = True
    else:
        # Narrower than 9:16: keep full width, crop height to 9:16.
        crop_width = source_width
        crop_height = int(round(source_width / aspect))
        keep_full_height = False
    crop_width = max(crop_width, MIN_CROP_DIM)
    crop_height = max(crop_height, MIN_CROP_DIM)
    crop_width = min(crop_width, source_width)
    crop_height = min(crop_height, source_height)
    # Round down to even (4:2:0 video requires even dimensions).
    crop_width -= crop_width % 2
    crop_height -= crop_height % 2
    return CropGeometry(
        source_width=source_width,
        source_height=source_height,
        crop_width=crop_width,
        crop_height=crop_height,
        max_x=max(0, source_width - crop_width),
        max_y=max(0, source_height - crop_height),
        keep_full_height=keep_full_height,
    )


@dataclass(frozen=True)
class Anchor:
    """A single crop-center anchor in clip-local seconds."""
    t: float
    center: float  # crop-center coordinate along the tracked axis, in source pixels


@dataclass
class TrackingTimeline:
    """Smoothed anchors for the crop window, plus honest provenance."""
    method: str  # "face-tracked" | "center-crop-fallback"
    anchors: list[Anchor] = field(default_factory=list)
    has_face_tracking: bool = False
    samples_scanned: int = 0
    samples_with_faces: int = 0
    samples_with_subject: int = 0

    @property
    def duration_seconds(self) -> float:
        return self.anchors[-1].t if self.anchors else 0.0

    @property
    def detected_ratio(self) -> float:
        if self.samples_scanned == 0:
            return 0.0
        return self.samples_with_subject / self.samples_scanned


def build_anchors(samples: list[tuple[float, float | None]],
                  geometry: CropGeometry,
                  duration: float,
                  dead_zone_px: float = 4.0,
                  max_step_per_sample: float | None = None,
                  smoothing: float = 0.32) -> list[Anchor]:
    """Convert raw subject-center samples into a smoothed, clamped anchor timeline.

    samples: list of (t, subject_center_x in source pixels), sorted by t.
             None subject means that frame could not be reliably tracked.
    """
    if not samples:
        center = geometry.source_width / 2.0
        return [Anchor(0.0, center), Anchor(duration, center)]

    # x-tracking: landscape mode tracks horizontally. Narrow-portrait mode also
    # tracks horizontally (crop keeps full width, x=0 always) — fall back to center.
    track_axis = "x"
    crop_center_x_from_geometry = (geometry.crop_width / 2.0)
    bounds = (0 + crop_center_x_from_geometry, geometry.source_width - crop_center_x_from_geometry)

    if max_step_per_sample is None:
        # Aim for bounded camera motion: at most half a crop per 0.5s sample.
        max_step_per_sample = max(geometry.crop_width * 0.65, 40.0)

    # --- interpolate over raw samples -------------------------------
    # Fill missing centers from the nearest valid samples (temporal interpolation).
    valid = [(t, c) for t, c in samples if c is not None]
    if valid:
        last_valid_t, last_valid_c = valid[0]
        filled: list[tuple[float, float]] = []
        for t, c in samples:
            if c is not None:
                last_valid_t, last_valid_c = t, c
                filled.append((t, c))
                continue
            # nearest valid anchor in time
            next_valid = next((v for v in valid if v[0] > t), None)
            if next_valid is not None:
                prev_valid = next((v for v in reversed(valid) if v[0] < t), None)
                if prev_valid is not None:
                    span = next_valid[0] - prev_valid[0]
                    if span > 0:
                        frac = (t - prev_valid[0]) / span
                        filled.append((t, prev_valid[1] + (next_valid[1] - prev_valid[1]) * frac))
                        continue
                # fall through with nearest valid below
            filled.append((t, last_valid_c))
        filled = filled or [(samples[0][0], valid[0][1])]
    else:
        filled = [(samples[0][0], geometry.source_width / 2.0)]

    # --- dead-zone + slope limiter + smoothing ----------------------
    raw_centers: list[tuple[float, float]] = [(t, min(max(c, bounds[0]), bounds[1])) for t, c in filled]

    anchors: list[Anchor] = []
    smoothed = raw_centers[0][1]
    for t, target in raw_centers:
        if abs(target - smoothed) < dead_zone_px:
            # Keep current crop: do not jiggle.
            anchors.append(Anchor(t, smoothed))
            continue
        new = smoothed + (target - smoothed) * smoothing
        # Clamp the step per sample interval.
        step = new - smoothed
        max_step = max_step_per_sample
        if abs(step) > max_step:
            new = smoothed + math.copysign(max_step, step)
        new = min(max(new, bounds[0]), bounds[1])
        if abs(new - smoothed) < dead_zone_px:
            new = smoothed
        smoothed = new
        anchors.append(Anchor(t, smoothed))

    # Always keep the tail anchor to nail the final position.
    if duration > anchors[-1].t:
        anchors.append(Anchor(duration, smoothed))
    return anchors


def interpolate_track(anchors: list[Anchor], t: float) -> float:
    """Piecewise-linear interpolation of crop-center x at time t."""
    if not anchors:
        return 0.0
    if t <= anchors[0].t:
        return anchors[0].center
    if t >= anchors[-1].t:
        return anchors[-1].center
    for i in range(len(anchors) - 1):
        t0, c0 = anchors[i].t, anchors[i].center
        t1, c1 = anchors[i + 1].t, anchors[i + 1].center
        if t0 <= t <= t1:
            span = t1 - t0
            if span <= 0:
                return c0
            frac = (t - t0) / span
            return c0 + (c1 - c0) * frac
    return anchors[-1].center


def crop_x_at(timeline: TrackingTimeline, t: float, geometry: CropGeometry) -> int:
    """Crop left edge (px) for the timeline at time t, clamped to geometry."""
    center = interpolate_track(timeline.anchors, t)
    half = geometry.crop_width / 2.0
    edge = center - half
    return int(round(min(max(edge, 0), geometry.max_x)))


def build_crop_x_expression(timeline: TrackingTimeline, geometry: CropGeometry,
                           anchor_step: float = 0.5, max_anchors: int = 240) -> str:
    """Build an FFmpeg filter expression for the crop left edge.

    Uses a uniform-anchor sum-of-tents interpolation, which FFmpeg evaluates
    per frame: x(t) is the piecewise-linear interpolation of the smoothed
    centers, clamped to the valid range.

    Anchor count is bounded by duration and step. The center input must cover
    [0, duration].
    """
    anchors = timeline.anchors
    if not anchors:
        return "0"

    duration = anchors[-1].t
    if duration <= 0:
        return f"{crop_x_at(timeline, 0, geometry):.2f}"

    # Uniform grid spanning exactly [0, duration].
    step = anchor_step
    k = math.ceil(duration / step)
    if k <= 0:
        k = 1
    if k > max_anchors - 1:
        step = duration / (max_anchors - 1)
        k = max_anchors - 1
    if k < 1:
        k = 1
    step = duration / k

    half = geometry.crop_width / 2.0

    def left_edge(center: float) -> float:
        return min(max(center - half, 0.0), float(geometry.max_x))

    # Resample the smoothed timeline onto the uniform grid, then express the
    # crop left edge as a sum of tent functions, which interpolates piecewise
    # linearly at uniform spacing. This is exact for uniform spacing.
    points: list[tuple[float, float]] = []
    for i in range(k + 1):
        t = i * step
        center = interpolate_track(anchors, t)
        points.append((t, left_edge(center)))

    if len(points) == 1:
        return f"{points[0][1]:.2f}"

    parts = []
    for t_j, x_j in points:
        parts.append(f"({x_j:.2f} * max(0, 1 - abs(t - {t_j:.3f}) / {step:.4f}))")
    return " + ".join(parts)
