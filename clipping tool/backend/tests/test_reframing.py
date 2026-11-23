"""Phase 6 reframing tests.

Pure tracking tests do not need OpenCV or FFmpeg. API tests use the real
FFmpeg binary when available; detector-dependent paths are isolated with
explicit test patches so no face-tracking result is fabricated.
"""

import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from reframing import engine as reframe_engine
from reframing.analysis import (
    Anchor,
    TrackingTimeline,
    build_anchors,
    build_crop_x_expression,
    compute_crop_geometry,
    crop_x_at,
    interpolate_track,
)
from reframing.detector import DetectorUnavailable, FaceBox, OpenCVFaceDetector, select_primary_face
from reframing.jobs import ReframeQueue
from reframing.storage import ReframeRepository
from clips.storage import ClipRepository
from moments.storage import MomentRepository

PROJECT_ID = "reframe-test-project"
CLIP_ID = "reframe-test-clip"


def have_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def have_cv2() -> bool:
    try:
        import cv2  # noqa: F401
        return True
    except Exception:
        return False


def fixture_video(path: Path, seconds: float = 3.0, size: str = "640x360") -> None:
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=24",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            str(path),
        ],
        check=True,
    )


def ffprobe_json(path: Path) -> dict:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-print_format", "json", str(path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError(f"ffprobe failed on {path}: {proc.stderr}")
    return json.loads(proc.stdout)


def evaluate_expression(expression: str, t: float) -> float:
    return float(eval(expression, {"__builtins__": {}}, {"t": t, "max": max, "abs": abs}))


class GeometryTests(unittest.TestCase):
    def test_landscape_keeps_full_height_and_916_crop(self):
        geometry = compute_crop_geometry(1920, 1080)
        self.assertTrue(geometry.keep_full_height)
        self.assertEqual((geometry.crop_width, geometry.crop_height), (608, 1080))
        self.assertAlmostEqual(geometry.crop_width / geometry.crop_height, 9 / 16, delta=0.01)
        self.assertEqual(geometry.max_x, 1920 - 608)
        self.assertEqual(geometry.max_y, 0)

    def test_square_uses_landscape_path(self):
        geometry = compute_crop_geometry(1080, 1080)
        self.assertTrue(geometry.keep_full_height)
        self.assertEqual((geometry.crop_width, geometry.crop_height), (608, 1080))

    def test_existing_vertical_source_is_not_cropped(self):
        geometry = compute_crop_geometry(1080, 1920)
        self.assertEqual((geometry.crop_width, geometry.crop_height), (1080, 1920))
        self.assertEqual((geometry.max_x, geometry.max_y), (0, 0))

    def test_narrow_portrait_keeps_full_width(self):
        geometry = compute_crop_geometry(720, 1440)
        self.assertFalse(geometry.keep_full_height)
        self.assertEqual((geometry.crop_width, geometry.crop_height), (720, 1280))
        self.assertEqual(geometry.max_y, 160)

    def test_invalid_dimensions_are_rejected(self):
        for width, height in [(0, 720), (1280, 0), (-1, 720)]:
            with self.assertRaises(ValueError):
                compute_crop_geometry(width, height)


