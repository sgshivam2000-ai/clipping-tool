import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/utils/cn";
import type { ProjectStatus } from "@/lib/types";

/** Shared class for all text inputs / selects. */
export const inputCls =
  "h-9.5 w-full rounded-xl border border-line-2 bg-panel-2 px-3 text-[13px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/15";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  iconRight?: LucideIcon;
}

export function Button({
  variant = "primary",
  size = "md",
  icon: Icon,
  iconRight: IconRight,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" && "h-8 px-3 text-[12px]",
        size === "md" && "h-9.5 px-4 text-[13px]",
        size === "lg" && "h-11 px-5 text-[14px]",
        variant === "primary" && "bg-accent text-accent-ink hover:bg-accent-hi",
        variant === "secondary" && "border border-line-2 bg-panel-2 text-fg hover:border-fg-3/50 hover:bg-raised",
        variant === "ghost" && "text-fg-2 hover:bg-panel-2 hover:text-fg",
        variant === "danger" && "border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20",
        className
      )}
      {...props}
    >
      {Icon && <Icon className={cn("h-4 w-4", size === "sm" && "h-3.5 w-3.5")} />}
      {children}
      {IconRight && <IconRight className="h-4 w-4" />}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  ...props
}: { icon: LucideIcon; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-raised hover:text-fg",
        className
      )}
      {...props}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-2xl border border-line bg-panel", className)} {...props} />;
}

export function Chip({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-line-2 bg-panel-2 px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wide text-fg-2",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

const STATUS_STYLE: Record<string, string> = {
  Ready: "border-accent/25 bg-accent/10 text-accent",
  Uploading: "border-accent/25 bg-accent/10 text-accent",
  Failed: "border-red-500/25 bg-red-500/10 text-red-400",
};
const STATUS_DOT: Record<string, boolean> = { Ready: true, Uploading: true };

export function StatusBadge({ status, pulse = false }: { status: ProjectStatus; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-bold",
        STATUS_STYLE[status] ?? STATUS_STYLE.Ready
      )}
    >
      {STATUS_DOT[status] && <span className={cn("h-1.5 w-1.5 rounded-full bg-current", pulse && "animate-pulse")} />}
      {status}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="animate-pop relative w-full max-w-md rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl shadow-black/60">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-bold tracking-tight text-fg">{title}</h3>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

export function Progress({
  value,
  indeterminate = false,
  className,
}: {
  value?: number;
  indeterminate?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-raised", className)}>
      {indeterminate ? (
        <div className="relative h-full w-full">
          <div className="animate-shimmer absolute inset-y-0 w-1/3 rounded-full bg-accent" />
        </div>
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      )}
    </div>
  );
}

export function IconTile({
  icon: Icon,
  tone = "neutral",
  className,
}: {
  icon: LucideIcon;
  tone?: "neutral" | "accent" | "danger";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border [&>svg]:h-[18px] [&>svg]:w-[18px]",
        tone === "accent" && "border-accent/25 bg-accent/10 text-accent",
        tone === "danger" && "border-red-500/25 bg-red-500/10 text-red-400",
        tone === "neutral" && "border-line-2 bg-panel-2 text-fg-2",
        className
      )}
    >
      <Icon />
    </div>
  );
}

export function Avatar({ name, size = 36, className }: { name: string; size?: number; className?: string }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div
      style={{ width: size, height: size }}
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full border border-line-2 bg-raised font-bold text-fg-2",
        className
      )}
    >
      <span style={{ fontSize: size * 0.32 }}>{initials}</span>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
        checked ? "bg-accent" : "border border-line-2 bg-raised"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full transition-all duration-200",
          checked ? "left-[22px] bg-accent-ink" : "left-0.5 bg-fg-3"
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex flex-wrap gap-1 rounded-xl border border-line-2 bg-panel-2 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors",
            value === o.value ? "bg-accent text-accent-ink" : "text-fg-2 hover:text-fg"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-fg-3">{hint}</span>}
    </label>
  );
}

export function SectionHeader({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-bold tracking-tight text-fg">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-fg-3">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  sub,
  action,
}: {
  icon: LucideIcon;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line-2 px-6 py-14 text-center">
      <IconTile icon={Icon} className="h-11 w-11 rounded-2xl" />
      <p className="mt-4 text-[14px] font-semibold text-fg">{title}</p>
      {sub && <p className="mt-1 max-w-sm text-[12.5px] text-fg-3">{sub}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
