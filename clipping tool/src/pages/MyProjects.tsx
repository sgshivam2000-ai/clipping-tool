import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Film, Plus, Search, SearchX } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { Project, ProjectStatus } from "@/lib/types";
import { Button, EmptyState, inputCls } from "@/components/ui";
import { ProjectCard } from "@/components/dashboard";

const FILTERS: ("All" | ProjectStatus)[] = ["All", "Ready", "Uploading", "Failed"];
type Sort = "newest" | "oldest" | "name" | "size";
const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "size", label: "Largest first" },
];

export default function MyProjects() {
  const { projects, loading } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [localQ, setLocalQ] = useState(q);
  const [status, setStatus] = useState<"All" | ProjectStatus>("All");
  const [sort, setSort] = useState<Sort>("newest");

  useEffect(() => setLocalQ(q), [q]);

  const filtered = useMemo(() => {
    const list = projects.filter(
      (p) => (status === "All" || p.status === status) && p.name.toLowerCase().includes(q.trim().toLowerCase())
    );
    const byDate = (a: Project, b: Project) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return [...list].sort((a, b) => {
      switch (sort) {
        case "oldest":
          return -byDate(a, b);
        case "name":
          return a.name.localeCompare(b.name);
        case "size":
          return b.sizeBytes - a.sizeBytes;
        default:
          return byDate(a, b);
      }
    });
  }, [projects, status, sort, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: projects.length };
    for (const p of projects) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [projects]);

  const totalBytes = projects.reduce((s, p) => s + p.sizeBytes, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-fg">My projects</h1>
          <p className="mt-1 text-[14px] text-fg-2">
            {loading
              ? "Loading your projects…"
              : `${projects.length} project${projects.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)} stored`}
          </p>
        </div>
        <Button icon={Plus} onClick={() => navigate("/create")}>
          New project
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
          <input
            value={localQ}
            onChange={(e) => {
              setLocalQ(e.target.value);
              setParams(e.target.value ? { q: e.target.value } : {}, { replace: true });
            }}
            placeholder="Filter by project name…"
            className={cn(inputCls, "h-9.5 pl-9")}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                status === f
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-line-2 bg-panel-2 text-fg-2 hover:border-fg-3/50 hover:text-fg"
              )}
            >
              {f}
              <span className={cn("ml-1.5 font-mono text-[10px]", status === f ? "text-accent/70" : "text-fg-3")}>
                {counts[f] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className={cn(inputCls, "h-9.5 w-full appearance-none lg:ml-auto lg:w-44")}
          aria-label="Sort projects"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Grid */}
      {!loading && projects.length === 0 ? (
        <EmptyState
          icon={Film}
          title="No projects yet"
          sub="Upload your first video to create a project. Files are stored safely with their metadata, ready for transcription and AI clipping."
          action={
            <Button size="sm" icon={Plus} onClick={() => navigate("/create")}>
              Create your first project
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No projects found"
          sub="Try a different search term or status filter."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setLocalQ("");
                setParams({}, { replace: true });
                setStatus("All");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
