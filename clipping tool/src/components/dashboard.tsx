import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CalendarDays,
  Captions,
  ChevronRight,
  Clock,
  FileVideo,
  FolderKanban,
  HardDrive,
  MoreVertical,
  Pencil,
  Scissors,
  Settings,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";
import { Button, Card, IconTile, inputCls, Modal, Progress, StatusBadge } from "./ui";
import { TranscriptChip } from "./TranscriptPanel";

/* ---------------------------------- stats --------------------------------- */

export function StatCard({
  label,
  value,
  delta,
  icon,
  spark,
  accent = false,
}: {
  label: string;
  value: string;
  delta: string;
  icon: LucideIcon;
  spark: number[];
  accent?: boolean;
}) {
  const max = Math.max(...spark);
  const min = Math.min(...spark);
  const points = spark
    .map((v, i) => `${(i / (spark.length - 1)) * 116 + 2},${28 - ((v - min) / (max - min || 1)) * 24}`)
    .join(" ");
  const last = points.split(" ").pop()!.split(",");
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <IconTile icon={icon} tone={accent ? "accent" : "neutral"} />
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">{delta}</span>
      </div>
      <div className="mt-4 font-mono text-[26px] font-semibold leading-none tracking-tight text-fg">{value}</div>
      <div className="mt-1.5 text-[12.5px] text-fg-3">{label}</div>
      <svg viewBox="0 0 120 32" className="mt-4 h-8 w-full" fill="none">
        <polyline points={points} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="text-fg-3/50" />
        <circle cx={last[0]} cy={last[1]} r="2.4" className="fill-accent" />
      </svg>
    </Card>
  );
}

/* ------------------------------- project card ------------------------------ */

function Meta({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-[0.12em] text-fg-3">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12px] font-semibold text-fg-2">{value}</div>
    </div>
  );
}

