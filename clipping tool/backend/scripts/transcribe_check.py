#!/usr/bin/env python3
"""
End-to-end transcription check against a running CLIPFORGE backend.

Uploads a real video, starts transcription, polls the persisted job state until
it completes or fails, then validates the returned segments. Uses only the
Python standard library, so it runs anywhere the backend runs.

Usage (backend must be running on port 8000):
    python scripts/transcribe_check.py path/to/video.mp4 [--model base] [--language en]
                                       [--expect "ask not what your country"] [--keep]

Exit code 0 = pipeline succeeded (and the expected phrase, if given, was found).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = "http://localhost:8000/api"


def request(method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(f"{BASE}{path}", data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("detail")
        except Exception:
            detail = None
        return exc.code, {"detail": detail}


def multipart(fields: dict[str, str], file_path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    parts.append(
        (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
         f"Content-Type: {mime}\r\n\r\n").encode()
    )
    parts.append(file_path.read_bytes())
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--model", default=None)
    ap.add_argument("--language", default=None)
    ap.add_argument("--expect", default=None, help="phrase that must appear in the transcript (case-insensitive)")
    ap.add_argument("--keep", action="store_true", help="keep the uploaded project afterwards")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    if not args.video.exists():
        print(f"Video not found: {args.video}")
        return 2

    status, engine = request("GET", "/transcription/engine")
    print(f"[engine] HTTP {status} available={engine.get('available')} missing={engine.get('missing')}")
    if not engine.get("available"):
        return 3

    body, ctype = multipart({"name": f"CHECK {args.video.name}"}, args.video)
    status, project = request("POST", "/projects/upload", body, {"Content-Type": ctype})
    if status != 200:
        print(f"[upload] failed HTTP {status}: {project}")
        return 4
    pid = project["id"]
    print(f"[upload] project {pid} ({project['durationSeconds']}s, {project['width']}x{project['height']})")

    payload = json.dumps({"model": args.model, "language": args.language}).encode()
    status, job = request("POST", f"/projects/{pid}/transcribe", payload, {"Content-Type": "application/json"})
    print(f"[start] HTTP {status} status={job.get('status')} model={job.get('model')}")
    if status != 202:
        print(f"[start] detail: {job.get('detail')}")
        return 5

    started = time.time()
    last = None
    while True:
        status, state = request("GET", f"/projects/{pid}/transcript")
        current = (state["status"], state.get("stage"), round(state.get("progress") or 0))
        if current != last:
            print(f"[poll +{time.time() - started:5.1f}s] status={current[0]} stage={current[1]} progress={current[2]}%")
            last = current
        if state["status"] in ("completed", "failed"):
            break
        if time.time() - started > args.timeout:
            print("[poll] timed out waiting for the job")
            return 6
        time.sleep(1.0)

    if state["status"] == "failed":
        print(f"[result] FAILED: {state.get('error')}")
        if not args.keep:
            request("DELETE", f"/projects/{pid}")
        return 7

    segments = state["segments"]
    print(f"[result] language={state['language']} prob={state['languageProbability']} "
          f"duration={state['durationSeconds']}s segments={len(segments)} "
          f"elapsed={time.time() - started:.1f}s")
    for seg in segments:
        print(f"  [{seg['start']:7.2f} -> {seg['end']:7.2f}] {seg['text']}")

    # Structural validation of the real output.
    problems = []
    prev_end = -1.0
    for seg in segments:
        if not (isinstance(seg["start"], (int, float)) and isinstance(seg["end"], (int, float))):
            problems.append(f"non-numeric timestamps in segment {seg.get('id')}")
        elif seg["end"] < seg["start"]:
            problems.append(f"end before start in segment {seg['id']}")
        elif seg["start"] < prev_end - 0.01:
            problems.append(f"segment {seg['id']} overlaps the previous one")
        if not seg.get("text"):
            problems.append(f"empty text in segment {seg.get('id')}")
        if isinstance(seg.get("end"), (int, float)):
            prev_end = seg["end"]
    if state["durationSeconds"] and segments and segments[-1]["end"] > state["durationSeconds"] + 1.0:
        problems.append("last segment ends after the audio duration")
    print(f"[validate] structure problems: {problems or 'none'}")

    ok = not problems
    if args.expect:
        transcript_text = " ".join(s["text"] for s in segments).lower()
        found = args.expect.lower() in transcript_text
        print(f"[validate] expected phrase {'FOUND' if found else 'NOT FOUND'}: {args.expect!r}")
        ok = ok and found

    if not args.keep:
        request("DELETE", f"/projects/{pid}")
        print("[cleanup] test project deleted")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 8


if __name__ == "__main__":
    sys.exit(main())
