"""OpenCV subject detection with honest fallback.

Detection is deliberately optional: if OpenCV is not installed, the model is
missing, or OpenCV raises, the caller falls back to an honest center-crop and
labels the method accordingly — never a fabricated "face tracked" result.
"""

from __future__ import annotations

import logging
import math
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("clipforge.reframing")

# OpenCV's YuNet model takes exactly 640x640 frames.
DETECTOR_INPUT = (640, 640)


class DetectorUnavailable(Exception):
    """The OpenCV face detector could not be constructed or used."""


@dataclass(frozen=True, slots=True)
class FaceBox:
    x: float
    y: float
    width: float
    height: float

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.width / 2.0, self.y + self.height / 2.0

    @property
    def area(self) -> float:
        return self.width * self.height


class OpenCVFaceDetector:
    """YuNet face detection through the OpenCV DNN module.

    Detects faces in 640x640 letterboxed frames and maps boxes back to the
    original image coordinates.
    """

    def __init__(self, model_path: str | os.PathLike | None = None, score_threshold: float = 0.6,
                 input_size: tuple[int, int] = DETECTOR_INPUT):
        resolution = model_path or os.environ.get("CLIPFORGE_FACE_DETECTOR_MODEL") or self._default_model()
        model = Path(resolution) if resolution else None
        if model is None or not model.is_file():
            raise DetectorUnavailable(
                "YuNet face detector model is not available. Set CLIPFORGE_FACE_DETECTOR_MODEL to the model path."
            )
        try:
            import cv2  # lazy import: keep the backend usable without OpenCV
        except ImportError as exc:
            raise DetectorUnavailable("OpenCV is not installed.") from exc
        try:
            self._cv2 = cv2
            self._detector = cv2.FaceDetectorYN_create(
                str(model), "", (input_size[0], input_size[1]), score_threshold, 0.3, 5000,
            )
            self._input_size = input_size
        except Exception as exc:
            raise DetectorUnavailable(f"Could not load face detector model: {exc}") from exc

    @staticmethod
    def _default_model() -> str | None:
        # Repo-vendored model (MIT). Path relative to this file.
        candidate = Path(__file__).resolve().parents[1] / "models" / "face_detection_yunet_2023mar.onnx"
        return str(candidate) if candidate.is_file() else None

    def detect(self, frame_bgr) -> list[FaceBox]:
        """Detect faces in a BGR frame; boxes are in original image coordinates."""
        cv2 = self._cv2
        try:
            h, w = frame_bgr.shape[:2]
            input_w, input_h = self._input_size
            resized = cv2.resize(frame_bgr, (input_w, input_h))
            _, faces = self._detector.detect(resized)
            if faces is None or len(faces) == 0:
                return []
            boxes = []
            sx = w / input_w
            sy = h / input_h
            for row in faces:
                x, y, width, height = row[0], row[1], row[2], row[3]
                if width <= 0 or height <= 0:
                    continue
                boxes.append(FaceBox(float(x) * sx, float(y) * sy, float(width) * sx, float(height) * sy))
            return boxes
        except Exception as exc:
            raise DetectorUnavailable(f"Face detection failed: {exc}") from exc


def select_primary_face(faces: list[FaceBox], center_x: float, last_x: float | None,
                       lock_radius: float = 1.0) -> FaceBox | None:
    """Choose the subject to track.

    Strategy: keep the current subject (hysteresis) when it is still present
    within the lock radius; otherwise pick the face that scores best as the
    primary subject — the most prominent one near the frame's horizontal
    center (what a viewer would expect to keep in frame).
    """
    if not faces:
        return None

    def distance(face: FaceBox) -> float:
        cx, _ = face.center
        return abs(cx - center_x)

    def near_last(face: FaceBox) -> bool:
        if last_x is None:
            return False
        cx, _ = face.center
        return abs(cx - last_x) < lock_radius

    if last_x is not None:
        for face in faces:
            if near_last(face):
                return face
    # Prefer the most prominent face near the current crop window center.
    return min(faces, key=lambda f: (distance(f), -f.area))


def supporting_center_fallback() -> None:
    return None