class TrackingTests(unittest.TestCase):
    def setUp(self):
        self.geometry = compute_crop_geometry(1920, 1080)

    def test_interpolation_is_piecewise_linear(self):
        anchors = [Anchor(0.0, 500.0), Anchor(1.0, 700.0), Anchor(3.0, 1100.0)]
        self.assertEqual(interpolate_track(anchors, -1.0), 500.0)
        self.assertAlmostEqual(interpolate_track(anchors, 0.5), 600.0)
        self.assertAlmostEqual(interpolate_track(anchors, 2.0), 900.0)
        self.assertEqual(interpolate_track(anchors, 99.0), 1100.0)

    def test_crop_position_is_clamped_to_frame(self):
        timeline = TrackingTimeline(
            method="face-tracked",
            anchors=[Anchor(0.0, 0.0), Anchor(1.0, 99999.0)],
            has_face_tracking=True,
        )
        self.assertEqual(crop_x_at(timeline, 0.0, self.geometry), 0)
        self.assertEqual(crop_x_at(timeline, 1.0, self.geometry), self.geometry.max_x)

    def test_smoothing_limits_large_jumps(self):
        samples = [(0.0, 500.0), (0.5, 1500.0), (1.0, 1500.0), (1.5, 1500.0)]
        anchors = build_anchors(samples, self.geometry, 1.5)
        steps = [abs(b.center - a.center) for a, b in zip(anchors, anchors[1:])]
        self.assertTrue(steps)
        self.assertLessEqual(max(steps), self.geometry.crop_width * 0.65 + 0.01)
        self.assertLess(anchors[1].center, 1500.0)

    def test_dead_zone_prevents_small_jitter(self):
        samples = [(0.0, 800.0), (0.5, 802.0), (1.0, 799.0), (1.5, 801.0)]
        anchors = build_anchors(samples, self.geometry, 1.5)
        self.assertTrue(all(abs(a.center - anchors[0].center) < 4.0 for a in anchors))

    def test_missing_detections_are_interpolated(self):
        samples = [(0.0, 500.0), (0.5, None), (1.0, None), (1.5, 800.0)]
        anchors = build_anchors(samples, self.geometry, 1.5)
        middle = interpolate_track(anchors, 0.75)
        self.assertGreater(middle, anchors[0].center)
        self.assertLess(middle, 800.0)

    def test_center_fallback_expression_is_centered(self):
        center = self.geometry.source_width / 2.0
        timeline = TrackingTimeline(
            method="center-crop-fallback",
            anchors=[Anchor(0.0, center), Anchor(2.0, center)],
            has_face_tracking=False,
        )
        expression = build_crop_x_expression(timeline, self.geometry)
        self.assertAlmostEqual(evaluate_expression(expression, 1.0), self.geometry.max_x / 2.0, delta=1.0)

    def test_crop_expression_matches_piecewise_interpolation(self):
        timeline = TrackingTimeline(
            method="face-tracked",
            anchors=[Anchor(0.0, 500.0), Anchor(1.0, 560.0), Anchor(2.0, 900.0), Anchor(3.0, 1000.0)],
            has_face_tracking=True,
        )
        expression = build_crop_x_expression(timeline, self.geometry, anchor_step=0.5)
        for t in (0.0, 0.25, 0.5, 1.25, 2.25, 3.0):
            self.assertAlmostEqual(
                evaluate_expression(expression, t),
                crop_x_at(timeline, t, self.geometry),
                delta=1.5,
                msg=f"t={t}",
            )

    def test_primary_face_prefers_lock_then_prominent_center_face(self):
        faces = [FaceBox(100, 100, 50, 50), FaceBox(300, 120, 80, 80), FaceBox(520, 100, 40, 40)]
        locked = select_primary_face(faces, 320, 135, lock_radius=224)
        self.assertEqual(locked.x, 100)
        unlocked = select_primary_face(faces, 320, None)
        self.assertEqual(unlocked.x, 300)
        self.assertIsNone(select_primary_face([], 320, None))


class DetectorTests(unittest.TestCase):
    def test_missing_model_is_unavailable_not_fake(self):
        with self.assertRaises(DetectorUnavailable):
            OpenCVFaceDetector("/definitely/missing/face-model.onnx")

    @unittest.skipUnless(have_cv2(), "OpenCV not installed")
    def test_bundled_model_loads_and_blank_frame_has_no_faces(self):
        try:
            detector = OpenCVFaceDetector()
        except DetectorUnavailable as exc:
            self.skipTest(str(exc))
        import numpy as np

        self.assertEqual(detector.detect(np.zeros((360, 640, 3), dtype=np.uint8)), [])

    def test_missing_opencv_uses_center_fallback(self):
        geometry = compute_crop_geometry(640, 360)
        with patch.object(reframe_engine, "_load_cv2", side_effect=DetectorUnavailable("no cv2")):
            timeline, provenance = reframe_engine._scan_frames(Path("unused.mp4"), 2.0, geometry)
        self.assertEqual(timeline.method, "center-crop-fallback")
        self.assertFalse(timeline.has_face_tracking)
        self.assertEqual(provenance["reason"], "detector-unavailable")