export function ProjectCard({ project }: { project: Project }) {
  const navigate = useNavigate();
  const { renameProject, deleteProject, toast } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const open = () => navigate(`/editor?project=${project.id}`);

  const saveRename = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await renameProject(project.id, trimmed);
      setRenaming(false);
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
      setConfirmingDelete(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "info");
      setBusy(false);
    }
  };

  return (
    <Card className="group overflow-hidden transition-colors duration-200 hover:border-line-2">
      {/* Thumbnail (real frame captured from the uploaded video, when available) */}
      <div className="relative aspect-[16/9] cursor-pointer border-b border-line bg-panel-2" onClick={open}>
        {project.thumbnail ? (
          <img src={project.thumbnail} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="pattern-dots absolute inset-0">
            <FileVideo className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 text-fg-3/60 transition-opacity duration-200 group-hover:opacity-0" />
          </div>
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex h-12 w-12 scale-75 items-center justify-center rounded-full border border-line-2 bg-panel/90 opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
            <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-fg text-fg">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        <div className="absolute left-3 top-3">
          <StatusBadge status={project.status} pulse={project.status === "Uploading"} />
        </div>
        {project.transcriptStatus !== "none" && (
          <TranscriptChip status={project.transcriptStatus} className="absolute right-3 top-3 bg-black/70 backdrop-blur-sm" />
        )}
        {(project.clipsTotal > 0 || !project.previewAvailable) && (
          <div className="absolute bottom-3 left-3 flex flex-col items-start gap-1.5">
            {project.clipsTotal > 0 && (
              <span className="rounded-md border border-line bg-black/60 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-fg-2 backdrop-blur-sm">
                {project.clipsCompleted}/{project.clipsTotal} clips
              </span>
            )}
            {!project.previewAvailable && (
              <span className="rounded-md border border-line bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-fg-2 backdrop-blur-sm">
                Preview unavailable
              </span>
            )}
          </div>
        )}
        <div className="absolute bottom-3 right-3 rounded-md border border-line bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-fg backdrop-blur-sm">
          {project.duration}
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 cursor-pointer truncate text-[14px] font-semibold text-fg" onClick={open}>
            {project.name}
          </h3>
          <div className="relative shrink-0">
            <button
              aria-label="Project actions"
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-lg p-1 text-fg-3 transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-50 w-40 overflow-hidden rounded-xl border border-line-2 bg-raised p-1 shadow-2xl shadow-black/50">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      open();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
                  >
                    <FileVideo className="h-4 w-4 text-fg-3" /> Open project
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setName(project.name);
                      setRenaming(true);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
                  >
                    <Pencil className="h-4 w-4 text-fg-3" /> Rename
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmingDelete(true);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/10"
                  >
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {project.momentStatus !== "none" && (
          <button onClick={open} className="mt-2 text-left text-[11px] font-medium text-fg-2 hover:text-accent">
            {project.momentStatus === "completed" ? `${project.momentCandidateCount} AI moment candidates` : project.momentStatus === "failed" ? "Moment analysis failed - retry" : "Analyzing moments..."}
          </button>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
          <Meta icon={Clock} label="Duration" value={project.duration} />
          <Meta icon={CalendarDays} label="Created" value={formatDate(project.createdAt)} />
          <Meta icon={HardDrive} label="Size" value={project.size} />
        </div>
      </div>

      {/* Rename modal */}
      <Modal open={renaming} onClose={() => setRenaming(false)} title="Rename project">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-semibold text-fg-2">Project name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveRename()}
            className={inputCls}
            autoFocus
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={saveRename}>
            Save name
          </Button>
        </div>
      </Modal>

      {/* Delete confirmation */}
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
    </Card>
  );
}

/* ------------------------------ upload activity ----------------------------- */

export function UploadActivity() {
  const { upload, cancelUpload, dismissUpload, projects } = useStore();
  const navigate = useNavigate();
  const recent = projects.slice(0, 3);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight text-fg">
          Upload activity
          {upload?.status === "uploading" && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
          )}
        </h3>
        <span className="text-[11px] font-semibold text-fg-3">{projects.length} uploaded</span>
      </div>

      <div className="mt-4 space-y-4">
        {upload?.status === "uploading" && (
          <div>
            <div className="flex items-center gap-3">
              <IconTile icon={Upload} tone="accent" className="h-8 w-8 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-fg">{upload.fileName}</div>
                <div className="text-[11px] text-fg-3">Uploading… {upload.progress}%</div>
              </div>
              <button
                onClick={cancelUpload}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-line-2 px-2 py-1 text-[11px] font-semibold text-fg-2 transition-colors hover:border-red-500/40 hover:text-red-400"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
            </div>
            <Progress className="mt-2" value={upload.progress} />
          </div>
        )}
        {upload?.status === "error" && (
          <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-semibold text-red-400">Upload failed — {upload.fileName}</p>
              <button aria-label="Dismiss" onClick={dismissUpload} className="text-fg-3 hover:text-fg">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-fg-2">{upload.error}</p>
          </div>
        )}
        {!upload && recent.length === 0 && (
          <p className="py-1 text-[13px] text-fg-3">No uploads yet — your activity will appear here.</p>
        )}
        {recent.map((p) => (
          <button
            key={p.id}
            onClick={() => navigate(`/editor?project=${p.id}`)}
            className="flex w-full items-center gap-3 text-left"
          >
            {p.thumbnail ? (
              <img src={p.thumbnail} alt="" className="h-8 w-12 shrink-0 rounded-lg border border-line object-cover" />
            ) : (
              <IconTile icon={FileVideo} className="h-8 w-12 rounded-lg" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-fg">{p.name}</span>
              <span className="block text-[11px] text-fg-3">
                {p.duration} · {p.size}
              </span>
            </span>
            <StatusBadge status={p.status} />
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ------------------------------- quick actions ------------------------------ */

const ACTIONS = [
  { label: "Upload video", sub: "MP4 · MOV · MKV · WebM, up to 2 GB", icon: Upload, to: "/create", badge: "Start" },
  { label: "Project library", sub: "Open, rename and manage uploads", icon: FolderKanban, to: "/projects" },
  { label: "Caption studio", sub: "Style presets for your clips", icon: Captions, to: "/captions" },
  { label: "Workspace settings", sub: "Storage, defaults and plan", icon: Settings, to: "/settings" },
];

export function QuickActions() {
  const navigate = useNavigate();
  return (
    <Card className="p-5">
      <h3 className="text-[15px] font-bold tracking-tight text-fg">Quick actions</h3>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {ACTIONS.map((a) => (
          <button
            key={a.label}
            onClick={() => navigate(a.to)}
            className="group flex items-center gap-3 rounded-xl border border-line bg-panel-2 p-3 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.04]"
          >
            <IconTile
              icon={a.icon}
              className="transition-colors group-hover:border-accent/30 group-hover:bg-accent/10 group-hover:text-accent"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                {a.label}
                {a.badge && (
                  <span className="rounded bg-accent/15 px-1 py-px text-[9px] font-bold uppercase text-accent">
                    {a.badge}
                  </span>
                )}
              </span>
              <span className="block truncate text-[11px] text-fg-3">{a.sub}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-fg-3 transition-colors group-hover:text-accent" />
          </button>
        ))}
      </div>
    </Card>
  );
}

// Re-exported for pages that previously imported a scissors icon tile
export { Scissors };
