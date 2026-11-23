# CLIPFORGE AI — Backend

FastAPI service for video uploads, project management, and **real speech transcription**
(FFmpeg audio extraction + faster-whisper). The frontend works without it (browser-local
storage), but transcription and Phase 4 moment detection require this server.

## 1. Requirements

| Component | Why | Install |
| --- | --- | --- |
| Python 3.10+ | runtime | — |
| FFmpeg **and** FFprobe | audio extraction, media validation | `apt install ffmpeg` / `brew install ffmpeg` / ffmpeg.org (must be on `PATH`, or set `CLIPFORGE_FFMPEG` / `CLIPFORGE_FFPROBE`) |
| faster-whisper | speech recognition | `pip install -r requirements.txt` |
| Internet (first run only) | downloads the Whisper model from Hugging Face, unless `CLIPFORGE_WHISPER_MODEL_DIR` points to a local copy |  |

## 2. Run

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# Edit .env for model/device settings and an LLM provider, if needed.
uvicorn main:app --reload --port 8000 --env-file .env
```

Check the engine: `curl http://localhost:8000/api/transcription/engine` — `"available": true`
means FFmpeg, FFprobe and faster-whisper are all ready.

Then run the frontend (`npm run dev`, or open the built `dist/index.html`). It probes
`http://localhost:8000/api/health` and switches to server storage automatically. Reload the
page after starting the backend.

## 3. Transcription configuration (environment variables)

| Variable | Default | Values |
| --- | --- | --- |
| `CLIPFORGE_WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium` |
| `CLIPFORGE_WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, `auto` |
| `CLIPFORGE_WHISPER_COMPUTE_TYPE` | `int8` | `default`, `int8`, `int8_float16`, `float16`, `float32` |
| `CLIPFORGE_WHISPER_MODEL_DIR` | HF cache | path to pre-downloaded weights |
| `CLIPFORGE_WHISPER_CPU_THREADS` | `0` (auto) | integer |
| `CLIPFORGE_FFMPEG` / `CLIPFORGE_FFPROBE` | `ffmpeg` / `ffprobe` | executable path |
| `CLIPFORGE_AUDIO_TIMEOUT_S` | `1800` | seconds allowed for audio extraction |

Invalid values stop the server at startup with a message naming the variable. No secrets are
used or required.

Each transcription request may also choose `model` and `language` (see below); the environment
variable is only the default.

## 4. Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| POST | `/api/projects/upload` | Upload a video (MP4/MOV/MKV/WebM, ≤2 GB), FFprobe-verified |
| GET | `/api/projects` | List projects (includes `transcriptStatus`, `transcriptLanguage`) |
| GET | `/api/projects/{id}` | Project details |
| GET | `/api/projects/{id}/file` | Stream the stored video |
| PATCH | `/api/projects/{id}` | Rename / thumbnail / caption prefs |
| DELETE | `/api/projects/{id}` | Delete project and file (**409** while transcription is running) |
| GET | `/api/transcription/engine` | Dependency and configuration status |
| POST | `/api/projects/{id}/transcribe` | **Start** transcription. Body (optional): `{"model": "base", "language": "en"}`. Returns **202** with the job state (`queued`). |
| GET | `/api/projects/{id}/transcript` | Job state and, once `completed`, the timestamped segments |

### Transcription status

`none` → `queued` → `processing` → `completed` | `failed`

While `processing`, `stage` is one of `extracting_audio`, `loading_model`, `transcribing`.
`progress` (0–100) is measured from how much of the audio has been decoded, not from a timer.

Responses are persisted in `backend/clipforge.db`, so they survive reloads. If the server is
stopped mid-job, that job is marked `failed` on the next start with an explanatory message.

### Segment format

```json
{
  "status": "completed",
  "language": "en",
  "languageProbability": 0.9405,
  "durationSeconds": 11.006,
  "segmentCount": 1,
  "segments": [
    { "id": 0, "start": 0.0, "end": 10.36,
      "text": "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country." }
  ]
}
```

### Error responses

| Code | When |
| --- | --- |
| 400 | unsupported `model`, malformed `language` |
| 404 | project not found, or its video file is missing from storage |
| 409 | transcription already queued/running for this project |
| 503 | FFmpeg, FFprobe or faster-whisper missing (detail names what is missing) |

Job-level failures (no audio track, FFmpeg failure, model download failure, Whisper error) are
stored on the project as `failed` with a readable `error`, and are returned by the transcript endpoint.

## 5. How transcription works

1. FFprobe checks that the file has an audio track (otherwise: "no audio track" failure).
2. FFmpeg extracts the first audio stream to 16 kHz mono 16-bit WAV in a private temporary
   directory, which is always deleted afterwards.
3. faster-whisper transcribes with automatic language detection (unless a language is given),
   voice-activity filtering, and word-level timestamps.
4. Segments are kept as Whisper produced them, except for two repairs:
   - a phrase repeated 3+ times in a row (a known Whisper failure mode) is collapsed to one copy;
   - any segment longer than 12 s is re-chunked from its word timings.

Jobs run one at a time on a single worker thread, so memory and CPU use stay bounded.

## 6. Testing

Start the server, then run the end-to-end check against any real video with speech:

```bash
python scripts/transcribe_check.py path/to/video.mp4 --model base --expect "a phrase you know is spoken"
```

It uploads the file, starts the job, polls the persisted state, validates timestamps (ordered,
non-overlapping, within the audio length), and deletes the test project. Exit code 0 means PASS.

## Limitations

- Development server: no authentication, CORS open to all origins, single-process SQLite.
- CPU transcription is slower than real time for `small`/`medium`; use a GPU for long videos.
- Progress is coarse when Whisper emits a single long segment.
- Transcription cannot be cancelled once started (it can be deleted only after it finishes).
- Repetition collapsing also removes deliberate emphasis repeated three times in a row.
- Browser-only (local) mode cannot transcribe; the UI says so.

## Phase 4: AI moment detection

Moment detection is **selection only**, not video cutting or rendering. It reads the project's
real completed transcript, submits neighboring segments to a configured LLM, then validates and
persists ranked candidates in the same SQLite database. No LLM provider is enabled by default.
There are no mock providers or heuristic substitutes in the application.

### Provider configuration

Set these backend environment variables (or put them in the git-ignored `.env` and use
`uvicorn --env-file .env` as above). Never put credentials in a `VITE_*` variable or frontend file.

| Variable | Meaning |
| --- | --- |
| `CLIPFORGE_LLM_PROVIDER` | `openai`, `openai_compatible`, or `ollama` |
| `CLIPFORGE_LLM_MODEL` | Required model name; choose a model that supports structured JSON |
| `CLIPFORGE_LLM_API_KEY` | Required for OpenAI; optional for a keyless local endpoint |
| `CLIPFORGE_LLM_BASE_URL` | OpenAI defaults to `https://api.openai.com/v1`; compatible endpoints must include their API prefix (usually `/v1`); Ollama defaults to `http://localhost:11434` |
| `CLIPFORGE_LLM_RESPONSE_FORMAT` | `json_schema` (default), or explicitly `json_object` for compatible models without schema support; no silent fallback |
| `CLIPFORGE_LLM_TIMEOUT_S` | 180 by default; 5-900 seconds per request |
| `CLIPFORGE_LLM_MAX_OUTPUT_TOKENS` | 4096 by default; 256-16384 |
| `CLIPFORGE_LLM_CONTEXT_TOKENS` | 16384 by default; set to the chosen model's supported context capacity |
| `CLIPFORGE_MOMENT_WINDOW_CHARS` | 18000 by default; an additional conservative UTF-8 byte cap per context window, reduced to reserve instructions and output space |
| `CLIPFORGE_MOMENT_MAX_WINDOWS` | 80 by default; bounds provider requests per analysis |

