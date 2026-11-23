import { useEffect, useState } from "react";
import { AlertTriangle, Copy, Loader2, Mic, RefreshCw, Search, SearchX } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTimecode, timeAgo } from "@/lib/format";
import { getEngineStatus, type EngineStatus } from "@/lib/api";
import { useStore } from "@/lib/store";
import { errorMessage, useTranscript } from "@/lib/useTranscript";
import type { Project, TranscriptStatus } from "@/lib/types";
import { Button, Card, EmptyState, IconTile, inputCls, Progress } from "./ui";

const MODEL_OPTIONS = [
  { value: "tiny", label: "Tiny · fastest" },
  { value: "base", label: "Base · balanced" },
  { value: "small", label: "Small · more accurate" },
  { value: "medium", label: "Medium · most accurate (slow on CPU)" },
];

const LANGUAGE_CODES = ["en", "es", "fr", "de", "it", "pt", "nl", "ru", "ja", "ko", "zh", "hi", "ar", "tr", "pl", "sv"];

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const CHIP: Record<TranscriptStatus, { label: string; cls: string; pulse?: boolean }> = {
  none: { label: "Not transcribed", cls: "border-line-2 bg-panel-2 text-fg-3" },
  queued: { label: "Queued", cls: "border-line-2 bg-panel-2 text-fg-2" },
  processing: { label: "Transcribing", cls: "border-accent/25 bg-accent/10 text-accent", pulse: true },
  completed: { label: "Transcript ready", cls: "border-accent/25 bg-accent/10 text-accent" },
  failed: { label: "Transcript failed", cls: "border-red-500/25 bg-red-500/10 text-red-400" },
};

/** Small status pill for transcription state (used on project cards and the panel header). */
export function TranscriptChip({ status, className }: { status: TranscriptStatus; className?: string }) {
  const c = CHIP[status] ?? CHIP.none;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-bold",
        c.cls,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current", c.pulse && "animate-pulse")} />
      {c.label}
    </span>
  );
}

