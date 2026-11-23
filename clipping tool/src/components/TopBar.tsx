import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Bell, Menu, Plus, Search } from "lucide-react";
import { cn } from "@/utils/cn";
import { timeAgo } from "@/lib/format";
import { useStore } from "@/lib/store";
import type { NotificationItem } from "@/lib/types";
import { Button, IconButton, inputCls } from "./ui";

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [local, setLocal] = useState(q);
  const [bellOpen, setBellOpen] = useState(false);
  const navigate = useNavigate();
  const { projects } = useStore();

  useEffect(() => setLocal(q), [q]);

  // Notifications are derived from real project activity (uploads).
  const notes: NotificationItem[] = projects.slice(0, 3).map((p) => ({
    id: p.id,
    title: p.status === "Failed" ? `Upload failed — ${p.name}` : `Video uploaded — ${p.name}`,
    desc: `${p.duration} · ${p.size} · stored and ready for transcription`,
    time: timeAgo(p.createdAt),
    unread: Date.now() - new Date(p.createdAt).getTime() < 24 * 36e5,
  }));
  const unread = notes.filter((n) => n.unread).length;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-base/85 px-4 backdrop-blur md:px-8">
      <IconButton icon={Menu} label="Open navigation" className="md:hidden" onClick={onMenu} />

      <div className="relative hidden w-full max-w-sm sm:block">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3" />
        <input
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            setParams(e.target.value ? { q: e.target.value } : {}, { replace: true });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && local.trim()) navigate(`/projects?q=${encodeURIComponent(local.trim())}`);
          }}
          placeholder="Search projects, clips…"
          className={cn(inputCls, "h-9 pl-9")}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button icon={Plus} size="sm" className="hidden sm:inline-flex" onClick={() => navigate("/create")}>
          New project
        </Button>

        <div className="relative">
          {bellOpen && <div className="fixed inset-0 z-40" onClick={() => setBellOpen(false)} />}
          <IconButton
            icon={Bell}
            label="Notifications"
            onClick={() => setBellOpen((o) => !o)}
            className={cn(bellOpen && "bg-raised text-fg")}
          />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[9px] font-bold text-accent-ink">
              {unread}
            </span>
          )}
          {bellOpen && (
            <div className="absolute right-0 z-50 mt-2 w-[320px] overflow-hidden rounded-2xl border border-line-2 bg-raised shadow-2xl shadow-black/50">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <span className="text-[13px] font-bold text-fg">Notifications</span>
                <span className="text-[11px] font-semibold text-accent">{unread} new</span>
              </div>
              <div className="max-h-80 overflow-y-auto p-1.5">
                {notes.length === 0 && (
                  <p className="px-3 py-4 text-center text-[12.5px] text-fg-3">
                    You&apos;re all caught up — uploads will appear here.
                  </p>
                )}
                {notes.map((n) => (
                  <div key={n.id} className="flex gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-panel-2">
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.unread ? "bg-accent" : "bg-line-2")} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-fg">{n.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-[12px] text-fg-3">{n.desc}</p>
                      <p className="mt-1 text-[10.5px] font-medium text-fg-3">{n.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