For OpenAI set provider `openai`, a supported model name, and your own API key. For another
Chat Completions-compatible service use `openai_compatible`, its model, base URL, and credentials.
For local Ollama, install/pull an instruction model, start Ollama, and set provider `ollama` and
the installed model name. The native Ollama adapter sends a schema to `/api/chat` with streaming
disabled. New providers can implement `LLMProvider.complete_json` and register their adapter.

`GET /api/moments/engine` reports configuration readiness, **not** verified remote availability:
`connectivity` is `not_checked`. Authentication, network access and actual model support are
checked when analysis is requested. No API keys or upstream error bodies are returned.

### Endpoints and workflow

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/moments/engine` | Safe provider/configuration status |
| POST | `/api/projects/{id}/analyze-moments` | Start a queued analysis; returns 202 |
| GET | `/api/projects/{id}/moments` | Persisted status, errors, provenance and candidates |

The POST accepts `{"minDuration":15,"maxDuration":90,"maxCandidates":6}`; the body is optional.
Durations must satisfy `5 <= minDuration < maxDuration <= 180`, with 1-20 candidates requested.
At least two valid timestamped speech segments are required so selections have context. A single
short sentence is not treated as a complete contextual analysis.

States are `none`, `queued`, `processing`, `completed`, `failed`. Processing stages are
`preparing_context`, `analyzing_context`, and `ranking_candidates`. `completedWindows` /
`totalWindows` measures actual completed LLM calls, never a simulated percent or ETA.
No automatic re-analysis or provider retries incur unexpected extra charges.

HTTP 404 means missing project, 409 means incomplete transcription or an active project job,
422 means invalid options/transcript, 429 means the bounded queue is full, and 503 means missing
provider configuration. Later network/auth/rate-limit/model errors persist as a failed job with
readable text and an error code. Restarted jobs become `failed` and can be retried.

### Context, grounding and output

Each provider receives contiguous context windows with overlap of up to the maximum clip duration.
The prompt considers hooks, interesting statements, humor, emotion, surprises, stories, educational
insights, thoughtful controversy, advice, conclusions and complete setup/payoff arcs. Transcript
text is treated as untrusted data, not model instructions.

The LLM chooses first/last segment IDs and editorial metadata. The server, not the LLM, computes
`start`, `end`, `duration`, the verbatim opening `hook`, `transcriptExcerpt`, and `segmentIds` from
the actual source. Invalid IDs, out-of-bounds times, disallowed categories, invalid scores and
single-segment selections are rejected. An invalid nonempty response never becomes invented
candidates. Near-duplicates from overlapping windows are suppressed; remaining candidates are
ordered by LLM engagement score and confidence. The system may honestly return no candidates.

Every candidate includes `id`, `rank`, `title`, `start`, `end`, `duration`, `hook`, `reason`,
`engagementScore` (0-100), `category`, `confidence` (0-1), `transcriptExcerpt`, `startSegmentId`,
`endSegmentId`, and `segmentIds`. Categories: Story, Funny, Educational, Emotional, Insight,
Controversial, Motivational. Scores are model judgments, not calibrated probabilities or virality
guarantees. The engine cannot infer visuals, delivery or laughter from text alone.

Candidate jobs, options, provider/model, transcript hash, prompt version, results and errors are
stored in `moment_analyses` alongside the existing `projects` table. Transcription replacement
invalidates old candidates. Active analysis blocks project deletion and re-transcription; a final
hash check also rejects stale results. Re-analysis replaces the prior candidate set.

In the existing Clip Editor, use **Find best moments** after transcription. Review ranked
candidates, filter by category, expand source excerpts, and preview a passage in the original
player. Playback stops at its selected end. No new video file is generated.

### Phase 4 tests

```bash
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

