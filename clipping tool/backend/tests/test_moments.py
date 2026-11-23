"""Deterministic contract tests. All LLM replies here are explicitly TEST FIXTURES.

No fixture provider is registered in the application and these tests do not
claim to evaluate an actual model's editorial quality.
"""

import copy
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from moments.engine import (AnalysisOptions, analyze, context_windows, engine_status,
                            normalize_transcript, rank_candidates, validate_candidates)
from moments.jobs import MomentQueue
from moments.providers import (MomentError, OllamaProvider, OpenAIProvider, ProviderConfig,
                               load_provider_config, parse_json)
from moments.storage import MomentRepository

SEGMENTS = [
    {"id": 0, "start": 0.0, "end": 8.0, "text": "Why does working harder sometimes make things worse?"},
    {"id": 1, "start": 8.0, "end": 18.0, "text": "I kept adding tasks until our team missed its first deadline."},
    {"id": 2, "start": 18.0, "end": 30.0, "text": "We removed half the tasks and finally shipped the product."},
    {"id": 3, "start": 30.0, "end": 42.0, "text": "The lesson was to measure progress, not how busy we looked."},
    {"id": 4, "start": 42.0, "end": 52.0, "text": "Try removing one low-value task before adding another."},
]
REPLY = {"candidates": [{"title": "TEST FIXTURE: Less work, more progress", "startSegmentId": 0,
    "endSegmentId": 3, "reason": "TEST FIXTURE: A question introduces a failure, then the story resolves with a practical lesson.",
    "engagementScore": 86, "category": "Story", "confidence": 0.87}]}
CONFIG = ProviderConfig("openai_compatible", "test-fixture-model", "http://127.0.0.1:1/v1", "test-key", 5)


class FixtureProvider:
    config = CONFIG

    def __init__(self, reply=None):
        self.reply = copy.deepcopy(REPLY if reply is None else reply)
        self.calls = []

    def complete_json(self, messages, schema):
        self.calls.append((messages, schema))
        return copy.deepcopy(self.reply)


