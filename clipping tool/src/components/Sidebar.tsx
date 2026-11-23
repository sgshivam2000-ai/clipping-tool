import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  BadgeCheck,
  Captions,
  ChevronsUpDown,
  Clapperboard,
  CreditCard,
  FolderKanban,
  History,
  LayoutDashboard,
  LogOut,
  Scissors,
  Settings,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatBytes } from "@/lib/format";
import { useStore } from "@/lib/store";
import { Avatar, Button, Progress } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/create", label: "Create Clips", icon: Sparkles, badge: "New" },
      { to: "/projects", label: "My Projects", icon: FolderKanban },
    ],
  },
  {
    group: "Studio",
    items: [
      { to: "/editor", label: "Clip Editor", icon: Scissors },
      { to: "/captions", label: "Caption Studio", icon: Captions },
      { to: "/exports", label: "Export History", icon: History },
    ],
  },
  {
    group: "System",
    items: [{ to: "/settings", label: "Settings", icon: Settings }],
  },
];

export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { toast, projects, mode } = useStore();
  const navigate = useNavigate();

  const totalBytes = projects.reduce((s, p) => s + p.sizeBytes, 0);
  const storagePct = Math.min(100, (totalBytes / (2 * 1024 ** 3)) * 100);

  const go = (to: string) => {
    setMenuOpen(false);
    onNavigate?.();
    navigate(to);
  };

  return (
    <aside className={cn("flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-panel", className)}>
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 pb-5 pt-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent shadow-lg shadow-black/40">
          <Clapperboard className="h-5 w-5 text-accent-ink" strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[15px] font-extrabold tracking-tight text-fg">CLIPFORGE</span>
            <span className="rounded bg-accent/15 px-1 py-px text-[10px] font-bold text-accent">AI</span>
          </div>
          <p className="mt-0.5 truncate text-[10px] leading-tight text-fg-3">
            Turn long videos into viral-ready clips.
          </p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-3">{g.group}</p>
            <div className="space-y-0.5">
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors",
                      isActive ? "bg-accent/10 text-accent" : "text-fg-2 hover:bg-panel-2 hover:text-fg"
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={cn("h-[18px] w-[18px]", isActive ? "text-accent" : "text-fg-3 group-hover:text-fg-2")}
                      />
                      <span className="flex-1">{item.label}</span>
                      {item.badge && (
                        <span className="rounded-md bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Plan usage */}
      <div className="mx-3 mb-3 rounded-xl border border-line-2 bg-panel-2 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-3">Pro plan</span>
          <BadgeCheck className="h-4 w-4 text-accent" />
        </div>
        <div className="mt-2 flex items-end justify-between">
          <span className="font-mono text-[15px] font-semibold text-fg">
            {projects.length}
            <span className="text-fg-3"> videos</span>
          </span>
          <span className="text-[11px] text-fg-3">
            {formatBytes(totalBytes)} stored · {mode === "server" ? "server" : "local"}
          </span>
        </div>
        <Progress value={storagePct} className="mt-2" />
        <Button
          size="sm"
          variant="secondary"
          className="mt-3 w-full"
          onClick={() => toast("Billing & upgrades unlock in Phase 2", "info")}
        >
          Upgrade plan
        </Button>
      </div>

      {/* User profile */}
      <div className="relative border-t border-line p-3">
        {menuOpen && <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex w-full items-center gap-3 rounded-xl p-2 transition-colors hover:bg-panel-2"
        >
          <Avatar name="Mike Keller" size={34} />
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[13px] font-semibold text-fg">Mike Keller</span>
            <span className="block truncate text-[11px] text-fg-3">mike@clipforge.ai</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-fg-3" />
        </button>
        {menuOpen && (
          <div className="absolute bottom-full left-3 right-3 z-50 mb-2 overflow-hidden rounded-xl border border-line-2 bg-raised p-1 shadow-2xl shadow-black/50">
            <button
              onClick={() => go("/settings")}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <User className="h-4 w-4 text-fg-3" /> Profile &amp; workspace
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                toast("Billing is disabled in this Phase 1 demo", "info");
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
            >
              <CreditCard className="h-4 w-4 text-fg-3" /> Billing
            </button>
            <button
              onClick={() => {
                setMenuOpen(false);
                toast("Signed out — see you soon (demo)", "info");
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/10"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
