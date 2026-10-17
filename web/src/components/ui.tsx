import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { RunStatus, TaskStage, TaskStatus } from "@ad/shared";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-accent-strong text-white hover:bg-accent disabled:bg-ink-700 disabled:text-ink-400",
  secondary: "bg-ink-800 text-ink-100 border border-ink-700 hover:bg-ink-700 disabled:text-ink-400",
  ghost: "text-ink-300 hover:text-ink-100 hover:bg-ink-800 disabled:text-ink-600",
  danger: "bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20",
};

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    />
  );
}

const statusStyle: Record<TaskStatus | RunStatus, { label: string; dot: string; text: string }> = {
  idle: { label: "Idle", dot: "bg-ink-400", text: "text-ink-300" },
  queued: { label: "Queued", dot: "bg-sky-400", text: "text-sky-300" },
  running: { label: "Running", dot: "bg-accent animate-pulse", text: "text-accent" },
  waiting: { label: "Waiting on you", dot: "bg-gold", text: "text-gold" },
  done: { label: "Done", dot: "bg-emerald-400", text: "text-emerald-300" },
  succeeded: { label: "Done", dot: "bg-emerald-400", text: "text-emerald-300" },
  failed: { label: "Failed", dot: "bg-red-400", text: "text-red-300" },
  stopped: { label: "Stopped", dot: "bg-ink-400", text: "text-ink-300" },
  interrupted: { label: "Interrupted", dot: "bg-amber-400", text: "text-amber-300" },
};

export function StatusBadge({ status }: { status: TaskStatus | RunStatus }) {
  const s = statusStyle[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const stageStyle: Record<TaskStage, { label: string; className: string }> = {
  backlog: { label: "Backlog", className: "bg-ink-800 text-ink-300" },
  in_progress: { label: "In progress", className: "bg-sky-500/15 text-sky-300" },
  needs_review: { label: "Needs review", className: "bg-gold/15 text-gold" },
  in_review: { label: "In review", className: "bg-violet-500/15 text-violet-300" },
  changes_requested: { label: "Changes requested", className: "bg-amber-500/15 text-amber-300" },
  approved: { label: "Approved", className: "bg-emerald-500/15 text-emerald-300" },
  closed: { label: "Closed", className: "bg-ink-800 text-ink-400" },
};

// Where a role task is in its work, next to the activity badge. Plain chats have no stage.
export function StageBadge({ stage }: { stage: TaskStage | null }) {
  if (!stage) return null;
  const s = stageStyle[stage];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${s.className}`}>{s.label}</span>;
}

// A task's priority (0-10), and the emergency flag that outranks it.
export function PriorityBadge({ priority, emergency }: { priority: number; emergency?: boolean }) {
  if (emergency) return <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-red-300 uppercase">⚠ Emergency</span>;
  return (
    <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300" title="Priority, 0 to 10">
      P{priority}
    </span>
  );
}

export const selectClass = "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-200 focus:border-accent focus:outline-none";

export function PrioritySelect({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <select aria-label="Priority" className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: 11 }, (_, i) => 10 - i).map((p) => (
        <option key={p} value={p}>
          Priority {p}
          {p === 10 ? " (top)" : p === 5 ? " (normal)" : p === 0 ? " (someday)" : ""}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-wide text-ink-300 uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-accent focus:outline-none";

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-xl border border-ink-700 bg-ink-850 p-0 text-ink-100 shadow-2xl backdrop:bg-black/60"
    >
      <div className="p-5">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{(error as Error).message ?? String(error)}</p>;
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-200 select-none" title={hint}>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-accent-strong" : "bg-ink-700"}`}>
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : ""}`} />
      </span>
      {label}
    </label>
  );
}