class EngineTests(unittest.TestCase):
    def test_unconfigured_means_error_not_fallback(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(engine_status()["configured"])
            with self.assertRaisesRegex(MomentError, "No LLM provider"):
                load_provider_config()

    def test_configuration_never_exposes_key(self):
        env = {"CLIPFORGE_LLM_PROVIDER": "openai", "CLIPFORGE_LLM_MODEL": "test", "CLIPFORGE_LLM_API_KEY": "secret-value"}
        with patch.dict(os.environ, env, clear=True):
            self.assertTrue(engine_status()["configured"])
            self.assertNotIn("secret-value", json.dumps(engine_status()) + repr(load_provider_config()))

    def test_local_ollama_needs_no_api_key(self):
        with patch.dict(os.environ, {"CLIPFORGE_LLM_PROVIDER": "ollama", "CLIPFORGE_LLM_MODEL": "installed-model"}, clear=True):
            self.assertEqual(load_provider_config().base_url, "http://localhost:11434")

    def test_invalid_config_is_readable_and_does_not_crash_other_features(self):
        for env in [{"CLIPFORGE_LLM_PROVIDER": "fake"}, {"CLIPFORGE_LLM_PROVIDER": "openai", "CLIPFORGE_LLM_MODEL": "x"},
                    {"CLIPFORGE_LLM_PROVIDER": "ollama", "CLIPFORGE_LLM_MODEL": "x", "CLIPFORGE_LLM_TIMEOUT_S": "nan"}]:
            with patch.dict(os.environ, env, clear=True):
                self.assertFalse(engine_status()["configured"])

    def test_reject_invalid_transcripts_and_single_sentence_context(self):
        for raw in [[], SEGMENTS[:1], [{"start": 5, "end": 3, "text": "bad"}], [{"start": 0, "end": float("nan"), "text": "bad"}]]:
            with self.assertRaises(MomentError):
                normalize_transcript(raw, 60)

    def test_context_windows_cover_entire_transcript_with_overlap(self):
        source = [{"id": i, "start": i * 10, "end": i * 10 + 10, "text": "test context " * 30} for i in range(70)]
        windows = context_windows(source, 90, 4000, 100)
        self.assertGreater(len(windows), 1)
        self.assertEqual({s["id"] for w in windows for s in w}, set(range(70)))
        for a, b in zip(windows, windows[1:]):
            self.assertTrue({s["id"] for s in a} & {s["id"] for s in b})
        self.assertTrue(all(len(w) >= 2 for w in windows))

    def test_no_silent_truncation_of_oversized_context(self):
        with self.assertRaises(MomentError):
            context_windows([{**s, "text": "x" * 3000} for s in SEGMENTS], 90, 2000, 80)
        with self.assertRaises(MomentError):
            context_windows([{**s, "text": "x" * 1000} for s in SEGMENTS], 90, 2200, 1)

    def test_output_boundaries_excerpt_and_hook_come_from_source(self):
        provider = FixtureProvider()
        updates = []
        output = analyze(SEGMENTS, 52, AnalysisOptions(), provider, updates.append)
        c = output["candidates"][0]
        self.assertEqual((c["start"], c["end"], c["duration"]), (0, 42, 42))
        self.assertEqual(c["transcriptExcerpt"], " ".join(s["text"] for s in SEGMENTS[:4]))
        self.assertEqual(c["hook"], SEGMENTS[0]["text"])
        self.assertEqual(c["segmentIds"], [0, 1, 2, 3])
        self.assertEqual(len(json.loads(provider.calls[0][0][1]["content"])["transcriptSegments"]), 5)
        self.assertIn({"completedWindows": 1}, updates)

    def test_reject_hallucinated_ids_scores_categories_or_single_sentences(self):
        for change in [{"startSegmentId": 999}, {"endSegmentId": 0}, {"startSegmentId": True}, {"startSegmentId": 0.0},
                       {"engagementScore": 101}, {"engagementScore": float("nan")}, {"confidence": 50}, {"category": "Viral"}]:
            reply = copy.deepcopy(REPLY)
            reply["candidates"][0].update(change)
            with self.assertRaises(MomentError):
                validate_candidates(reply, SEGMENTS, AnalysisOptions(), 52)

    def test_duration_constraint_and_media_bounds_are_enforced(self):
        for opts, duration in [(AnalysisOptions(5, 10, 6), 52), (AnalysisOptions(), 25)]:
            with self.assertRaises(MomentError):
                validate_candidates(REPLY, SEGMENTS, opts, duration)

    def test_json_parser_rejects_duplicate_keys_and_nan(self):
        for text in ['{"candidates": [], "candidates": []}', '{"x":NaN}', '[]', 'not JSON']:
            with self.assertRaises(MomentError):
                parse_json(text)

    def test_empty_model_selection_is_honest_success(self):
        output = analyze(SEGMENTS, 52, AnalysisOptions(), FixtureProvider({"candidates": []}), lambda _: None)
        self.assertEqual(output["candidates"], [])

    def test_near_duplicates_are_suppressed_and_candidates_ranked(self):
        base = validate_candidates(REPLY, SEGMENTS, AnalysisOptions(), 52)[0][0]
        output = rank_candidates([base, {**base, "engagementScore": 90}], 6)
        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]["engagementScore"], 90)
        self.assertEqual(output[0]["rank"], 1)

    def test_adapter_request_and_reply_contracts(self):
        with patch("moments.providers.post_json", return_value={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(REPLY)}}]}) as post:
            result = OpenAIProvider(CONFIG).complete_json([], {"type": "object"})
            self.assertEqual(result, REPLY)
            self.assertEqual(post.call_args.args[1], "/chat/completions")
            self.assertIn("response_format", post.call_args.args[2])
        with patch("moments.providers.post_json", return_value={"done": True, "message": {"content": json.dumps(REPLY)}}) as post:
            self.assertEqual(OllamaProvider(CONFIG).complete_json([], {}).get("candidates"), REPLY["candidates"])
            self.assertFalse(post.call_args.args[2]["stream"])

    def test_incomplete_or_refused_reply_is_not_used(self):
        for response in [{"choices": [{"finish_reason": "length", "message": {"content": json.dumps(REPLY)}}]},
                         {"choices": [{"finish_reason": "stop", "message": {"refusal": "private text"}}]}]:
            with patch("moments.providers.post_json", return_value=response):
                with self.assertRaises(MomentError):
                    OpenAIProvider(CONFIG).complete_json([], {})

    def test_multibyte_context_does_not_exceed_budget(self):
        source = [{"id": i, "start": i * 10, "end": i * 10 + 10, "text": "\u6545\u4e8b" * 100} for i in range(20)]
        windows = context_windows(source, 90, 4000, 100)
        self.assertTrue(all(sum(len(json.dumps(s, ensure_ascii=False).encode()) + 2 for s in w) <= 4000 for w in windows))

    def test_input_and_output_context_are_both_reserved(self):
        provider = FixtureProvider()
        provider.config = replace(CONFIG, max_tokens=4096, context_tokens=4096)
        with self.assertRaisesRegex(MomentError, "context budget"):
            analyze(SEGMENTS, 52, AnalysisOptions(), provider, lambda _: None)