The automated engine/API/HTTP transport tests use explicitly labeled fixtures for model output;
they verify grounding, validation, HTTP contracts, errors, jobs and persistence, **not** real LLM
quality. They never install a fallback provider in the application. For a real end-to-end check,
configure a provider, upload and transcribe a speech video with multiple segments, then run:

```bash
curl -X POST http://localhost:8000/api/projects/PROJECT_ID/analyze-moments \
  -H 'Content-Type: application/json' \
  -d '{"minDuration":15,"maxDuration":90,"maxCandidates":6}'
curl http://localhost:8000/api/projects/PROJECT_ID/moments
```

Repeat the GET until `completed` or `failed`, then inspect the candidates against the original
transcript. Cloud analysis sends transcript text to the configured provider and may incur costs.
Moment analysis uses one in-process worker and a bounded eight-project queue. Run **one uvicorn
worker** in development; a production distributed queue, authentication, job cancellation, video
cutting and rendering are not implemented in this phase.

## Phase 6: Smart vertical reframing

Phase 6 turns a completed Phase 5 clip into a vertical 9:16 MP4. OpenCV samples
frames and, when a face is available, YuNet anchors are smoothed into a crop
timeline. FFmpeg performs the final crop/scale render to 1080x1920, preserving
audio. If OpenCV, the detector model, or faces are unavailable, the render uses
a center crop and stores `method: "center-crop-fallback"`; it never labels that
fallback as face tracking.

Install the OpenCV dependency from `requirements.txt`:

```bash
pip install -r requirements.txt
```

The default YuNet model is expected at
`backend/models/face_detection_yunet_2023mar.onnx`; see `backend/models/README.md`
for the download command and checksum. A different local model can be selected
with `CLIPFORGE_FACE_DETECTOR_MODEL`.

### Reframe endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/projects/{project_id}/clips/{clip_id}/reframe` | Start a background reframe job; returns 202 |
| GET | `/api/projects/{project_id}/clips/{clip_id}/reframe` | Current persisted reframe status/result |
| GET | `/api/projects/{project_id}/reframes` | All reframes for a project |
| GET | `/api/projects/{project_id}/clips/{clip_id}/reframe/file` | Stream the finished vertical MP4 |
| GET | `/api/projects/{project_id}/clips/{clip_id}/reframe/download` | Download the finished vertical MP4 |
| DELETE | `/api/projects/{project_id}/clips/{clip_id}/reframe` | Delete the reframe row and output file |

The POST body is optional: `{"quality":"standard"}`. Qualities are `low`,
`standard`, and `high`. Reframe statuses are `none`, `queued`, `processing`,
`completed`, and `failed`. Progress covers frame analysis first and FFmpeg
rendering second; it is not a simulated timer. Reframing can be retried after a
failure, and re-running a completed reframe replaces its output.

In the frontend, open a project, generate clips, then use **Reframe to 9:16** on
a completed clip. The same clip row shows the vertical preview, download,
regenerate/retry, and delete actions.

### Phase 6 tests

```bash
pip install -r requirements-dev.txt
python -m unittest tests.test_reframing -v
```

The suite covers crop geometry, interpolation, smoothing, center fallback,
subject selection, detector availability, API validation, job persistence,
failure/retry, download, and deletion. API render tests execute the real FFmpeg
binary when available; detector-dependent rendering is controlled explicitly in
tests so no face-tracking result is fabricated.

