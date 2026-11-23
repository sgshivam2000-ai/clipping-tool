import { useNavigate } from "react-router-dom";
import { Download, FileVideo, History, Lock, Upload } from "lucide-react";
import { useStore } from "@/lib/store";
import { Button, Card, EmptyState, SectionHeader, StatusBadge } from "@/components/ui";

export default function ExportHistory() {
  const { projects, loading } = useStore();
  const navigate = useNavigate();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[24px] font-bold tracking-tight text-fg">Export history</h1>
        <p className="mt-1 text-[14px] text-fg-2">Rendered clips for YouTube Shorts, Instagram Reels and TikTok.</p>
      </div>

      <EmptyState
        icon={History}
        title="No exports yet"
        sub="Exports are rendered from AI-generated clips. Clip detection and rendering come in later phases — uploaded projects below are ready and waiting."
        action={
          <Button size="sm" icon={Upload} onClick={() => navigate("/create")}>
            Upload a video
          </Button>
        }
      />

      {projects.length > 0 && (
        <section>
          <SectionHeader title="Projects awaiting clips" sub="These uploads will produce exports automatically later" />
          <Card className="p-3">
            <div className="space-y-1">
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-panel-2">
                  {p.thumbnail ? (
                    <img src={p.thumbnail} alt="" className="h-9 w-14 shrink-0 rounded-md border border-line object-cover" />
                  ) : (
                    <span className="pattern-dots flex h-9 w-14 shrink-0 items-center justify-center rounded-md border border-line bg-panel-2">
                      <FileVideo className="h-3.5 w-3.5 text-fg-3/70" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-fg">{p.name}</span>
                    <span className="block font-mono text-[11px] text-fg-3">
                      {p.duration} · {p.size}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1 rounded bg-panel-2 px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-fg-3">
                    <Lock className="h-3 w-3" /> Next phase
                  </span>
                  <StatusBadge status={p.status} />
                </div>
              ))}
            </div>
          </Card>
        </section>
      )}

      {!loading && projects.length === 0 && (
        <p className="flex items-center gap-2 text-[12.5px] text-fg-3">
          <Download className="h-4 w-4" /> Tip: every exported clip will be downloadable here with its format, resolution
          and file size.
        </p>
      )}
    </div>
  );
}
