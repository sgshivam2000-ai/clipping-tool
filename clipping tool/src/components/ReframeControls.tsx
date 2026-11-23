import { useState } from "react";
import { AlertTriangle, Crop, Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes, formatDuration } from "@/lib/format";
import { getReframeFileUrl } from "@/lib/api";
import { useReframe } from "@/lib/useReframe";
import type { ClipRecord } from "@/lib/types";
import { Button, Progress } from "./ui";

function methodLabel(method: ClipRecord["status"] | string | null): string {
  if (method === "face-tracked") return "Face tracked";
  if (method === "center-crop-fallback") return "Center-crop fallback";
  return "9:16";
}

export function ReframeControls({
  projectId,
  clip,
  quality,
  disabled,
  enabled,
}: {
  projectId: string;
  clip: ClipRecord;
  quality: string;
  disabled: boolean;
  enabled: boolean;
}) {
  const { reframe, error, loading, starting, deleting, downloading, start, remove, download, reload } = useReframe(
    projectId,
    clip.id,
    enabled,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = starting || reframe.status === "queued" || reframe.status === "processing";
  const actionDisabled = disabled || busy || loading || !enabled;

  return (
    <div className="mt-3 rounded-xl border border-line bg-panel-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
          <Crop className="h-3.5 w-3.5 text-accent" /> Vertical 9:16
        </span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-bold",
            reframe.status === "failed"
              ? "border-red-500/25 bg-red-500/10 text-red-400"
              : reframe.status === "completed"
                ? "border-accent/25 bg-accent/10 text-accent"
                : "border-line-2 bg-panel text-fg-2",
          )}
        >
          {reframe.status === "none"
            ? "Not reframed"
            : reframe.status === "queued"
              ? "Queued"
              : reframe.status === "processing"
                ? "Reframing"
                : reframe.status === "completed"
                  ? methodLabel(reframe.method)
                  : "Failed"}
        </span>
        {reframe.status === "completed" && (
          <span className="text-[11px] text-fg-3">
            {reframe.outputWidth}×{reframe.outputHeight} · {reframe.aspectRatio}
            {reframe.sizeBytes != null ? ` · ${formatBytes(reframe.sizeBytes)}` : ""}
            {reframe.duration != null ? ` · ${formatDuration(reframe.duration)}` : ""}
          </span>
        )}
      </div>

      {loading && <p className="mt-2 text-[11.5px] text-fg-3">Checking reframe status…</p>}

      {error && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-red-400">
          <span className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </span>
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void reload()}>
            Refresh
          </Button>
        </div>
      )}

      {reframe.status === "failed" && reframe.error && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {reframe.error}
        </p>
      )}

      {(reframe.status === "queued" || reframe.status === "processing") && (
        <div className="mt-2 flex items-center gap-2" role="status" aria-live="polite">
          <Progress value={reframe.progress} className="w-36" />
          <span className="font-mono text-[11px] text-fg-3">{Math.round(reframe.progress)}%</span>
          <span className="text-[11px] text-fg-3">
            {reframe.status === "queued" ? "Waiting to reframe" : reframe.progress < 40 ? "Detecting subject" : "Rendering vertical video"}
          </span>
        </div>
      )}

      {reframe.status === "completed" && reframe.filePath && (
        <video
          key={reframe.id ?? reframe.filePath}
          src={getReframeFileUrl(projectId, clip.id)}
          controls
          preload="metadata"
          className="mt-3 aspect-[9/16] max-h-72 w-auto max-w-full rounded-lg border border-line bg-black"
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {reframe.status === "none" && (
          <Button size="sm" icon={busy ? Loader2 : Crop} className={cn(busy && "[&>svg]:animate-spin")} disabled={actionDisabled} onClick={() => void start(quality)}>
            Reframe to 9:16
          </Button>
        )}

        {reframe.status === "failed" && (
          <Button variant="secondary" size="sm" icon={RefreshCw} disabled={actionDisabled} onClick={() => void start(quality)}>
            Retry reframe
          </Button>
        )}

        {reframe.status === "completed" && (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              disabled={downloading || disabled}
              onClick={() => void download(clip.title)}
            >
              {downloading ? "Downloading…" : "Download 9:16"}
            </Button>
            <Button variant="ghost" size="sm" icon={RefreshCw} disabled={actionDisabled} onClick={() => void start(quality)}>
              Regenerate
            </Button>
            {confirmDelete ? (
              <>
                <Button variant="danger" size="sm" icon={Trash2} disabled={deleting} onClick={() => void remove()}>
                  {deleting ? "Deleting…" : "Confirm delete"}
                </Button>
                <Button variant="ghost" size="sm" disabled={deleting} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                disabled={disabled || deleting}
                onClick={() => setConfirmDelete(true)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                Delete
              </Button>
            )}
          </>
        )}

        {(reframe.status === "queued" || reframe.status === "processing") && (
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-fg-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            {reframe.status === "queued" ? "Queued" : "Processing"}
          </span>
        )}
      </div>
    </div>
  );
}
