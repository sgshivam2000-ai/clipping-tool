import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Brain,
  Captions,
  CheckCircle2,
  CloudUpload,
  Crop,
  Database,
  Download,
  Eye,
  FileVideo,
  Film,
  Link2,
  Loader2,
  Rocket,
  Scissors,
  Server,
  Sparkles,
  Upload,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes, formatDate, formatDuration } from "@/lib/format";
import { getApiBase } from "@/lib/api";
import { probeVideo, type VideoMeta } from "@/lib/video";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";
import { Button, Card, Chip, IconTile, inputCls, Progress, StatusBadge } from "@/components/ui";

const FORMATS = ["MP4", "MOV", "MKV", "WebM"];
const MAX_BYTES = 2 * 1024 ** 3; // 2 GB

const STEPS = [
  { icon: Upload, title: "1 · Upload", desc: "Drop a video file — it's stored safely with its full metadata. Live today." },
  { icon: Sparkles, title: "2 · AI analysis", desc: "Transcribe speech, then find engaging moments using a configured LLM. Both run on the backend." },
  { icon: Scissors, title: "3 · Auto-cut clips", desc: "Moments are cut into Shorts-ready clips. No timestamps, no manual cutting. Next phase." },
  { icon: Rocket, title: "4 · Review & export", desc: "Captions and 9:16 reframe included. Download in one click. Later phase." },
];

const FLOW = [
  { icon: Upload, t: "Upload video", tag: "Live" },
  { icon: Brain, t: "Transcribe audio", tag: "Backend" },
  { icon: Sparkles, t: "Detect best moments", tag: "Backend" },
  { icon: Scissors, t: "Generate clips", tag: "Next" },
  { icon: Captions, t: "Auto captions", tag: "Next" },
  { icon: Crop, t: "Vertical reframe", tag: "Next" },
  { icon: Eye, t: "Preview & edit", tag: "Live" },
  { icon: Download, t: "Export", tag: "Later" },
];

type Phase = "idle" | "ready" | "uploading" | "error" | "done";

function validateFile(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!FORMATS.map((f) => f.toLowerCase()).includes(ext)) {
    return `“${file.name}” is a .${ext || "?"} file. Supported formats are MP4, MOV, MKV and WebM.`;
  }
  if (file.size === 0) return "That file is empty (0 bytes) — please choose a different video.";
  if (file.size > MAX_BYTES) return `That file is ${formatBytes(file.size)} — the limit is 2 GB per video.`;
  return null;
}

