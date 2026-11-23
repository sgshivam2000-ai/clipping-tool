import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Download,
  Loader2,
  RefreshCw,
  Scissors,
  Sparkles,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes, formatDuration, formatTimecode } from "@/lib/format";
import { downloadClip, getClipFileUrl } from "@/lib/api";
import { useClips } from "@/lib/useClips";
import { useStore } from "@/lib/store";
import type { ClipRecord, MomentCandidate, MomentResult, Project } from "@/lib/types";
import { Button, Card, IconTile, Progress, inputCls } from "./ui";
import { ReframeControls } from "./ReframeControls";

const QUALITY_OPTIONS = [
  { value: "low", label: "Low (smallest)" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High (larger)" },
];

function statusBadgeFor(clip: ClipRecord | undefined) {
  const label = !clip
    ? "Not generated"
    : { queued: "Queued", processing: "Generating", completed: "Ready", failed: "Failed" }[clip.status];
  const cls = !clip
    ? "border-line-2 bg-panel-2 text-fg-3"
    : clip.status === "failed"
      ? "border-red-500/25 bg-red-500/10 text-red-400"
      : clip.status === "processing" || clip.status === "completed"
        ? "border-accent/25 bg-accent/10 text-accent"
        : "border-line-2 bg-panel-2 text-fg-2";
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-bold", cls)}>
      {clip?.status === "processing" && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </span>
  );
}

export interface MomentApi {
  result: MomentResult | null;
  loading: boolean;
}

export function ClipPanel({ project, moment }: { project: Project; moment: MomentApi }) {
  const { mode, toast } = useStore();
  const serverMode = mode === "server";
  const { summary, error, loading, starting, start, reload } = useClips(project.id, serverMode);
  const [quality, setQuality] = useState("standard");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<string | null>(null);

  const candidates = moment.result?.status === "completed" ? moment.result.candidates : [];
  const candidateKey = candidates.map((c) => c.id).join("|");

  // When a new analysis set arrives, all candidates start selected.
  // Manual deselection is preserved until the analysis changes.
  useEffect(() => {
    setChecked(new Set(candidates.map((c) => c.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, moment.result?.status]);

  const clipByCandidate = useMemo(() => {
    const map = new Map<string, ClipRecord>();
    for (const clip of summary?.clips ?? []) map.set(clip.candidateId, clip);
    return map;
  }, [summary?.clips]);

  const selectedIds = candidates.filter((c) => checked.has(c.id)).map((c) => c.id);
  const anyBusy = starting || (summary?.queued ?? 0) > 0 || (summary?.processing ?? 0) > 0;
  const canGenerate = serverMode && candidates.length > 0 && !anyBusy && !loading;

  const generate = async (ids: string[]) => {
    if (!ids.length) return;
    await start(ids, quality);
  };

  const download = async (clip: ClipRecord) => {
    setDownloading(clip.id);
    try {
      await downloadClip(clip.id, `${clip.title}.mp4`);
      toast(`Download started — ${clip.title}.mp4`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Download failed", "info");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Card id="clips" className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconTile icon={Scissors} tone="accent" />
          <div>
            <h2 className="text-[15px] font-bold tracking-tight text-fg">Generated clips</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-3">Real FFmpeg cuts from your AI-selected moments.</p>
          </div>
        </div>
        {summary && summary.total > 0 && (
          <span className="text-[11px] font-semibold text-fg-3">
            {summary.completed}/{summary.total} ready · {summary.queued} queued · {summary.failed} failed
          </span>
        )}
      </div>

      {!serverMode && (
        <Notice title="Clip generation needs the CLIPFORGE backend">
          Clip cutting runs on the backend with FFmpeg. Start the server and upload your video there.
        </Notice>
      )}

      {serverMode && candidates.length === 0 && (
        <Notice title="Analyze moments first">
          Complete AI moment analysis above so its candidates can become real clips.
          <button onClick={() => document.getElementById("ai-moments")?.scrollIntoView({ behavior: "smooth", block: "start" })} className="mt-1 block text-[12px] font-semibold text-accent hover:text-accent-hi">
            Go to AI moments
          </button>
        </Notice>
      )}

      {serverMode && candidates.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[12px] font-semibold text-fg-3">
              Quality
              <select value={quality} disabled={anyBusy} onChange={(e) => setQuality(e.target.value)} className={cn(inputCls, "mt-1 h-9 w-auto min-w-40 appearance-none")}>
                {QUALITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <Button
              size="sm"
              icon={anyBusy ? Loader2 : Sparkles}
              className={cn(anyBusy && "[&>svg]:animate-spin")}
              disabled={!canGenerate || selectedIds.length === 0}
              onClick={() => void generate(selectedIds)}
            >
              {anyBusy ? "Generating…" : `Generate selected (${selectedIds.length})`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Scissors}
              disabled={!canGenerate || selectedIds.length === candidates.length}
              onClick={() => { setChecked(new Set(candidates.map((c) => c.id))); void generate(candidates.map((c) => c.id)); }}
            >
              Generate all ({candidates.length})
            </Button>
            {summary?.currentClip && (
              <span className="text-[11.5px] font-semibold text-fg-2">Current: {summary.currentClip.title}</span>
            )}
          </div>

          {error && (
            <Notice danger title="Could not start clip generation">
              {error}
              <Button variant="ghost" size="sm" icon={RefreshCw} className="mt-2 px-0" onClick={() => void reload()}>Refresh status</Button>
            </Notice>
          )}

          <div className="divide-y divide-line rounded-xl border border-line">
            {candidates.map((candidate) => (
              <CandidateClipRow
                key={candidate.id}
                projectId={project.id}
                quality={quality}
                serverMode={serverMode}
                candidate={candidate}
                clip={clipByCandidate.get(candidate.id)}
                checked={checked.has(candidate.id)}
                onToggleChecked={() => setChecked((prev) => {
                  const next = new Set(prev);
                  if (next.has(candidate.id)) next.delete(candidate.id);
                  else next.add(candidate.id);
                  return next;
                })}
                disabled={anyBusy}
                onGenerate={() => void generate([candidate.id])}
                onDownload={download}
                downloading={downloading === clipByCandidate.get(candidate.id)?.id}
              />
            ))}
          </div>

          {summary && summary.failed > 0 && (
            <p className="text-[11.5px] text-fg-3">
              Failed jobs keep their error message. Fix the cause (source file, FFmpeg, disk), then use “Retry”.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function CandidateClipRow({ projectId, quality, serverMode, candidate, clip, checked, onToggleChecked, disabled, onGenerate, onDownload, downloading }: {
  projectId: string;
  quality: string;
  serverMode: boolean;
  candidate: MomentCandidate;
  clip: ClipRecord | undefined;
  checked: boolean;
  onToggleChecked: () => void;
  disabled: boolean;
  onGenerate: () => void;
  onDownload: (clip: ClipRecord) => Promise<void>;
  downloading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2.5 p-3.5 sm:flex-row sm:items-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggleChecked}
        aria-label={`Select ${candidate.title}`}
        className="h-4 w-4 shrink-0 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[11px] text-fg-3">{String(candidate.rank).padStart(2, "0")}</span>
          <span className="truncate text-[13px] font-semibold text-fg">{candidate.title}</span>
          {statusBadgeFor(clip)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
          <span>{formatTimecode(candidate.start)} → {formatTimecode(candidate.end)}</span>
          <span>{formatDuration(candidate.duration)}</span>
          {candidate.category && <span>{candidate.category}</span>}
          {clip?.sizeBytes != null && <span>{formatBytes(clip.sizeBytes)}</span>}
        </div>
        {clip?.status === "processing" && (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={clip.progress} className="w-32" />
            <span className="font-mono text-[11px] text-fg-3">{Math.round(clip.progress)}%</span>
          </div>
        )}
        {clip?.status === "failed" && clip.error && (
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {clip.error}
          </p>
        )}
        {clip?.status === "completed" && clip.filePath && (
          <video
            key={clip.id}
            src={getClipFileUrl(clip.id)}
            controls
            preload="metadata"
            className="mt-2 max-h-44 w-full rounded-lg border border-line bg-black"
          />
        )}
        {clip?.status === "completed" && clip.filePath && (
          <ReframeControls projectId={projectId} clip={clip} quality={quality} disabled={disabled} enabled={serverMode} />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {clip?.status === "completed" && clip.filePath ? (
          <>
            <Button variant="secondary" size="sm" icon={Download} disabled={downloading} onClick={() => void onDownload(clip)}>
              {downloading ? "Downloading…" : "Download"}
            </Button>
            <Button variant="ghost" size="sm" icon={RefreshCw} onClick={onGenerate}>Regenerate</Button>
          </>
        ) : clip?.status === "failed" ? (
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={onGenerate}>Retry</Button>
        ) : clip ? (
          <Button size="sm" icon={Sparkles} disabled={disabled} onClick={onGenerate}>Re-run</Button>
        ) : (
          <Button size="sm" icon={Sparkles} disabled={disabled} onClick={onGenerate}>Generate</Button>
        )}
      </div>
    </div>
  );
}

function Notice({ title, danger = false, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return (
    <div role={danger ? "alert" : undefined} className={cn("flex gap-3 rounded-xl border p-3.5",
      danger ? "border-red-500/25 bg-red-500/[0.05]" : "border-line-2 bg-panel-2")}>
      <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", danger ? "text-red-400" : "text-accent")} />
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-fg">{title}</p>
        <div className="mt-1 text-[12px] leading-relaxed text-fg-2">{children}</div>
      </div>
    </div>
  );
}
