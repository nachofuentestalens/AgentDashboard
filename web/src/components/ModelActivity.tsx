import type { ComputeRun } from "@ad/shared";
import { Link } from "react-router";

export function ModelActivity({
  label,
  active,
  queued,
  pending,
  error,
}: {
  label: string;
  active: ComputeRun[];
  queued: ComputeRun[];
  pending: boolean;
  error: boolean;
}) {
  const rows = [...active, ...queued];
  const projects = [...new Map(rows.map((row) => [row.projectId, row.projectName])).entries()];
  const summary = pending
    ? "Loading activity…"
    : error
      ? "Activity unavailable"
      : rows.length
        ? `${active.length} working${queued.length ? ` · ${queued.length} queued` : ""}`
        : "Idle";

  return (
    <details className="group/activity text-[11px]" aria-label={`${label} activity`}>
      <summary className="cursor-pointer rounded px-1 py-1 text-ink-400 hover:bg-ink-800 focus-visible:outline focus-visible:outline-gold">
        <span className={active.length && !error ? "text-emerald-300" : ""}>{summary}</span>
      </summary>
      <div className="max-h-52 space-y-1 overflow-y-auto overscroll-contain pt-1">
        {error && <p className="px-2 text-amber-300">Could not refresh activity. Retrying automatically.</p>}
        {!pending && !error && !rows.length && <p className="px-2 text-ink-400">No running or queued tasks.</p>}
        {projects.map(([id, name]) => {
          const tasks = rows.filter((row) => row.projectId === id);
          return (
            <details key={id} open className="rounded bg-ink-950/40">
              <summary className="cursor-pointer truncate px-2 py-1 text-ink-300 focus-visible:outline focus-visible:outline-gold" title={name}>
                {name} <span className="text-ink-400">({tasks.length})</span>
              </summary>
              {tasks.map(({ run, taskTitle, roleName }) => {
                const status = run.status === "queued" ? "Queued" : "Working";
                const model = run.model || `${label} default`;
                const identifier = run.taskId.slice(0, 8);
                const hint = `${model} · ${status}\n${taskTitle}\nTask ${identifier}${roleName ? ` · ${roleName}` : ""}${run.waitReason ? `\n${run.waitReason}` : ""}`;
                return (
                  <Link
                    key={run.id}
                    to={`/tasks/${run.taskId}`}
                    title={hint}
                    aria-label={hint}
                    className="block min-w-0 rounded px-2 py-1.5 hover:bg-ink-800 focus-visible:outline focus-visible:outline-gold"
                  >
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${run.status === "queued" ? "bg-amber-400" : "bg-emerald-400"}`} />
                      <span className="truncate text-ink-200">{model}</span>
                      <span className="ml-auto shrink-0 text-ink-400">{status}</span>
                    </span>
                    <span className="block truncate pl-3 text-ink-400">{taskTitle || identifier}</span>
                  </Link>
                );
              })}
            </details>
          );
        })}
      </div>
    </details>
  );
}