export default function CreateClips() {
  const { startUpload, cancelUpload, upload, projects, mode, toast } = useStore();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [projectName, setProjectName] = useState("");
  const [drag, setDrag] = useState(false);
  const [probing, setProbing] = useState(false);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [fileError, setFileError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [created, setCreated] = useState<Project | null>(null);
  const [url, setUrl] = useState("");

  const acceptFile = async (f: File | null | undefined) => {
    if (!f) return;
    const error = validateFile(f);
    if (error) {
      setFileError(error);
      setFile(null);
      setMeta(null);
      setPhase("idle");
      return;
    }
    setFileError("");
    setUploadError("");
    setCreated(null);
    setFile(f);
    setProjectName(f.name.replace(/\.[^.]+$/, "").slice(0, 80));
    setPhase("ready");
    setProbing(true);
    const result = await probeVideo(f);
    setMeta(result);
    setProbing(false);
  };

  const reset = () => {
    setFile(null);
    setMeta(null);
    setProjectName("");
    setFileError("");
    setUploadError("");
    setCreated(null);
    setPhase("idle");
  };

  const handleUpload = async () => {
    if (!file) return;
    setPhase("uploading");
    setUploadError("");
    try {
      const project = await startUpload(file, projectName.trim() || file.name.replace(/\.[^.]+$/, ""));
      setCreated(project);
      setPhase("done");
    } catch (err) {
      if (err instanceof Error && err.name === "UploadCancelled") {
        setPhase("ready");
      } else {
        setUploadError(err instanceof Error ? err.message : "Upload failed. Please try again.");
        setPhase("error");
      }
    }
  };

  const handleImportUrl = () => {
    if (!url.trim()) return;
    toast("Link import arrives in a later phase — file upload is fully working today.", "info");
  };

  const ext = file?.name.split(".").pop()?.toUpperCase() ?? "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-fg">Create clips</h1>
          <p className="mt-1 text-[14px] text-fg-2">
            Turn long videos into viral-ready clips. Upload a file — the AI pipeline takes it from there.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-panel-2 px-2.5 py-1 text-[11px] font-semibold text-fg-2">
          {mode === "server" ? <Server className="h-3 w-3 text-accent" /> : <Database className="h-3 w-3 text-accent" />}
          {mode === "server" ? `FastAPI server · ${getApiBase() ?? ""}` : mode === "local" ? "Local storage · IndexedDB" : "Detecting storage…"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left: upload panel */}
        <div className="space-y-6">
          <Card className="p-5 sm:p-6">
            <h2 className="text-[15px] font-bold tracking-tight text-fg">Upload video</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-3">Real uploads — files are stored with full metadata</p>

            {phase === "done" && created ? (
              /* ---------- success state ---------- */
              <div className="mt-4 rounded-2xl border border-accent/30 bg-accent/[0.05] p-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-bold text-fg">Upload complete — project created</p>
                    <p className="mt-0.5 truncate text-[12.5px] text-fg-3">{created.originalFileName}</p>
                  </div>
                  <StatusBadge status={created.status} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { k: "Duration", v: created.duration },
                    { k: "Resolution", v: created.width ? `${created.width}×${created.height}` : "—" },
                    { k: "File size", v: created.size },
                    { k: "Uploaded", v: formatDate(created.createdAt) },
                  ].map((f) => (
                    <div key={f.k} className="rounded-xl border border-line bg-panel-2 px-3 py-2">
                      <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-fg-3">{f.k}</div>
                      <div className="mt-0.5 font-mono text-[12.5px] font-semibold text-fg">{f.v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button icon={Eye} onClick={() => navigate(`/editor?project=${created.id}`)}>
                    Open project
                  </Button>
                  <Button variant="secondary" onClick={() => navigate("/projects")}>
                    View all projects
                  </Button>
                  <Button variant="ghost" icon={Upload} onClick={reset}>
                    Upload another
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* ---------- drop zone ---------- */}
                <div
                  onClick={() => phase !== "uploading" && inputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    if (phase !== "uploading") void acceptFile(e.dataTransfer.files?.[0]);
                  }}
                  className={cn(
                    "mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors duration-200",
                    phase === "uploading" ? "cursor-default" : "cursor-pointer",
                    drag ? "border-accent bg-accent/[0.06]" : "border-line-2 bg-panel-2 hover:border-fg-3/50"
                  )}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
                    className="hidden"
                    onChange={(e) => {
                      void acceptFile(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <IconTile
                    icon={CloudUpload}
                    tone={drag ? "accent" : "neutral"}
                    className="h-12 w-12 rounded-2xl [&>svg]:h-6 [&>svg]:w-6"
                  />
                  <p className="mt-4 text-[15px] font-semibold text-fg">
                    {file ? "Drop a different video to replace it" : "Drag & drop your video here"}
                  </p>
                  <p className="mt-1 text-[12.5px] text-fg-3">or</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    disabled={phase === "uploading"}
                    onClick={(e) => {
                      e.stopPropagation();
                      inputRef.current?.click();
                    }}
                  >
                    Browse files
                  </Button>
                  <div className="mt-5 flex flex-wrap justify-center gap-1.5">
                    {FORMATS.map((f) => (
                      <Chip key={f}>{f}</Chip>
                    ))}
                  </div>
                  <p className="mt-2.5 text-[11px] text-fg-3">Up to 2 GB per file · videos up to 4 hours · 1080p / 4K supported</p>
                </div>

                {/* validation error */}
                {fileError && (
                  <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3.5">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                    <p className="text-[12.5px] leading-relaxed text-red-300">{fileError}</p>
                  </div>
                )}

                {/* ---------- selected file ---------- */}
                {file && (
                  <div className="mt-4 rounded-xl border border-line-2 bg-panel-2 p-3.5">
                    <div className="flex items-center gap-3">
                      <IconTile icon={FileVideo} tone="accent" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-fg">{file.name}</div>
                        <div className="text-[11px] text-fg-3">
                          {formatBytes(file.size)} · {file.type || "video file"}
                        </div>
                      </div>
                      <Chip>{ext}</Chip>
                      <button
                        aria-label="Remove file"
                        disabled={phase === "uploading"}
                        onClick={reset}
                        className="rounded-lg p-1.5 text-fg-3 transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    {/* metadata from the actual file */}
                    <div className="mt-3 border-t border-line pt-3">
                      {probing ? (
                        <p className="flex items-center gap-2 text-[12px] text-fg-3">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading video metadata…
                        </p>
                      ) : meta?.previewAvailable ? (
                        <div className="grid grid-cols-3 gap-2 text-[12px]">
                          <span className="text-fg-3">
                            Duration <span className="block font-mono font-semibold text-fg-2">{formatDuration(meta.durationSeconds)}</span>
                          </span>
                          <span className="text-fg-3">
                            Resolution{" "}
                            <span className="block font-mono font-semibold text-fg-2">
                              {meta.width}×{meta.height}
                            </span>
                          </span>
                          <span className="text-fg-3">
                            Preview <span className="block font-semibold text-accent">Available</span>
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                          <p className="text-[12px] leading-relaxed text-fg-2">
                            We couldn&apos;t decode this video in the browser — the file may be corrupt or use an
                            unsupported codec (common with some MKV files). You can still upload it
                            {mode === "server" ? " — the server will verify it with FFprobe" : ""}, but no preview or
                            thumbnail will be available.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* project name */}
                    <label className="mt-3 block border-t border-line pt-3">
                      <span className="mb-1.5 block text-[12px] font-semibold text-fg-2">Project name</span>
                      <input
                        value={projectName}
                        onChange={(e) => setProjectName(e.target.value)}
                        disabled={phase === "uploading"}
                        placeholder="Name this project…"
                        className={inputCls}
                      />
                    </label>

                    {/* upload progress */}
                    {phase === "uploading" && upload && (
                      <div className="mt-4 border-t border-line pt-3">
                        <div className="flex items-center justify-between text-[12px]">
                          <span className="font-semibold text-fg">
                            {mode === "server" ? "Uploading to server…" : "Saving to local storage…"} {upload.progress}%
                          </span>
                          <button
                            onClick={cancelUpload}
                            className="flex items-center gap-1 rounded-lg border border-line-2 px-2 py-1 text-[11px] font-semibold text-fg-2 transition-colors hover:border-red-500/40 hover:text-red-400"
                          >
                            <X className="h-3 w-3" /> Cancel upload
                          </button>
                        </div>
                        <Progress value={upload.progress} className="mt-2" />
                      </div>
                    )}

                    {/* upload error */}
                    {phase === "error" && (
                      <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3 border-t">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-semibold text-red-300">Upload failed</p>
                          <p className="mt-0.5 text-[12px] leading-relaxed text-fg-2">{uploadError}</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* URL import (later phase) */}
                <div className="mt-6 flex items-center gap-3">
                  <div className="h-px flex-1 bg-line-2" />
                  <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-3">or paste a link</span>
                  <div className="h-px flex-1 bg-line-2" />
                </div>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <div className="relative flex-1">
                    <Link2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleImportUrl()}
                      placeholder="Paste a YouTube, Vimeo or direct video URL…"
                      className={cn(inputCls, "h-10 pl-9")}
                    />
                  </div>
                  <Button variant="secondary" icon={Link2} onClick={handleImportUrl}>
                    Import URL
                  </Button>
                </div>
                <p className="mt-2 text-[11px] text-fg-3">Link import is planned for a later phase — file uploads work today.</p>

                {/* actions */}
                <div className="mt-6 flex flex-col items-start gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
                  <Button size="lg" icon={Upload} disabled={!file || probing || phase === "uploading"} onClick={handleUpload}>
                    {phase === "error" ? "Retry upload" : "Upload & create project"}
                  </Button>
                  <p className="text-[12px] leading-relaxed text-fg-3">
                    The video is stored as a project. Transcription runs from the Clip Editor once the backend is connected.
                  </p>
                </div>
              </>
            )}
          </Card>

          {/* How it works */}
          <Card className="p-5 sm:p-6">
            <h2 className="text-[15px] font-bold tracking-tight text-fg">How it works</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-3">Automation first — you never touch a timeline</p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {STEPS.map((s) => (
                <div key={s.title} className="rounded-xl border border-line bg-panel-2 p-4">
                  <IconTile icon={s.icon} tone="accent" className="h-8 w-8 rounded-lg" />
                  <p className="mt-3 text-[13px] font-bold text-fg">{s.title}</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-fg-3">{s.desc}</p>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Right: pipeline + recent */}
        <aside className="space-y-6">
          <Card className="p-5">
            <h3 className="text-[15px] font-bold tracking-tight text-fg">What happens next</h3>
            <p className="mt-0.5 text-[12.5px] text-fg-3">The full pipeline, fully automatic</p>
            <div className="mt-5">
              {FLOW.map((s, i) => (
                <div key={s.t} className="relative flex gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border [&>svg]:h-3.5 [&>svg]:w-3.5",
                        (s.tag === "Live" || s.tag === "Backend")
                          ? "border-accent/40 bg-accent/10 text-accent"
                          : "border-line-2 bg-panel-2 text-fg-3"
                      )}
                    >
                      <s.icon />
                    </div>
                    {i < FLOW.length - 1 && <div className="w-px flex-1 bg-line-2" />}
                  </div>
                  <div className={cn("pb-5", i === FLOW.length - 1 && "pb-0")}>
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-fg">{s.t}</span>
                      <span
                        className={cn(
                          "rounded px-1 py-px text-[9px] font-bold uppercase",
                          (s.tag === "Live" || s.tag === "Backend") ? "bg-accent/15 text-accent" : "bg-panel-2 text-fg-3"
                        )}
                      >
                        {s.tag}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="border-accent/20 bg-accent/[0.04] p-5">
            <div className="flex items-start gap-3">
              <IconTile icon={Zap} tone="accent" />
              <div>
                <p className="text-[13.5px] font-bold text-fg">Automation first</p>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-2">
                  No timestamps, no manual cutting, no caption writing. Upload → Generate clips → Download. The AI
                  steps arrive in later phases; your uploads are already stored and ready for them.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-bold tracking-tight text-fg">Recent uploads</h3>
              <button onClick={() => navigate("/projects")} className="text-[12px] font-semibold text-accent hover:text-accent-hi">
                View all
              </button>
            </div>
            <div className="mt-3 space-y-1">
              {projects.length === 0 && <p className="py-1 text-[12.5px] text-fg-3">Nothing uploaded yet.</p>}
              {projects.slice(0, 3).map((p) => (
                <button
                  key={p.id}
                  onClick={() => navigate(`/editor?project=${p.id}`)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-panel-2"
                >
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" className="h-8 w-12 shrink-0 rounded-lg border border-line object-cover" />
                  ) : (
                    <IconTile icon={Film} className="h-8 w-12 rounded-lg" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-fg">{p.name}</span>
                    <span className="block text-[11px] text-fg-3">
                      {p.duration} · {formatDate(p.createdAt)}
                    </span>
                  </span>
                  <StatusBadge status={p.status} pulse={p.status === "Uploading"} />
                </button>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