@unittest.skipUnless(have_ffmpeg(), "ffmpeg not available")
class ReframeAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="clipforge-phase6-tests-")
        cls.root = Path(cls.temp.name)
        app_file = cls.root / "isolated_app.py"
        app_file.write_text((Path(__file__).resolve().parents[1] / "main.py").read_text())
        spec = importlib.util.spec_from_file_location("clipforge_reframe_test_app", app_file)
        main = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = main
        spec.loader.exec_module(main)
        cls.main = main
        cls.patches = [
            patch.object(main, "DB_PATH", cls.root / "test.db"),
            patch.object(main, "BASE_DIR", cls.root),
            patch.object(main, "STORAGE_DIR", cls.root / "storage"),
        ]
        for item in cls.patches:
            item.start()
        main.STORAGE_DIR.mkdir(exist_ok=True)
        main.init_db()
        MomentRepository(main.DB_PATH)
        ClipRepository(main.DB_PATH)
        ReframeRepository(main.DB_PATH)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        for item in reversed(cls.patches):
            item.stop()
        sys.modules.pop("clipforge_reframe_test_app", None)
        cls.temp.cleanup()

    def setUp(self):
        self.env = patch.dict(os.environ)
        for key in ("CLIPFORGE_FACE_DETECTOR_MODEL",):
            os.environ.pop(key, None)
        self.env.start()
        try:
            self.reframe_repo = ReframeRepository(self.main.DB_PATH)
            self.reframe_repo_patch = patch.object(self.main, "reframe_repository", self.reframe_repo)
            self.reframe_repo_patch.start()
            self.clip_repo_patch = patch.object(self.main, "clip_repository", ClipRepository(self.main.DB_PATH))
            self.clip_repo_patch.start()
            self.queue = ReframeQueue(
                self.reframe_repo,
                self.main._reframe_source_for,
                self.main.reframe_output_path,
                self.main._reframe_clip_duration_for,
                self.main.BASE_DIR,
            )
            self.queue_patch = patch.object(self.main, "reframe_queue", self.queue)
            self.queue_patch.start()
        except Exception:
            self.env.stop()
            raise

        with self.main.get_db() as conn:
            conn.execute("DELETE FROM reframes")
            conn.execute("DELETE FROM clips")
            conn.execute("DELETE FROM projects")
            conn.execute(
                """INSERT INTO projects (id, name, original_filename, storage_path, source, status, created_at,
                    duration_seconds, size_bytes, mime_type, width, height, thumbnail, preview_available)
                   VALUES (?, ?, ?, ?, 'Upload', 'Ready', ?, ?, ?, 'video/mp4', 640, 360, NULL, 1)""",
                (PROJECT_ID, "Phase 6 Test", "source.mp4", "storage/source.mp4", "2026-01-01", 3.0, 12345),
            )
            conn.execute(
                """INSERT INTO clips (id, project_id, candidate_id, title, rank, category, engagement_score,
                    start_seconds, end_seconds, duration, quality, status, progress, file_path, size_bytes,
                    width, height, created_at)
                   VALUES (?, ?, 'cand-1', 'Phase 6 clip', 1, 'Story', 88.0, 0.0, 3.0, 3.0,
                    'standard', 'completed', 100, 'storage/test-source.mp4', 1000, 640, 360, '2026-01-01')""",
                (CLIP_ID, PROJECT_ID),
            )
        self.source = self.main.STORAGE_DIR / "test-source.mp4"
        self.source.parent.mkdir(exist_ok=True)
        fixture_video(self.source, 3.0)

    def tearDown(self):
        try:
            self.queue.shutdown(wait=True)
        except Exception:
            pass
        for patcher in (getattr(self, "queue_patch", None), getattr(self, "clip_repo_patch", None), getattr(self, "reframe_repo_patch", None)):
            try:
                patcher.stop()
            except Exception:
                pass
        try:
            self.env.stop()
        except Exception:
            pass

    def start(self, quality="standard", project_id=PROJECT_ID, clip_id=CLIP_ID):
        return self.client.post(
            f"/api/projects/{project_id}/clips/{clip_id}/reframe",
            json={"quality": quality},
        )

    def poll(self):
        for _ in range(1000):
            data = self.client.get(f"/api/projects/{PROJECT_ID}/clips/{CLIP_ID}/reframe").json()
            if data["status"] in ("completed", "failed") and not self.queue.is_active(PROJECT_ID):
                return data
            time.sleep(0.05)
        self.fail("Reframe did not finish in time")

    def test_invalid_quality_is_rejected_without_creating_fake_result(self):
        response = self.start(quality="ultra")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get(f"/api/projects/{PROJECT_ID}/clips/{CLIP_ID}/reframe").json()["status"], "none")

    def test_missing_project_and_clip_are_404(self):
        self.assertEqual(self.start(project_id="missing-project").status_code, 404)
        self.assertEqual(self.start(clip_id="missing-clip").status_code, 404)

    def test_incomplete_clip_cannot_be_reframed(self):
        with self.main.get_db() as conn:
            conn.execute("UPDATE clips SET status='processing' WHERE id=?", (CLIP_ID,))
        self.assertEqual(self.start().status_code, 409)

    def test_missing_clip_file_is_404(self):
        self.source.unlink()
        self.assertEqual(self.start().status_code, 404)

    def test_center_fallback_render_persistence_download_and_delete(self):
        with patch.object(reframe_engine, "_safe_detector", return_value=None):
            response = self.start(quality="low")
            self.assertEqual(response.status_code, 202)
            result = self.poll()

        self.assertEqual(result["status"], "completed", result)
        self.assertEqual(result["method"], "center-crop-fallback")
        self.assertEqual((result["outputWidth"], result["outputHeight"]), (1080, 1920))
        self.assertEqual((result["sourceWidth"], result["sourceHeight"]), (640, 360))
        self.assertEqual(result["aspectRatio"], "9:16")
        self.assertGreater(result["sizeBytes"], 512)

        output = self.main.BASE_DIR / result["filePath"]
        self.assertTrue(output.exists())
        probed = ffprobe_json(output)
        video = next(s for s in probed["streams"] if s["codec_type"] == "video")
        audio = next((s for s in probed["streams"] if s["codec_type"] == "audio"), None)
        self.assertEqual((video["width"], video["height"]), (1080, 1920))
        self.assertTrue(audio, "expected reframed clip to preserve audio")
        self.assertAlmostEqual(float(probed["format"]["duration"]), 3.0, delta=0.4)

        persisted = ReframeRepository(self.main.DB_PATH).get_for_clip(CLIP_ID)
        self.assertEqual(persisted, result)

        download = self.client.get(f"/api/projects/{PROJECT_ID}/clips/{CLIP_ID}/reframe/download")
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, output.read_bytes())
        self.assertIn("attachment", download.headers.get("content-disposition", ""))

        deleted = self.client.delete(f"/api/projects/{PROJECT_ID}/clips/{CLIP_ID}/reframe")
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(output.exists())
        self.assertIsNone(ReframeRepository(self.main.DB_PATH).get_for_clip(CLIP_ID))
        self.assertEqual(self.client.get(f"/api/projects/{PROJECT_ID}/clips/{CLIP_ID}/reframe").json()["status"], "none")

    def test_failed_job_persists_and_retry_succeeds(self):
        with patch.object(
            reframe_engine,
            "reframe_clip",
            side_effect=reframe_engine.ReframeError("Injected render failure", "ffmpeg_failed"),
        ):
            self.assertEqual(self.start().status_code, 202)
            failed = self.poll()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["errorCode"], "ffmpeg_failed")
        self.assertEqual(failed["candidates"] if "candidates" in failed else [], [])

        with patch.object(reframe_engine, "_safe_detector", return_value=None):
            self.assertEqual(self.start(quality="low").status_code, 202)
            completed = self.poll()
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["method"], "center-crop-fallback")

    def test_duplicate_active_reframe_is_rejected(self):
        self.reframe_repo.upsert_for_clip(PROJECT_ID, CLIP_ID, "standard")
        self.assertEqual(self.start().status_code, 409)

    def test_job_source_missing_failure_is_persisted(self):
        reframe = self.reframe_repo.upsert_for_clip(PROJECT_ID, CLIP_ID, "standard")
        self.source.unlink()
        self.queue._run(PROJECT_ID, CLIP_ID)
        result = self.reframe_repo.get_for_clip(CLIP_ID)
        self.assertEqual(result["id"], reframe["id"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errorCode"], "source_missing")

    def test_restart_recovery_marks_interrupted_job_failed(self):
        self.reframe_repo.upsert_for_clip(PROJECT_ID, CLIP_ID, "standard")
        ReframeRepository(self.main.DB_PATH).recover()
        result = self.reframe_repo.get_for_clip(CLIP_ID)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errorCode"], "server_restarted")


if __name__ == "__main__":
    unittest.main()
