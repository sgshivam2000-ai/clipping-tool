import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Film, FolderKanban, HardDrive, Plus, Scissors, Upload } from "lucide-react";
import { Button, EmptyState, SectionHeader } from "@/components/ui";
import { ProjectCard, QuickActions, StatCard, UploadActivity } from "@/components/dashboard";
import { formatBytes, greeting, todayLong } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Project } from "@/lib/types";

/** Upload counts per day for the last 10 days — a real sparkline from project dates. */
function last10DaysSpark(projects: Project[]): number[] {
  return Array.from({ length: 10 }, (_, i) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (9 - i));
    const from = start.getTime();
    return projects.filter((p) => {
      const t = new Date(p.createdAt).getTime();
      return t >= from && t < from + 864e5;
    }).length;
  });
}

export default function Dashboard() {
  const { projects, loading, mode } = useStore();
  const navigate = useNavigate();

  const spark = useMemo(() => last10DaysSpark(projects), [projects]);
  const totalBytes = projects.reduce((s, p) => s + p.sizeBytes, 0);
  const ready = projects.filter((p) => p.status === "Ready").length;
  const thisWeek = projects.filter((p) => Date.now() - new Date(p.createdAt).getTime() < 7 * 864e5).length;

  const stats = [
    {
      label: "Videos uploaded",
      value: String(projects.length),
      delta: thisWeek > 0 ? `+${thisWeek} this week` : "Start uploading",
      icon: Film,
      spark,
      accent: true,
    },
    {
      label: "Projects ready",
      value: String(ready),
      delta: mode === "server" ? "FastAPI server storage" : "Browser local storage",
      icon: FolderKanban,
      spark,
    },
    {
      label: "Storage used",
      value: formatBytes(totalBytes),
      delta: projects.length ? `${projects.length} video files` : "Nothing stored yet",
      icon: HardDrive,
      spark,
    },
    {
      label: "Clips generated",
      value: String(projects.reduce((sum, p) => sum + p.clipsCompleted, 0)),
      delta: projects.some((p) => p.clipsCompleted < p.clipsTotal) ? "Processing…" : "Rendered MP4 clips",
      icon: Scissors,
      spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
  ];

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[12.5px] font-medium text-fg-3">{todayLong()} · Studio overview</p>
          <h1 className="mt-1 text-[26px] font-bold tracking-tight text-fg md:text-[28px]">{greeting()}, Mike</h1>
          <p className="mt-1 text-[14px] text-fg-2">
            Turn long videos into viral-ready clips — upload a video to get started.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" icon={Upload} onClick={() => navigate("/create")}>
            Upload video
          </Button>
          <Button icon={Plus} onClick={() => navigate("/create")}>
            New project
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <SectionHeader
            title="Recent projects"
            sub={
              loading
                ? "Loading your projects…"
                : projects.length
                  ? "Your latest uploads — click a project to open it"
                  : "Projects you create will appear here"
            }
            action={
              <Button variant="ghost" size="sm" iconRight={ChevronRight} onClick={() => navigate("/projects")}>
                View all
              </Button>
            }
          />
          {projects.length === 0 && !loading ? (
            <EmptyState
              icon={Film}
              title="No projects yet"
              sub="Upload a long video, transcribe it, then let your configured AI provider find the most engaging passages."
              action={
                <Button size="sm" icon={Upload} onClick={() => navigate("/create")}>
                  Upload your first video
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {projects.slice(0, 6).map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <UploadActivity />
          <QuickActions />
        </aside>
      </div>
    </div>
  );
}
