"""Real FFmpeg clip-generation tests.

Clip output is produced by the actual FFmpeg binary, exactly like production.
Fixture videos are generated with ffmpeg lavfi sources; moment candidates are
planted the same way a completed moment analysis would look in the database.
These tests do NOT fabricate clips, candidates, durations or file contents —
every generated MP4 goes through the engine in this suite and is probed afterwards.
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
from clips import engine as clip_engine
from clips.jobs import ClipQueue
from clips.storage import ClipRepository
from moments.storage import MomentRepository

FIXTURE = Path(tempfile.gettempdir()) / "clipforge-phase5-fixture.mp4"
CANDIDATES = [
    {"id": "cand-1", "rank": 1, "title": "Test moment A", "start": 1.0, "end": 5.0, "duration": 4.0,
     "hook": "h", "reason": "r", "engagementScore": 88.0, "category": "Story", "confidence": 0.9,
     "transcriptExcerpt": "e", "startSegmentId": 0, "endSegmentId": 2, "segmentIds": [0, 1, 2]},
    {"id": "cand-2", "rank": 2, "title": "Test moment B", "start": 0.0, "end": 3.0, "duration": 3.0,
     "hook": "h", "reason": "r", "engagementScore": 75.0, "category": "Educational", "confidence": 0.8,
     "transcriptExcerpt": "e", "startSegmentId": 0, "endSegmentId": 1, "segmentIds": [0, 1]},
]
PROJECT_ID = "clip-test-project"


def have_ffmpeg() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def fixture_video(path: Path, seconds: float = 6.0) -> None:
    subprocess.run([
        "ffmpeg", "-v", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=160x120:rate=24",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(path),
    ], check=True)


def ffprobe_json(path: Path) -> dict:
    proc = subprocess.run([
        "ffprobe", "-v", "error", "-show_format", "-show_streams", "-print_format", "json", str(path),
    ], capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"ffprobe failed on {path}: {proc.stderr}")
    return json.loads(proc.stdout)


class EngineTests(unittest.TestCase):
    def test_parse_out_time_prefers_us_and_falls_back_to_clock(self):
        self.assertAlmostEqual(clip_engine._parse_out_time("out_time_us=1916667"), 1.916667)
        self.assertAlmostEqual(clip_engine._parse_out_time("out_time=01:00:01.500000"), 3601.5)
        self.assertIsNone(clip_engine._parse_out_time("progress=continue"))

    def test_cut_missing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(clip_engine.ClipError) as caught:
                clip_engine.cut_clip(Path(tmp) / "nope.mp4", Path(tmp) / "out.mp4", 0.5, 2.5, "standard")
            self.assertEqual(caught.exception.code, "source_missing")

    def test_cut_corrupt_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.mp4"
            bad.write_bytes(b"this is not a video")
            with self.assertRaises(clip_engine.ClipError) as caught:
                clip_engine.cut_clip(bad, Path(tmp) / "out.mp4", 0.5, 2.5, "standard")
            self.assertIn(caught.exception.code, ("corrupt_source", "ffprobe_failed"))

    def test_cut_rejects_bad_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "src.mp4"
            if have_ffmpeg():
                fixture_video(source, 5.0)
            else:
                self.skipTest("ffmpeg not available")
            for start, end, code in [
                (-1.0, 2.0, "invalid_timestamps"),
                (3.0, 3.0, "invalid_timestamps"),
                (2.0, 1.0, "invalid_timestamps"),
                (0.5, 0.6, "invalid_timestamps"),
                (0.0, 500.0, "invalid_timestamps"),
            ]:
                with self.assertRaises(clip_engine.ClipError) as caught:
                    clip_engine.cut_clip(source, Path(tmp) / "out.mp4", start, end, "standard")
                self.assertEqual(caught.exception.code, code, (start, end))

    def test_cut_missing_ffmpeg_reports_503(self):
        with patch.dict(os.environ, {"CLIPFORGE_FFMPEG": "/nonexistent/ffmpeg-binary"}):
            with self.assertRaises(clip_engine.ClipError) as caught:
                clip_engine.ffmpeg_path()
            self.assertEqual(caught.exception.code, "ffmpeg_missing")
            self.assertEqual(caught.exception.http_status, 503)

    def test_cut_clip_produces_valid_output(self):
        if not have_ffmpeg():
            self.skipTest("ffmpeg not available")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "src.mp4"
            fixture_video(source, 6.0)
            result = clip_engine.cut_clip(source, Path(tmp) / "out.mp4", 1.0, 5.0, "standard")
            out_path = Path(tmp) / "out.mp4"
            data = ffprobe_json(out_path)
            video = next(s for s in data["streams"] if s["codec_type"] == "video")
            audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
            self.assertEqual(video["codec_name"], "h264")
            self.assertTrue(audio, "expected audio in the cut clip")
            duration = float(data["format"]["duration"])
            self.assertAlmostEqual(duration, 4.0, delta=0.35)
            self.assertGreater(result.size_bytes, 500)
            self.assertEqual(result.width, video["width"])


@unittest.skipUnless(have_ffmpeg(), "ffmpeg not available")
class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="clipforge-phase5-tests-")
        cls.root = Path(cls.temp.name)
        app_file = cls.root / "isolated_app.py"
        app_file.write_text((Path(__file__).resolve().parents[1] / "main.py").read_text())
        spec = importlib.util.spec_from_file_location("clipforge_clip_test_app", app_file)
        main = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = main
        spec.loader.exec_module(main)
        cls.main = main
        cls.patches = [
            patch.object(main, "DB_PATH", cls.root / "test.db"),
            patch.object(main, "BASE_DIR", cls.root),
            patch.object(main, "STORAGE_DIR", cls.root / "storage"),
        ]
        for p in cls.patches:
            p.start()
        main.STORAGE_DIR.mkdir(exist_ok=True)
        main.init_db()
        # Create every table in the test database; import-time recovery already
        # ran on the isolated app's own database, which is intentionally separate.
        MomentRepository(main.DB_PATH)
        ClipRepository(main.DB_PATH)
        fixture_video(cls.root / "test-source.mp4", 6.0)
        cls.client = TestClient(main.app)

    def setUp(self):
        # Preserve system environment (PATH etc.); clear only LLM config keys that
        # could leak in from a developer shell.
        self.env = patch.dict(os.environ)
        for key in ("CLIPFORGE_LLM_PROVIDER", "CLIPFORGE_LLM_MODEL", "CLIPFORGE_LLM_API_KEY",
                    "CLIPFORGE_LLM_BASE_URL", "CLIPFORGE_LLM_RESPONSE_FORMAT"):
            os.environ.pop(key, None)
        self.env.start()
        try:
            self.moment_repo_patch = patch.object(self.main, "moment_repository", MomentRepository(self.main.DB_PATH))
            self.moment_repo_patch.start()
            self.clip_repo_patch = patch.object(self.main, "clip_repository", ClipRepository(self.main.DB_PATH))
            self.clip_repo_patch.start()
            self.queue = ClipQueue(ClipRepository(self.main.DB_PATH), self.main._source_path_for, self.main.clip_output_path, self.main.BASE_DIR)
            self.queue_patch = patch.object(self.main, "clip_queue", self.queue)
            self.queue_patch.start()
        except Exception:
            self.env.stop()
            raise
        with self.main.get_db() as conn:
            conn.execute("DELETE FROM clips")
            conn.execute("DELETE FROM moment_analyses")
            conn.execute("DELETE FROM projects")
        with self.main.get_db() as conn:
            conn.execute(
                """INSERT INTO projects (id, name, original_filename, storage_path, source, status, created_at,
                    duration_seconds, size_bytes, mime_type, width, height, thumbnail, preview_available,
                    caption_prefs, transcript_status, transcript_language, transcript_segments,
                    transcript_stage, transcript_progress, transcript_model, transcript_language_probability,
                    transcript_duration, transcript_error, transcript_started_at, transcript_completed_at)
                VALUES (?, ?, ?, ?, 'Upload', 'Ready', ?, ?, ?, 'video/mp4', 160, 120, NULL, 1, NULL, 'completed', 'en', '[]', NULL, 100, 'base', 0.9, 6.0, NULL, 'now', 'now')""",
                (PROJECT_ID, "Phase 5 Test", "test-source.mp4", "storage/test-source.mp4", "2026-01-01", 6.0, 12345),
            )
        self.source = self.main.STORAGE_DIR / "test-source.mp4"
        self.source.parent.mkdir(exist_ok=True)
        if not self.source.exists():
            fixture_video(self.source, 6.0)
        with self.main.get_db() as conn:
            conn.execute("""INSERT INTO moment_analyses (project_id, status, provider, model, transcript_hash, prompt_version, options_json, candidates_json, warnings_json, completed_windows, total_windows, started_at, completed_at)
                VALUES (?, 'completed', 'fixture', 'fixture-model', 'hash', 'moments-v1', '{}', ?, '[]', 1, 1, 'now', 'now')""",
                (PROJECT_ID, json.dumps(CANDIDATES)))

    def tearDown(self):
        try:
            self.queue.shutdown(wait=True)
        except Exception:
            pass
        # Stop repo/queue patches first so background workers never see a
        # missing environment; stop the env patch last.
        for patcher in (getattr(self, "queue_patch", None), getattr(self, "clip_repo_patch", None), getattr(self, "moment_repo_patch", None)):
            try:
                patcher.stop()
            except Exception:
                pass
        try:
            self.env.stop()
        except Exception:
            pass

    def planted_moments(self):
        with self.main.get_db() as conn:
            return json.loads(conn.execute("SELECT candidates_json FROM moment_analyses WHERE project_id = ?", (PROJECT_ID,)).fetchone()[0])

    def poll_clips(self):
        for _ in range(800):
            data = self.client.get(f"/api/projects/{PROJECT_ID}/clips").json()
            if data["queued"] == 0 and data["processing"] == 0 and not self.queue.is_active(PROJECT_ID):
                return data
            time.sleep(0.05)
        self.fail("Clip generation did not finish in time")

    def generate(self, candidate_ids, quality="standard"):
        return self.client.post(
            f"/api/projects/{PROJECT_ID}/generate-clips",
            json={"candidateIds": candidate_ids, "quality": quality},
        )

    def test_health_and_project_summary(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        projects = self.client.get("/api/projects").json()
        self.assertEqual(projects[0]["clipsTotal"], 0)
        self.assertEqual(self.client.get(f"/api/projects/{PROJECT_ID}/clips").json()["total"], 0)

    def test_invalid_quality_is_rejected(self):
        response = self.generate(["cand-1"], quality="ultra")
        self.assertEqual(response.status_code, 422)

    def test_missing_candidate_is_rejected(self):
        response = self.generate(["does-not-exist"])
        self.assertEqual(response.status_code, 422)

    def test_empty_candidate_list_is_rejected(self):
        response = self.generate([])
        self.assertEqual(response.status_code, 422)

    def test_invalid_candidate_timestamps_are_rejected(self):
        with self.main.get_db() as conn:
            conn.execute("UPDATE moment_analyses SET candidates_json = ? WHERE project_id = ?", (
                json.dumps([{**CANDIDATES[0], "start": 4.0, "end": 2.0, "duration": -2.0}]),
                PROJECT_ID,
            ))
        response = self.generate(["cand-1"])
        self.assertEqual(response.status_code, 422)

    def test_missing_source_video_is_404(self):
        self.source.unlink()
        response = self.generate(["cand-1"])
        self.assertEqual(response.status_code, 404)

    def test_single_clip_generation_and_download(self):
        response = self.generate(["cand-1"])
        self.assertEqual(response.status_code, 202)
        data = self.poll_clips()
        clip = next(c for c in data["clips"] if c["candidateId"] == "cand-1")
        self.assertEqual(clip["status"], "completed", clip)
        self.assertEqual(clip["progress"], 100.0)
        self.assertGreater(clip["sizeBytes"], 500)
        self.assertEqual(clip["width"], 160)
        self.assertEqual(clip["height"], 120)
        out_path = self.main.BASE_DIR / clip["filePath"]
        self.assertTrue(out_path.exists())
        out_data = ffprobe_json(out_path)
        video = next(s for s in out_data["streams"] if s["codec_type"] == "video")
        audio = next((s for s in out_data["streams"] if s["codec_type"] == "audio"), None)
        self.assertTrue(audio, "expected audio stream preserved")
        duration = float(out_data["format"]["duration"])
        self.assertAlmostEqual(duration, 4.0, delta=0.4)
        # Download endpoint: exact bytes, attachment disposition.
        dl = self.client.get(f"/api/clips/{clip['id']}/download")
        self.assertEqual(dl.status_code, 200)
        self.assertEqual(dl.content, out_path.read_bytes())
        self.assertIn("attachment", dl.headers.get("content-disposition", ""))
        self.assertIn("video/mp4", dl.headers.get("content-type", ""))
        # Clip detail endpoint.
        detail = self.client.get(f"/api/clips/{clip['id']}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["id"], clip["id"])
        # Fresh repository connection sees the completed clip (persistence).
        fresh = ClipRepository(self.main.DB_PATH)
        persisted = fresh.get(clip["id"])
        self.assertEqual(persisted["status"], "completed")
        self.assertEqual(persisted["filePath"], clip["filePath"])
        self.assertEqual(persisted["sizeBytes"], clip["sizeBytes"])

    def test_multiple_clips_generate_together(self):
        response = self.generate(["cand-1", "cand-2"])
        self.assertEqual(response.status_code, 202)
        data = self.poll_clips()
        self.assertEqual(data["completed"], 2)
        self.assertEqual(data["failed"], 0)
        by_id = {c["candidateId"]: c for c in data["clips"]}
        self.assertAlmostEqual(by_id["cand-1"]["duration"], 4.0, delta=0.5)
        self.assertAlmostEqual(by_id["cand-2"]["duration"], 3.0, delta=0.5)

    def test_failed_clip_can_be_retried(self):
        with self.main.get_db() as conn:
            conn.execute("""INSERT INTO clips (id, project_id, candidate_id, title, rank, category, engagement_score, start_seconds, end_seconds, duration, quality, status, progress, error, error_code, created_at)
                VALUES ('stale-clip', ?, 'cand-1', 'Test moment A', 1, 'Story', 88.0, 1.0, 5.0, 4.0, 'standard', 'failed', 0, 'previous failure', 'ffmpeg_failed', '2026-01-01')""", (PROJECT_ID,))
        response = self.generate(["cand-1"])
        self.assertEqual(response.status_code, 202)
        data = self.poll_clips()
        clips = [c for c in data["clips"] if c["candidateId"] == "cand-1"]
        self.assertEqual(len(clips), 1)
        self.assertEqual(clips[0]["status"], "completed", clips[0])
        self.assertEqual(clips[0]["id"], "stale-clip")

    def test_delete_project_removes_clips(self):
        response = self.generate(["cand-1"])
        self.assertEqual(response.status_code, 202)
        self.poll_clips()
        out_dir = self.main.STORAGE_DIR / "projects" / PROJECT_ID
        self.assertTrue(out_dir.exists())
        dl_dir = Path(self.main.STORAGE_DIR / "projects" / PROJECT_ID / "clips")
        self.assertTrue(dl_dir.exists())
        deleted = self.client.delete(f"/api/projects/{PROJECT_ID}")
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(out_dir.exists())
        with self.main.get_db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM clips WHERE project_id = ?", (PROJECT_ID,)).fetchone()[0], 0)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()


if __name__ == "__main__":
    unittest.main()