function Banner({
  tone,
  title,
  children,
  action,
}: {
  tone: "info" | "error";
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-3.5 sm:flex-row sm:items-start",
        tone === "error" ? "border-red-500/25 bg-red-500/[0.06]" : "border-line-2 bg-panel-2"
      )}
    >
      <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", tone === "error" ? "text-red-400" : "text-accent")} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[12.5px] font-semibold", tone === "error" ? "text-red-300" : "text-fg")}>{title}</p>
        <div className="mt-0.5 text-[12px] leading-relaxed text-fg-2">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function TranscriptPanel({
  project,
  playhead,
  canPreview,
  onSeek,
}: {
  project: Project;
  playhead: number;
  canPreview: boolean;
  onSeek: (seconds: number) => void;
}) {
  const { mode, toast } = useStore();
  const serverMode = mode === "server";
  const { transcript, requestError, starting, loaded, start, reload } = useTranscript(project.id, serverMode);

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [model, setModel] = useState("base");
  const [language, setLanguage] = useState("auto");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!serverMode) return;
    let alive = true;
    getEngineStatus()
      .then((e) => {
        if (!alive) return;
        setEngine(e);
        setEngineError(null);
        setModel(e.config.defaultModel);
      })
      .catch((err: unknown) => {
        if (alive) setEngineError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [serverMode]);

  const status: TranscriptStatus = transcript?.status ?? project.transcriptStatus;
  const busy = status === "queued" || status === "processing" || starting;
  const engineReady = engine?.available === true;
  const segments = transcript?.segments ?? [];
  const q = query.trim().toLowerCase();
  const visible = q ? segments.filter((s) => s.text.toLowerCase().includes(q)) : segments;
  const activeId = segments.find((s) => playhead >= s.start && playhead < s.end)?.id ?? null;

  const actionLabel =
    status === "completed" ? "Re-transcribe" : status === "failed" ? "Retry transcription" : "Transcribe video";

  const stageText = (() => {
    if (starting && !transcript) return "Submitting the job to the backend…";
    if (status === "queued") return "Waiting in queue — the backend transcribes one video at a time.";
    if (transcript?.stage === "extracting_audio") return "Extracting the audio track with FFmpeg…";
    if (transcript?.stage === "loading_model")
      return `Loading the Whisper "${transcript.model ?? model}" model… (the first run downloads it)`;
    if (transcript?.stage === "transcribing") return "Transcribing speech with faster-whisper…";
    return "Working…";
  })();

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(segments.map((s) => s.text).join("\n"));
      toast("Transcript copied to clipboard");
    } catch {
      toast("Copy is not available in this browser", "info");
    }
  };

  const canStart = serverMode && engineReady && !busy;

  return (
    <Card className="space-y-5 p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconTile icon={Mic} tone="accent" />
          <div>
            <h3 className="text-[15px] font-bold tracking-tight text-fg">Transcript</h3>
            <p className="mt-0.5 text-[12.5px] text-fg-3">Timestamped speech recognition · faster-whisper, on your backend</p>
          </div>
        </div>
        <TranscriptChip status={status} />
      </div>

      {/* Connection / engine states */}
      {!serverMode && (
        <Banner
          tone="info"
          title="Transcription needs the CLIPFORGE backend"
          action={
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => window.location.reload()}>
              Check again
            </Button>
          }
        >
          This preview is running in browser-only mode. Start the backend (<code className="font-mono text-fg">uvicorn main:app</code>{" "}
          in <code className="font-mono text-fg">backend/</code>), then check again. See backend/README.md.
        </Banner>
      )}
      {serverMode && engineError && (
        <Banner
          tone="error"
          title="Could not reach the transcription engine"
          action={
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => window.location.reload()}>
              Retry
            </Button>
          }
        >
          {engineError}
        </Banner>
      )}
      {serverMode && engine && !engine.available && (
        <Banner tone="error" title="Transcription engine is not ready">
          Missing: {engine.missing.join("; ")}. Install the missing dependency on the server and reload.
        </Banner>
      )}

      {/* Controls */}
      {serverMode && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold text-fg-3">Model</span>
            <select
              value={model}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
              className={cn(inputCls, "h-9 appearance-none")}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold text-fg-3">Language</span>
            <select
              value={language}
              disabled={busy}
              onChange={(e) => setLanguage(e.target.value)}
              className={cn(inputCls, "h-9 appearance-none")}
            >
              <option value="auto">Auto-detect</option>
              {LANGUAGE_CODES.map((c) => (
                <option key={c} value={c}>
                  {languageName(c)}
                </option>
              ))}
            </select>
          </label>
          <Button
            icon={busy ? Loader2 : Mic}
            disabled={!canStart}
            onClick={() => void start({ model, language: language === "auto" ? null : language })}
            className={cn(busy && "[&>svg]:animate-spin")}
          >
            {busy ? "Transcribing…" : actionLabel}
          </Button>
        </div>
      )}

      {/* Requests that failed (network / server errors) */}
      {requestError && (
        <Banner
          tone="error"
          title="Transcription request failed"
          action={
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void reload()}>
              Retry
            </Button>
          }
        >
          {requestError}
        </Banner>
      )}

      {/* In-progress */}
      {busy && (
        <div className="rounded-xl border border-line bg-panel-2 p-4">
          <div className="flex items-center gap-2.5">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            <p className="text-[13px] font-semibold text-fg">{stageText}</p>
          </div>
          {transcript?.stage === "transcribing" ? (
            <>
              <Progress value={transcript.progress} className="mt-3" />
              <p className="mt-2 font-mono text-[11px] text-fg-3">
                {Math.round(transcript.progress)}% of the audio processed
              </p>
            </>
          ) : (
            <Progress indeterminate className="mt-3" />
          )}
          {transcript?.startedAt && (
            <p className="mt-2 text-[11px] text-fg-3">Started {timeAgo(transcript.startedAt)}</p>
          )}
        </div>
      )}

      {/* Failed */}
      {status === "failed" && !busy && transcript?.error && (
        <Banner
          tone="error"
          title="Transcription failed"
          action={
            canStart ? (
              <Button size="sm" icon={RefreshCw} onClick={() => void start({ model, language: language === "auto" ? null : language })}>
                Retry
              </Button>
            ) : undefined
          }
        >
          {transcript.error}
        </Banner>
      )}

      {/* Not started yet */}
      {serverMode && status === "none" && loaded && !busy && (
        <EmptyState
          icon={Mic}
          title="No transcript yet"
          sub="Transcribe the video to get timestamped speech. Click any timestamp later to jump to that moment in the player."
        />
      )}

      {/* Completed */}
      {status === "completed" && transcript && !busy && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-line bg-panel-2 px-4 py-3">
            <Meta label="Detected language">
              {transcript.language ? `${languageName(transcript.language)} (${transcript.language})` : "Unknown"}
            </Meta>
            {transcript.languageProbability != null && (
              <Meta label="Confidence">
                {transcript.languageProbability >= 0.999
                  ? "Set manually"
                  : `${Math.round(transcript.languageProbability * 100)}%`}
              </Meta>
            )}
            <Meta label="Model">{transcript.model ?? "—"}</Meta>
            <Meta label="Segments">{transcript.segmentCount}</Meta>
            <Meta label="Audio length">
              {transcript.durationSeconds != null ? formatTimecode(transcript.durationSeconds) : "—"}
            </Meta>
          </div>

          {segments.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="No speech detected"
              sub="The audio track was processed, but no recognisable speech was found (it may be silence, music or sound effects only)."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[180px] flex-1">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search transcript…"
                    className={cn(inputCls, "h-9 pl-9")}
                  />
                </div>
                <Button variant="secondary" size="sm" icon={Copy} onClick={() => void copyTranscript()}>
                  Copy text
                </Button>
              </div>

              {visible.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-fg-3">No segments match “{query}”.</p>
              ) : (
                <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
                  {visible.map((s) => {
                    const active = s.id === activeId;
                    return (
                      <div
                        key={s.id}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                          active ? "border-accent/40 bg-accent/[0.06]" : "border-transparent hover:bg-panel-2"
                        )}
                      >
                        <button
                          type="button"
                          disabled={!canPreview}
                          onClick={() => onSeek(s.start)}
                          title={
                            canPreview
                              ? `Jump to ${formatTimecode(s.start)} (segment ends ${formatTimecode(s.end)})`
                              : "Video preview is unavailable for this file"
                          }
                          className={cn(
                            "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold transition-colors",
                            active
                              ? "bg-accent text-accent-ink"
                              : canPreview
                                ? "bg-panel-2 text-fg-2 hover:bg-accent/15 hover:text-accent"
                                : "cursor-default text-fg-3"
                          )}
                        >
                          {formatTimecode(s.start)}
                        </button>
                        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg">{s.text}</p>
                      </div>
                    );
                  })}
                </div>
              )}
              {canPreview && (
                <p className="text-[11px] text-fg-3">Click a timestamp to seek the player to that moment.</p>
              )}
            </>
          )}
        </div>
      )}

      {serverMode && engineReady && status === "none" && !busy && (
        <p className="text-[11px] text-fg-3">
          Runs locally on the backend with {engine?.config.computeType ?? "int8"} quantization on{" "}
          {engine?.config.device ?? "cpu"}. The first run downloads the selected model once.
        </p>
      )}
    </Card>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-fg-3">{label}</div>
      <div className="mt-0.5 text-[12.5px] font-semibold text-fg-2">{children}</div>
    </div>
  );
}
