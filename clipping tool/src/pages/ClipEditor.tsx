import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Captions,
  Check,
  Copy,
  Crop,
  Download,
  FileWarning,
  FolderOpen,
  Loader2,
  Lock,
  Mic,
  Pencil,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { formatBytes, formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";
import { useMoments } from "@/lib/useMoments";
import type { MomentCandidate, TranscriptStatus } from "@/lib/types";
import { Button, Card, Chip, EmptyState, IconButton, Modal, StatusBadge, inputCls } from "@/components/ui";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { MomentPanel } from "@/components/MomentPanel";
import { ClipPanel } from "@/components/ClipPanel";

type StepState = "done" | "running" | "failed" | "ready" | "next";

function transcriptStepState(status: TranscriptStatus): StepState {
  switch (status) {
    case "completed":
      return "done";
    case "queued":
    case "processing":
      return "running";
    case "failed":
      return "failed";
    default:
      return "ready";
  }
}

const STEP_VIEW: Record<StepState, { text: string; cls: string; icon?: LucideIcon; spin?: boolean }> = {
  done: { text: "Done", cls: "text-accent", icon: Check },
  running: { text: "Running", cls: "text-accent", icon: Loader2, spin: true },
  failed: { text: "Failed", cls: "text-red-400", icon: X },
  ready: { text: "Available", cls: "text-fg-2" },
  next: { text: "Next phase", cls: "text-fg-3", icon: Lock },
};

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <span className="shrink-0 text-[12px] font-semibold text-fg-3">{label}</span>
      <span
        className={`min-w-0 break-all text-right text-[12.5px] font-medium text-fg-2 ${mono ? "font-mono text-[11.5px]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

export default function ClipEditor() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { projects, loading, renameProject, deleteProject, videoUrl, toast, mode } = useStore();

  const projectId = params.get("project");
  const project = projectId ? projects.find((p) => p.id === projectId) : projects[0];
  const moments = useMoments(project?.id ?? "", mode === "server" && !!project, project?.transcriptStatus ?? "none");

  const videoRef = useRef<HTMLVideoElement>(null);
  const passageEnd = useRef<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [videoError, setVideoError] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setVideoError("");
    setPlayhead(0);
    passageEnd.current = null;
    if (!project) return;
    videoUrl(project.id)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch((err: unknown) => {
        if (alive) setVideoError(err instanceof Error ? err.message : "Could not load the video file.");
      });
    return () => {
      alive = false;
    };
  }, [project?.id, videoUrl]);

  if (!project) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={loading ? "Loading projects…" : projectId ? "Project not found" : "No project selected"}
        sub={loading ? "Fetching your uploads." : projectId ? "This project may have been deleted or belongs to a different storage mode. Choose a project from your library." : "Upload a video first — then open it here to preview, transcribe and manage it."}
        action={
          !loading ? (
            <Button size="sm" icon={projectId ? FolderOpen : Upload} onClick={() => navigate(projectId ? "/projects" : "/create")}>
              {projectId ? "View projects" : "Upload a video"}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const ext = project.originalFileName.split(".").pop()?.toUpperCase() ?? "—";
  const canPreview = project.previewAvailable && !!src;

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    passageEnd.current = null;
    video.currentTime = seconds;
    setPlayhead(seconds);
    void video.play().catch(() => undefined);
  };

  const previewCandidate = (candidate: MomentCandidate) => {
    const video = videoRef.current;
    if (!video) return;
    passageEnd.current = candidate.end;
    video.currentTime = candidate.start;
    setPlayhead(candidate.start);
    void video.play().catch(() => undefined);
    video.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const steps: { icon: LucideIcon; label: string; state: StepState }[] = [
    { icon: Upload, label: "Upload video", state: "done" },
    { icon: Mic, label: "Transcribe speech (Whisper)", state: transcriptStepState(project.transcriptStatus) },
    { icon: Sparkles, label: "Detect best moments", state: transcriptStepState(project.momentStatus) },
    { icon: Scissors, label: "Generate clips", state: project.clipsTotal > 0 && project.clipsCompleted < project.clipsTotal ? "running" : project.clipsTotal > 0 ? "done" : "ready" },
    { icon: Captions, label: "Auto captions", state: "next" },
    { icon: Crop, label: "Vertical reframe 9:16", state: project.clipsCompleted > 0 ? "ready" : "next" },
    { icon: Download, label: "Export", state: "next" },
  ];

  const saveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await renameProject(project.id, trimmed);
      setEditingName(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Rename failed", "info");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteProject(project.id);
      navigate("/projects");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "info");
      setBusy(false);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(project.id);
      toast("Project ID copied");
    } catch {
      toast("Copy not available in this browser", "info");
    }
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <IconButton icon={ArrowLeft} label="Back to projects" onClick={() => navigate("/projects")} />
        {editingName ? (
          <div className="flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className={`${inputCls} h-9.5 w-[280px] font-semibold`}
              autoFocus
            />
            <IconButton icon={Check} label="Save name" onClick={saveName} className="bg-accent/10 text-accent" />
            <IconButton icon={X} label="Cancel" onClick={() => setEditingName(false)} />
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="max-w-[420px] truncate text-[20px] font-bold tracking-tight text-fg">{project.name}</h1>
            <IconButton
              icon={Pencil}
              label="Rename project"
              onClick={() => {
                setNameDraft(project.name);
                setEditingName(true);
              }}
            />
          </div>
        )}
        <StatusBadge status={project.status} pulse={project.status === "Uploading"} />
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            icon={Sparkles}
            onClick={() => document.getElementById("ai-moments")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            AI moments
          </Button>
          <Button icon={Download} onClick={() => toast("Exporting arrives after clips exist", "info")}>
            Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Left column: player, transcript, pipeline */}
        <div className="space-y-5">
          <Card className="p-4">
            {videoError ? (
              <div className="flex aspect-video flex-col items-center justify-center rounded-xl border border-red-500/25 bg-red-500/[0.04] px-6 text-center">
                <FileWarning className="h-8 w-8 text-red-400" />
                <p className="mt-3 text-[14px] font-semibold text-fg">Video file could not be loaded</p>
                <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-fg-3">{videoError}</p>
              </div>
            ) : project.previewAvailable && src ? (
              <video
                ref={videoRef}
                key={src}
                src={src}
                controls
                preload="metadata"
                poster={project.thumbnail ?? undefined}
                onTimeUpdate={(e) => {
                  const video = e.currentTarget;
                  if (passageEnd.current !== null && video.currentTime >= passageEnd.current) {
                    video.pause();
                    passageEnd.current = null;
                  }
                  setPlayhead(video.currentTime);
                }}
                className="aspect-video w-full rounded-xl border border-line bg-black"
              />
            ) : project.previewAvailable ? (
              <div className="flex aspect-video items-center justify-center rounded-xl border border-line bg-black">
                <Loader2 className="h-6 w-6 animate-spin text-fg-3" />
              </div>
            ) : (
              <div className="pattern-dots flex aspect-video flex-col items-center justify-center rounded-xl border border-line bg-panel-2 px-6 text-center">
                <FileWarning className="h-8 w-8 text-fg-3" />
                <p className="mt-3 text-[14px] font-semibold text-fg">Preview unavailable in this browser</p>
                <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-fg-3">
                  The file is stored safely, but this browser can&apos;t decode its codec (common for some MKV files),
                  so it can&apos;t be played here.
                </p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-1.5">
              <Chip>{ext}</Chip>
              <Chip>{project.duration}</Chip>
              <Chip>{project.width ? `${project.width}×${project.height}` : "Resolution unknown"}</Chip>
              <Chip>{project.size}</Chip>
              <Chip>{project.previewAvailable ? "Preview available" : "No preview"}</Chip>
            </div>
          </Card>

          <MomentPanel key={`moments-${project.id}`} project={project} canPreview={canPreview} onPreview={previewCandidate} moments={moments} />

          <ClipPanel key={`clips-${project.id}`} project={project} moment={moments} />

          <TranscriptPanel key={`transcript-${project.id}`} project={project} playhead={playhead} canPreview={canPreview} onSeek={seekTo} />

          {/* Workflow status */}
          <Card className="p-5">
            <h3 className="text-[15px] font-bold tracking-tight text-fg">Processing workflow</h3>
            <p className="mt-0.5 text-[12.5px] text-fg-3">
              Transcribe, find the best moments, generate clips, then reframe finished clips to vertical 9:16.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {steps.map((s) => {
                const view = STEP_VIEW[s.state];
                const StateIcon = view.icon;
                return (
                  <div key={s.label} className="flex items-center gap-3 rounded-xl border border-line bg-panel-2 px-3.5 py-3">
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border [&>svg]:h-3.5 [&>svg]:w-3.5 ${
                        s.state === "done" || s.state === "running"
                          ? "border-accent/40 bg-accent/10 text-accent"
                          : "border-line-2 bg-panel text-fg-3"
                      }`}
                    >
                      <s.icon />
                    </span>
                    <span className="flex-1 text-[13px] font-semibold text-fg">{s.label}</span>
                    <span className={`flex items-center gap-1 text-[11px] font-bold ${view.cls}`}>
                      {StateIcon && <StateIcon className={`h-3.5 w-3.5 ${view.spin ? "animate-spin" : ""}`} />}
                      {view.text}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Details */}
        <aside className="space-y-5">
          <Card className="p-5">
            <h3 className="text-[15px] font-bold tracking-tight text-fg">Project details</h3>
            <div className="mt-2 divide-y divide-line">
              <div className="flex items-center justify-between gap-3 py-2">
                <span className="text-[12px] font-semibold text-fg-3">Project ID</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="max-w-[150px] truncate font-mono text-[11px] text-fg-2">{project.id}</span>
                  <IconButton icon={Copy} label="Copy project ID" className="h-6 w-6" onClick={copyId} />
                </span>
              </div>
              <DetailRow label="Original filename" value={project.originalFileName} />
              <DetailRow label="Storage path" value={project.storagePath} mono />
              <DetailRow label="Format" value={`${ext}${project.mimeType ? ` · ${project.mimeType}` : ""}`} />
              <DetailRow label="File size" value={`${project.size} (${formatBytes(project.sizeBytes)})`} />
              <DetailRow label="Duration" value={project.duration} />
              <DetailRow label="Resolution" value={project.width ? `${project.width} × ${project.height}px` : "Unknown"} />
              <DetailRow label="Uploaded" value={formatDate(project.createdAt)} />
              <DetailRow label="Source" value={project.source} />
              <DetailRow
                label="Transcript"
                value={
                  project.transcriptStatus === "completed"
                    ? `Ready${project.transcriptLanguage ? ` · ${project.transcriptLanguage}` : ""}`
                    : project.transcriptStatus === "none"
                      ? "Not transcribed"
                      : project.transcriptStatus.charAt(0).toUpperCase() + project.transcriptStatus.slice(1)
                }
              />
              <DetailRow label="AI moments" value={project.momentStatus === "completed" ? `${project.momentCandidateCount} candidates` : project.momentStatus === "none" ? "Not analyzed" : project.momentStatus} />
            </div>
            <div className="mt-4 flex gap-2 border-t border-line pt-4">
              <Button
                variant="secondary"
                size="sm"
                icon={Pencil}
                className="flex-1"
                onClick={() => {
                  setNameDraft(project.name);
                  setEditingName(true);
                }}
              >
                Rename
              </Button>
              <Button variant="danger" size="sm" icon={Trash2} className="flex-1" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            </div>
          </Card>
        </aside>
      </div>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} title="Delete project?">
        <p className="text-[13px] leading-relaxed text-fg-2">
          “{project.name}” and its uploaded video file ({project.size}) will be permanently deleted. This cannot be
          undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setConfirmingDelete(false)}>
            Keep project
          </Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={doDelete}>
            Delete project
          </Button>
        </div>
      </Modal>
    </div>
  );
}
