import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Captions, FileVideo, Info, Loader2, Save, Upload } from "lucide-react";
import { cn } from "@/utils/cn";
import { useStore } from "@/lib/store";
import type { CaptionPrefs } from "@/lib/types";
import { Button, Card, EmptyState, Field, IconTile, SectionHeader, Segmented, StatusBadge, Switch } from "@/components/ui";

const DEFAULT_PREFS: CaptionPrefs = { style: "bold", color: "#f4f4f5", animation: "pop", burnIn: true };
const COLORS = ["#f4f4f5", "#c8f542", "#fde047", "#17171b"];

export default function CaptionStudio() {
  const { projects, loading, videoUrl, saveCaptionPrefs, toast } = useStore();
  const navigate = useNavigate();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0];

  const [prefs, setPrefs] = useState<CaptionPrefs>(DEFAULT_PREFS);
  const [src, setSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load per-project saved preferences whenever the selection changes.
  useEffect(() => {
    if (selected) setPrefs(selected.captionPrefs ?? DEFAULT_PREFS);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (!selected) return;
    videoUrl(selected.id)
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [selected?.id, videoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selected) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-fg">Caption studio</h1>
          <p className="mt-1 text-[14px] text-fg-2">Caption style presets for your future clips.</p>
        </div>
        <EmptyState
          icon={Captions}
          title={loading ? "Loading projects…" : "No projects yet"}
          sub="Upload a video first — then you can save caption style presets that will be applied automatically once captions are generated."
          action={
            !loading ? (
              <Button size="sm" icon={Upload} onClick={() => navigate("/create")}>
                Upload a video
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      await saveCaptionPrefs(selected.id, prefs);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save preferences", "info");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[24px] font-bold tracking-tight text-fg">Caption studio</h1>
        <p className="mt-1 text-[14px] text-fg-2">
          Style presets saved per project — applied automatically when captions are generated.
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-line-2 bg-panel-2 p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p className="text-[13px] leading-relaxed text-fg-2">
          <span className="font-semibold text-fg">Transcripts are live.</span> Open a project in the Clip Editor to
          transcribe it. Caption rendering comes in a later phase — the style you save here is stored on the project
          and will be used once captions are generated.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* Project picker */}
        <section>
          <SectionHeader title="Your projects" sub="Choose a project to preview and style" />
          <Card className="p-3">
            <div className="space-y-1">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition-colors",
                    selected.id === p.id ? "border-accent/50 bg-accent/[0.05]" : "border-transparent hover:bg-panel-2"
                  )}
                >
                  {p.thumbnail ? (
                    <img
                      src={p.thumbnail}
                      alt=""
                      className="h-11 w-[72px] shrink-0 rounded-lg border border-line object-cover"
                    />
                  ) : (
                    <span className="pattern-dots flex h-11 w-[72px] shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2">
                      <FileVideo className="h-4 w-4 text-fg-3/70" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-fg">{p.name}</span>
                    <span className="mt-0.5 block font-mono text-[11px] text-fg-3">
                      {p.duration} · {p.size}
                    </span>
                  </span>
                  {p.captionPrefs && (
                    <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-accent">
                      Style saved
                    </span>
                  )}
                  <StatusBadge status={p.status} />
                </button>
              ))}
            </div>
          </Card>
        </section>

        {/* Preview + style controls */}
        <section>
          <SectionHeader title="Source preview" sub={selected.name} />
          <Card className="p-5">
            {selected.previewAvailable && src ? (
              <video
                key={src}
                src={src}
                controls
                preload="metadata"
                poster={selected.thumbnail ?? undefined}
                className="aspect-video w-full rounded-xl border border-line bg-black"
              />
            ) : selected.previewAvailable ? (
              <div className="flex aspect-video items-center justify-center rounded-xl border border-line bg-black">
                <Loader2 className="h-6 w-6 animate-spin text-fg-3" />
              </div>
            ) : (
              <div className="pattern-dots flex aspect-video flex-col items-center justify-center rounded-xl border border-line bg-panel-2 px-6 text-center">
                <FileVideo className="h-7 w-7 text-fg-3" />
                <p className="mt-2 text-[12.5px] text-fg-3">Preview unavailable for this file in the browser.</p>
              </div>
            )}

            <div className="mt-6 space-y-4 border-t border-line pt-5">
              <Field label="Caption style">
                <Segmented
                  options={[
                    { value: "classic", label: "Classic" },
                    { value: "bold", label: "Bold" },
                    { value: "minimal", label: "Minimal" },
                  ]}
                  value={prefs.style}
                  onChange={(style) => setPrefs((p) => ({ ...p, style }))}
                />
              </Field>

              <Field label="Text color">
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      aria-label={`Color ${c}`}
                      onClick={() => setPrefs((p) => ({ ...p, color: c }))}
                      className={cn(
                        "h-7 w-7 rounded-full border border-line-2 transition-transform hover:scale-110",
                        prefs.color === c && "ring-2 ring-accent ring-offset-2 ring-offset-panel"
                      )}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </Field>

              <Field label="Animation">
                <Segmented
                  options={[
                    { value: "pop", label: "Pop" },
                    { value: "fade", label: "Fade" },
                    { value: "type", label: "Typewriter" },
                  ]}
                  value={prefs.animation}
                  onChange={(animation) => setPrefs((p) => ({ ...p, animation }))}
                />
              </Field>

              <div className="flex items-center justify-between rounded-xl border border-line bg-panel-2 px-3.5 py-3">
                <div className="flex items-center gap-2.5">
                  <IconTile icon={Captions} className="h-8 w-8 rounded-lg" />
                  <div>
                    <p className="text-[13px] font-semibold text-fg">Burn-in captions</p>
                    <p className="text-[11px] text-fg-3">Render captions into the exported video</p>
                  </div>
                </div>
                <Switch
                  checked={prefs.burnIn}
                  onChange={(burnIn) => setPrefs((p) => ({ ...p, burnIn }))}
                  label="Burn-in captions"
                />
              </div>

              <Button icon={Save} className="w-full" disabled={saving} onClick={save}>
                Save style for this project
              </Button>
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
}
