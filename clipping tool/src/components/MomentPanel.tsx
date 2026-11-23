import { useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Loader2, Play, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTimecode } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { MomentApi } from "@/lib/useMoments";
import type { MomentCandidate, MomentOptions, Project } from "@/lib/types";
import { Button, Card, IconTile, inputCls } from "./ui";

export function MomentPanel({ project, canPreview, onPreview, moments }: {
  project: Project;
  canPreview: boolean;
  onPreview: (candidate: MomentCandidate) => void;
  moments: MomentApi;
}) {
  const { mode } = useStore();
  const { result, engine, error, loading, starting, start, reload } = moments;
  const [options, setOptions] = useState<MomentOptions>({ minDuration: 15, maxDuration: 90, maxCandidates: 6 });
  const [category, setCategory] = useState("All");
  const [activeId, setActiveId] = useState<string | null>(null);
  const busy = starting || result?.status === "queued" || result?.status === "processing";
  const ready = mode === "server" && engine?.configured && project.transcriptStatus === "completed";
  const validOptions = options.minDuration >= 5 && options.minDuration < options.maxDuration && options.maxDuration <= 180
    && options.maxCandidates >= 1 && options.maxCandidates <= 20 && Object.values(options).every(Number.isInteger);
  const candidates = result?.candidates ?? [];
  const visible = category === "All" ? candidates : candidates.filter((c) => c.category === category);
  const message = !result || result.status === "none" ? "Not analyzed" : {
    queued: "Queued", processing: "Analyzing", completed: `${result.candidateCount} candidates`, failed: "Analysis failed",
  }[result.status];

  return (
    <Card id="ai-moments" className="scroll-mt-20 space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconTile icon={Sparkles} tone="accent" />
          <div>
            <h2 className="text-[15px] font-bold tracking-tight text-fg">AI moments</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-3">The strongest passages, selected with context.</p>
          </div>
        </div>
        <span className={cn("flex items-center gap-1.5 text-[11px] font-semibold", result?.status === "failed" ? "text-red-400" : "text-fg-2")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : result?.status === "completed" ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
          {message}
        </span>
      </div>

      {mode !== "server" ? (
        <Notice title="Connect the backend to analyze moments">
          Moment detection needs a completed server transcript and a configured LLM. Your local videos are unchanged.
          Start the backend, reload, and upload your video to server storage.
        </Notice>
      ) : engine && !engine.configured ? (
        <Notice title="Configure an LLM provider">
          {engine.error}
          <p className="mt-2 font-mono text-[10.5px] text-fg-3">backend/.env.example has OpenAI-compatible and Ollama configuration.</p>
          <Button variant="ghost" size="sm" icon={RefreshCw} className="mt-2 px-0" onClick={() => void reload()}>Check configuration</Button>
        </Notice>
      ) : engine?.configured ? (
        <p className="text-[11.5px] text-fg-3">
          <span className="font-medium text-fg-2">{engine.provider} / {engine.model}</span>
          {" "}is configured. Provider access is checked when analysis runs.
        </p>
      ) : loading ? <p role="status" className="text-[12px] text-fg-3">Checking analysis configuration...</p> : null}

      {mode === "server" && project.transcriptStatus !== "completed" && (
        <p className="text-[12.5px] text-fg-2">Complete transcription below first. AI moments uses that saved transcript, not the video file.</p>
      )}

      {mode === "server" && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {([
              ["minDuration", "Minimum length (seconds)", 5, 179],
              ["maxDuration", "Maximum length (seconds)", 6, 180],
              ["maxCandidates", "Up to this many candidates", 1, 20],
            ] as const).map(([key, label, min, max]) => (
              <label key={key} className="block">
                <span className="mb-1.5 block text-[11px] font-semibold text-fg-3">{label}</span>
                <input aria-label={label} type="number" min={min} max={max} step={1} value={Number.isNaN(options[key]) ? "" : options[key]} disabled={busy}
                  onChange={(e) => setOptions((previous) => ({ ...previous, [key]: e.target.valueAsNumber }))} className={inputCls} />
              </label>
            ))}
          </div>
          {!validOptions && <p role="alert" className="text-[12px] text-red-400">Use whole numbers: 5-180 seconds, minimum below maximum, and 1-20 candidates.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={busy ? Loader2 : Sparkles} className={busy ? "[&>svg]:animate-spin" : ""} disabled={!ready || busy || !validOptions || loading}
              onClick={() => { setCategory("All"); setActiveId(null); void start(options); }}>
              {busy ? "Analyzing moments..." : result?.status === "failed" ? "Retry analysis" : result?.status === "completed" ? "Re-analyze moments" : "Find best moments"}
            </Button>
            <span className="text-[11.5px] text-fg-3">Selects candidates only. No video is cut or rendered.</span>
          </div>
          {engine?.configured && <p className="text-[11px] leading-relaxed text-fg-3">The transcript is sent to your configured provider. Re-analysis replaces earlier candidates and may incur provider charges.</p>}
        </>
      )}

      {busy && (
        <div role="status" aria-live="polite" className="flex items-start gap-3 border-y border-line py-4">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent" />
          <div>
            <p className="text-[13px] font-semibold text-fg">{result?.status === "queued" ? "Waiting in the analysis queue" : result?.stage === "ranking_candidates" ? "Ranking and removing overlapping selections" : "Reading the transcript in context"}</p>
            <p className="mt-1 text-[12px] text-fg-3">{result?.totalWindows ? `${result.completedWindows} of ${result.totalWindows} context windows analyzed.` : "Preparing contextual analysis."} No estimated or simulated progress.</p>
          </div>
        </div>
      )}
      {error && <Notice title="Could not reach moment analysis" danger>{error}<Button variant="ghost" size="sm" icon={RefreshCw} className="mt-2 block px-0" onClick={() => void reload()}>Refresh status</Button></Notice>}
      {result?.status === "failed" && <Notice title="Moment analysis failed" danger>{result.error} Your source video and transcript are unchanged. Correct the issue, then retry.</Notice>}
      {result?.warnings.map((warning) => <p key={warning} className="text-[12px] text-amber-300">{warning}</p>)}

      {result?.status === "completed" && (
        <div className="space-y-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold text-fg">Ranked clip candidates</h3>
              <p className="mt-0.5 text-[11px] text-fg-3">{result.provider} / {result.model} &middot; Editorial scores, not virality predictions.</p>
            </div>
            {candidates.length > 0 && <select aria-label="Filter moment category" value={category} onChange={(e) => setCategory(e.target.value)} className={cn(inputCls, "w-auto min-w-36")}>
              <option value="All">All categories</option>
              {[...new Set(candidates.map((c) => c.category))].map((c) => <option key={c}>{c}</option>)}
            </select>}
          </div>
          {candidates.length === 0 ? (
            <p className="py-5 text-center text-[13px] leading-relaxed text-fg-2">No sufficiently strong, self-contained moments met the requested duration. Try a different length range or a longer transcript. No results were fabricated.</p>
          ) : <div className="divide-y divide-line">{visible.map((candidate) => (
            <CandidateRow key={candidate.id} candidate={candidate} active={candidate.id === activeId} canPreview={canPreview}
              onPreview={() => { setActiveId(candidate.id); onPreview(candidate); }} />
          ))}</div>}
        </div>
      )}
    </Card>
  );
}

function Notice({ title, danger = false, children }: { title: string; danger?: boolean; children: React.ReactNode }) {
  return <div role={danger ? "alert" : undefined} className={cn("flex gap-3 rounded-xl border p-4", danger ? "border-red-500/25 bg-red-500/[0.04]" : "border-line-2 bg-panel-2")}>
    <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", danger ? "text-red-400" : "text-accent")} />
    <div className="min-w-0"><p className="text-[13px] font-semibold text-fg">{title}</p><div className="mt-1 text-[12px] leading-relaxed text-fg-2">{children}</div></div>
  </div>;
}

function CandidateRow({ candidate: c, active, canPreview, onPreview }: {
  candidate: MomentCandidate; active: boolean; canPreview: boolean; onPreview: () => void;
}) {
  return <article className={cn("py-5 transition-colors", active && "bg-accent/[0.025]")} aria-label={`Candidate ${c.rank}: ${c.title}`}>
    <div className="flex items-start gap-3">
      <span className="mt-0.5 font-mono text-[12px] text-fg-3">{String(c.rank).padStart(2, "0")}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3"><h4 className="text-[14px] font-semibold text-fg">{c.title}</h4><div className="shrink-0 text-right"><span className="font-mono text-[19px] font-semibold text-accent">{c.engagementScore}</span><span className="text-[10px] text-fg-3"> /100</span><p className="text-[9px] uppercase tracking-wide text-fg-3">Engagement</p></div></div>
        <p className="mt-1 text-[11px] text-fg-3">{c.category} &middot; {(c.confidence * 100).toFixed(0)}% model confidence &middot; {c.duration.toFixed(1)}s</p>
        <blockquote className="mt-3 border-l-2 border-accent/50 pl-3 text-[13px] font-medium leading-relaxed text-fg">{c.hook}</blockquote>
        <p className="mt-3 text-[12px] leading-relaxed text-fg-2">{c.reason}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="font-mono text-[11px] text-fg-2">{formatTimecode(c.start)} &rarr; {formatTimecode(c.end)}</span>
          <Button variant="secondary" size="sm" icon={Play} disabled={!canPreview} onClick={onPreview} aria-label={`Preview candidate ${c.rank}`} iconRight={ArrowUpRight}>Preview passage</Button>
        </div>
        <details className="group mt-3"><summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11.5px] font-medium text-fg-3 hover:text-fg-2"><ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />Source transcript &middot; {c.segmentIds.length} segments</summary><p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-2">{c.transcriptExcerpt}</p></details>
      </div>
    </div>
  </article>;
}