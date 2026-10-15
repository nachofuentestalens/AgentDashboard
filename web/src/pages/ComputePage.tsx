import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ComputeDepartment, ComputeRun } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass, PriorityBadge } from "../components/ui.tsx";
import { cost, duration } from "../format.ts";

export function ComputePage() {
  const qc = useQueryClient();
  const compute = useQuery({ queryKey: keys.compute, queryFn: api.compute, refetchInterval: 15_000 });
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.settings });
  const [max, setMax] = useState("");
  const [budget, setBudget] = useState("");
  useEffect(() => {
    if (!settings.data) return;
    setMax(String(settings.data.maxConcurrentRuns));
    setBudget(settings.data.dailyBudgetUsd === null ? "" : String(settings.data.dailyBudgetUsd));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => api.updateSettings({ maxConcurrentRuns: Number(max), dailyBudgetUsd: budget.trim() === "" ? null : Number(budget) }),
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.compute });
    },
  });

  const c = compute.data;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold">Compute</h1>
          <p className="mt-1 text-sm text-ink-400">
            How many agents run at once and what they spend. Departments share free slots by weight; inside a department the highest priority goes first. Dollar
            totals include only reported costs. Codex does not report a dollar cost; these budgets do not cap ChatGPT usage, plain chats or active runs.
            Emergencies skip the queue.
          </p>
        </div>
        <ErrorNote error={compute.error} />

        {c && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Agents running" value={`${c.active.length}`} sub={`of ${c.maxConcurrentRuns} slots`} />
            <Stat label="Queued" value={`${c.queued.length}`} sub={c.queued.length ? `next: ${c.queued[0]!.taskTitle}` : "nothing waiting"} />
            <Stat
              label="Spend, last 24 h"
              value={cost(c.spend24h)}
              sub={c.dailyBudgetUsd === null ? "no daily budget" : `of ${cost(c.dailyBudgetUsd)} budget`}
              alert={c.dailyBudgetUsd !== null && c.spend24h >= c.dailyBudgetUsd}
            />
          </div>
        )}

        <form
          className="flex flex-wrap items-end gap-4 rounded-xl border border-ink-800 bg-ink-900/60 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Agents at once" hint="Across all projects. Plain chats always start, but count.">
            <input className={`${inputClass} !w-28`} type="number" min={1} max={32} value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
          <Field label="Daily budget ($)" hint="Over the last 24 hours. Empty: no limit.">
            <input className={`${inputClass} !w-36`} inputMode="decimal" placeholder="none" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save limits
          </Button>
          {save.isSuccess && <span className="text-sm text-emerald-300">Saved.</span>}
          <ErrorNote error={save.error} />
        </form>

        {c && (
          <>
            <RunTable title="Running" runs={c.active} />
            <RunTable title="Queue" runs={c.queued} queued />
            <DepartmentTable departments={c.departments} />
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4">
      <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">{label}</p>
      <p className="mt-1 text-3xl font-semibold text-ink-100">{value}</p>
      <p className={`mt-0.5 truncate text-xs ${alert ? "text-red-300" : "text-ink-400"}`}>
        {alert && "⚠ reached · "}
        {sub}
      </p>
    </div>
  );
}

function RunTable({ title, runs, queued }: { title: string; runs: ComputeRun[]; queued?: boolean }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink-200">
        {title} <span className="font-normal text-ink-400">({runs.length})</span>
      </h2>
      {runs.length === 0 ? (
        <p className="text-sm text-ink-400">{queued ? "Nothing is waiting." : "No agent is running."}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ink-800">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-xs text-ink-400">
              <tr>
                {queued && <th className="px-3 py-2 font-medium">#</th>}
                <th className="px-3 py-2 font-medium">Task</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">Priority</th>
                <th className="px-3 py-2 font-medium">{queued ? "Why it waits" : "Time"}</th>
                {queued && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {runs.map((r, i) => (
                <RunRow key={r.run.id} r={r} position={queued ? i + 1 : null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RunRow({ r, position }: { r: ComputeRun; position: number | null }) {
  const force = useMutation({ mutationFn: () => api.forceRun(r.run.id) });
  const stop = useMutation({ mutationFn: () => api.stopRun(r.run.id) });
  return (
    <tr className="bg-ink-900/40 align-top">
      {position !== null && <td className="px-3 py-2 font-mono text-xs text-ink-400">{position}</td>}
      <td className="px-3 py-2">
        <Link to={`/tasks/${r.run.taskId}`} className="text-ink-100 hover:underline">
          {r.taskTitle}
        </Link>
        <p className="text-xs text-ink-400">{r.projectName}</p>
      </td>
      <td className="px-3 py-2 text-xs text-ink-300">
        {r.agentName ?? r.roleName ?? "Chat"}
        {r.departmentName && <p className="text-ink-400">{r.departmentName}</p>}
      </td>
      <td className="px-3 py-2">
        {r.roleName ? <PriorityBadge priority={r.priority} emergency={r.emergency} /> : <span className="text-xs text-ink-400">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-ink-300">{position !== null ? (r.run.waitReason ?? "Starting…") : duration(r.run.startedAt, null)}</td>
      {position !== null && (
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {!r.run.forced && (
            <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => force.mutate()} title="Ignore budgets and emergencies for this run">
              Run anyway
            </Button>
          )}
          <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => stop.mutate()}>
            Remove
          </Button>
        </td>
      )}
    </tr>
  );
}

// Spend against a limit is a meter: one hue on a track of the same ramp. Without a budget the bar
// compares the department with the biggest spender instead, and says so.
function DepartmentTable({ departments }: { departments: ComputeDepartment[] }) {
  if (departments.length === 0) return null;
  const top = Math.max(...departments.map((d) => d.spend24h), 0.0001);
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-ink-200">Departments</h2>
      <div className="overflow-hidden rounded-xl border border-ink-800">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-left text-xs text-ink-400">
            <tr>
              <th className="px-3 py-2 font-medium">Department</th>
              <th className="px-3 py-2 text-right font-medium">Weight</th>
              <th className="px-3 py-2 font-medium">Last 24 h</th>
              <th className="px-3 py-2 text-right font-medium">7 days</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {departments.map((d) => {
              const limit = d.dailyBudgetUsd;
              const over = limit !== null && d.spend24h >= limit;
              const share = limit ? Math.min(1, d.spend24h / limit) : d.spend24h / top;
              return (
                <tr key={d.id} className="bg-ink-900/40">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2 text-ink-100">
                      <span className="h-2 w-2 rounded-full" style={{ background: d.color }} />
                      {d.name}
                    </span>
                    <p className="text-xs text-ink-400">{d.projectName}</p>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-ink-200">{d.weight}</td>
                  <td className="w-1/2 px-3 py-2">
                    <div
                      className="h-2 rounded-full bg-ink-800"
                      role="meter"
                      aria-label={`${d.name} spend`}
                      aria-valuemin={0}
                      aria-valuemax={limit ?? top}
                      aria-valuenow={d.spend24h}
                      title={limit ? `${cost(d.spend24h)} of ${cost(limit)} daily budget` : `${cost(d.spend24h)}; no budget (bar relative to the top spender)`}
                    >
                      <div
                        className={`h-2 rounded-full ${over ? "bg-red-400" : "bg-accent"}`}
                        style={{ width: `${Math.max(share * 100, d.spend24h > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-ink-300">
                      {cost(d.spend24h)}
                      {limit !== null ? ` of ${cost(limit)}` : " · no budget"}
                      {over && <span className="text-red-300"> · ⚠ budget reached</span>}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right text-ink-300">{cost(d.spend7d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