class TransportTests(unittest.TestCase):
    """Real HTTP transport against a LOCAL TEST FIXTURE, not actual AI inference."""
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                cls.last_path = self.path
                cls.last_header = self.headers.get("Authorization")
                cls.last_payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(cls.reply_status)
                self.send_header("Content-Type", "application/json")
                if cls.reply_status == 302:
                    self.send_header("Location", cls.url + "/redirect-target")
                self.end_headers()
                self.wfile.write(json.dumps(cls.reply).encode())

            def log_message(self, *args):
                pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        type(self).reply_status = 200
        type(self).reply = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(REPLY)}}]}

    def test_openai_compatible_http_payload_and_response(self):
        result = OpenAIProvider(replace(CONFIG, base_url=self.url + "/v1")).complete_json([], {})
        self.assertEqual(result, REPLY)
        self.assertEqual(self.last_path, "/v1/chat/completions")
        self.assertEqual(self.last_header, "Bearer test-key")
        self.assertEqual(self.last_payload["max_tokens"], 4096)

    def test_native_openai_token_parameter(self):
        OpenAIProvider(replace(CONFIG, provider="openai", base_url=self.url)).complete_json([], {})
        self.assertIn("max_completion_tokens", self.last_payload)
        self.assertNotIn("max_tokens", self.last_payload)

    def test_ollama_http_payload_and_response(self):
        type(self).reply = {"done": True, "message": {"content": json.dumps(REPLY)}}
        result = OllamaProvider(replace(CONFIG, base_url=self.url, api_key="")).complete_json([], {})
        self.assertEqual(result, REPLY)
        self.assertEqual(self.last_path, "/api/chat")
        self.assertIsNone(self.last_header)
        self.assertEqual(self.last_payload["options"]["num_ctx"], CONFIG.context_tokens)

    def test_auth_error_sanitizes_remote_body(self):
        type(self).reply_status = 401
        type(self).reply = {"error": "secret-value echoed with private transcript text"}
        with self.assertRaises(MomentError) as raised:
            OpenAIProvider(replace(CONFIG, base_url=self.url)).complete_json([], {})
        self.assertEqual(raised.exception.code, "provider_http_error")
        self.assertNotIn("secret-value", str(raised.exception))

    def test_redirect_is_not_followed(self):
        type(self).reply_status = 302
        with self.assertRaises(MomentError):
            OpenAIProvider(replace(CONFIG, base_url=self.url)).complete_json([], {})
        self.assertEqual(self.last_path, "/chat/completions")

    def test_invalid_json_content_does_not_become_a_result(self):
        type(self).reply = {"choices": [{"finish_reason": "stop", "message": {"content": "made-up unstructured reply"}}]}
        with self.assertRaises(MomentError):
            OpenAIProvider(replace(CONFIG, base_url=self.url)).complete_json([], {})


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="clipforge-phase4-tests-")
        cls.root = Path(cls.temp.name)
        # Import from a temporary copy so import-time startup recovery cannot
        # alter an existing developer database or a concurrently running app.
        app_file = cls.root / "isolated_app.py"
        app_file.write_text((Path(__file__).resolve().parents[1] / "main.py").read_text())
        spec = importlib.util.spec_from_file_location("clipforge_moment_test_app", app_file)
        main = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = main
        spec.loader.exec_module(main)
        cls.main = main
        cls.patches = [patch.object(main, "DB_PATH", cls.root / "test.db"), patch.object(main, "BASE_DIR", cls.root),
                       patch.object(main, "STORAGE_DIR", cls.root / "storage")]
        for p in cls.patches:
            p.start()
        main.STORAGE_DIR.mkdir(exist_ok=True)
        main.init_db()
        cls.repository = MomentRepository(main.DB_PATH)
        cls.repo_patch = patch.object(main, "moment_repository", cls.repository)
        cls.repo_patch.start()
        cls.client = TestClient(main.app)

    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.release = threading.Event()
        self.queue = MomentQueue(self.repository, self.main.moment_source, lambda _: FixtureProvider())
        self.queue_patch = patch.object(self.main, "moment_queue", self.queue)
        self.queue_patch.start()
        with self.main.get_db() as conn:
            conn.execute("DELETE FROM moment_analyses")
            conn.execute("DELETE FROM projects")
            conn.execute("""INSERT INTO projects (id, name, original_filename, storage_path, created_at,
                duration_seconds, transcript_status, transcript_segments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                ("test-project", "Test fixture", "fixture.mp4", "storage/fixture.mp4", "2026-01-01", 52, "completed", json.dumps(SEGMENTS)))
        (self.main.STORAGE_DIR / "fixture.mp4").write_bytes(b"TEST FIXTURE - not real video")

    def tearDown(self):
        self.release.set()
        self.queue.shutdown()
        self.queue_patch.stop()
        self.env.stop()

    @classmethod
    def tearDownClass(cls):
        cls.repo_patch.stop()
        for p in reversed(cls.patches):
            p.stop()
        sys.modules.pop("clipforge_moment_test_app", None)
        cls.temp.cleanup()

    def configure(self):
        os.environ.update(CLIPFORGE_LLM_PROVIDER="openai_compatible", CLIPFORGE_LLM_MODEL="test-fixture-model", CLIPFORGE_LLM_BASE_URL="http://127.0.0.1:1/v1")

    def poll(self):
        for _ in range(200):
            data = self.client.get("/api/projects/test-project/moments").json()
            if data["status"] in ("completed", "failed") and not self.queue.is_active("test-project"):
                return data
            time.sleep(.01)
        self.fail("test worker did not finish")

    def start(self, body=None):
        return self.client.post("/api/projects/test-project/analyze-moments", json=body or {})

    def test_health_upload_transcript_routes_still_work(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        self.assertEqual(self.client.get("/api/projects/test-project/transcript").json()["segments"], SEGMENTS)
        self.assertEqual(self.client.patch("/api/projects/test-project", json={"name": "Renamed"}).json()["name"], "Renamed")
        self.assertEqual(self.client.post("/api/projects/upload", files={"file": ("bad.txt", b"bad")}).status_code, 400)

    def test_configuration_error_never_creates_fake_candidates(self):
        response = self.start()
        self.assertEqual(response.status_code, 503)
        self.assertIn("No LLM provider", response.json()["detail"])
        self.assertEqual(self.client.get("/api/projects/test-project/moments").json()["candidates"], [])
        self.assertEqual(self.client.get("/api/moments/engine").json()["connectivity"], "not_checked")

    def test_preconditions(self):
        self.assertEqual(self.client.post("/api/projects/missing/analyze-moments").status_code, 404)
        self.assertEqual(self.start({"minDuration": 80, "maxDuration": 20}).status_code, 422)
        with self.main.get_db() as conn:
            conn.execute("UPDATE projects SET transcript_status='none'")
        self.assertEqual(self.start().status_code, 409)

    def test_success_persistence_and_summary(self):
        self.configure()
        self.assertEqual(self.start().status_code, 202)
        result = self.poll()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["candidateCount"], 1)
        reopened = MomentRepository(self.main.DB_PATH)
        reopened.recover()
        self.assertEqual(reopened.get("test-project"), result)
        project = self.client.get("/api/projects/test-project").json()
        self.assertEqual(project["momentCandidateCount"], 1)
        self.assertEqual(self.client.get("/api/projects/test-project/transcript").json()["segments"], SEGMENTS)

    def test_failed_provider_can_be_retried(self):
        self.configure()
        def fail(_):
            raise MomentError("Provider timed out", "provider_timeout")
        self.queue.provider_factory = fail
        self.assertEqual(self.start().status_code, 202)
        self.assertEqual(self.poll()["errorCode"], "provider_timeout")
        self.queue.provider_factory = lambda _: FixtureProvider()
        self.assertEqual(self.start().status_code, 202)
        self.assertEqual(self.poll()["status"], "completed")

    def hold_worker(self):
        test = self
        class WaitingProvider(FixtureProvider):
            def complete_json(self, messages, schema):
                test.release.wait(5)
                return super().complete_json(messages, schema)
        self.queue.provider_factory = lambda _: WaitingProvider()

    def test_duplicate_delete_and_retranscription_guards(self):
        self.configure()
        self.hold_worker()
        self.assertEqual(self.start().status_code, 202)
        self.assertEqual(self.start().status_code, 409)
        self.assertEqual(self.client.delete("/api/projects/test-project").status_code, 409)
        with patch.object(self.main, "engine_status", return_value={"available": True}):
            self.assertEqual(self.client.post("/api/projects/test-project/transcribe").status_code, 409)
        self.release.set()
        self.poll()
        self.assertEqual(self.client.delete("/api/projects/test-project").status_code, 200)
        self.assertEqual(self.repository.get("test-project")["status"], "none")

    def test_transcript_changes_reject_stale_candidates(self):
        self.configure()
        self.hold_worker()
        self.start()
        changed = copy.deepcopy(SEGMENTS)
        changed[0]["text"] = "Changed source text"
        with self.main.get_db() as conn:
            conn.execute("UPDATE projects SET transcript_segments=?", (json.dumps(changed),))
        self.release.set()
        self.assertEqual(self.poll()["errorCode"], "transcript_changed")

    def test_retranscribe_invalidates_candidates(self):
        self.configure()
        self.start()
        self.poll()
        with patch.object(self.main, "engine_status", return_value={"available": True}), \
             patch.object(self.main.transcription_queue, "submit", return_value=True):
            self.assertEqual(self.client.post("/api/projects/test-project/transcribe").status_code, 202)
        self.assertEqual(self.repository.get("test-project")["status"], "none")

    def test_restart_recovery(self):
        self.repository.begin("test-project", "test", "fixture", "hash", AnalysisOptions())
        self.repository.recover()
        self.assertEqual(self.repository.get("test-project")["errorCode"], "server_restarted")

    def test_unexpected_failure_does_not_echo_secrets(self):
        self.configure()
        def fail(_):
            raise RuntimeError("secret-value")
        self.queue.provider_factory = fail
        self.start()
        result = self.poll()
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("secret-value", json.dumps(result))

    def test_queue_full_is_explicit_and_bounded(self):
        self.configure()
        with self.queue._lock:
            self.queue._active = {f"other-{i}" for i in range(8)}
        self.assertEqual(self.start().status_code, 429)
        with self.queue._lock:
            self.queue._active.clear()


class MigrationTests(unittest.TestCase):
    def test_new_moment_table_preserves_existing_project_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "old.db"
            with sqlite3.connect(path) as conn:
                conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)")
                conn.execute("INSERT INTO projects VALUES ('old', 'Untouched existing project')")
            repository = MomentRepository(path)
            repository.recover()
            with sqlite3.connect(path) as conn:
                self.assertEqual(conn.execute("SELECT name FROM projects").fetchone()[0], "Untouched existing project")
            self.assertEqual(repository.get("old")["status"], "none")


if __name__ == "__main__":
    unittest.main()