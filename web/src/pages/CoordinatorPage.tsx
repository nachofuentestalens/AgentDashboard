import { useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  PROVIDERS,
  type CoordinatorAction,
  type CoordinatorConfig,
  type CoordinatorView,
  type Provider,
  type ProviderPlan,
  type ProviderQuotaView,
  type QuotaLevel,
  type QuotaWindow,
  type QuotaWindowView,
} from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass, selectClass, Toggle } from "../components/ui.tsx";
import { ago } from "../format.ts";

const providerLabel = (p: Provider) => PROVIDERS.find((x) => x.id === p)!.label;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const LEVEL: Record<QuotaLevel, { label: string; className: string }> = {
  unknown: { label: "No reading", className: "bg-ink-800 text-ink-300" },
  ok: { label: "Room to work", className: "bg-emerald-500/15 text-emerald-300" },
  conserve: { label: "Conserving", className: "bg-amber-500/15 text-amber-300" },
  reserve: { label: "Reserve only", className: "bg-orange-500/15 text-orange-300" },
  exhausted: { label: "Limit reached", className: "bg-red-500/15 text-red-300" },
};

const ACTION_LABEL: Record<CoordinatorAction["type"], string> = { pause: "Pause", resume: "Resume", start: "Start", switch: "Switch provider" };

function until(iso: string | null, now = Date.now()): string {
  if (!iso) return "unknown";
  const minutes = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  const h = Math.floor(minutes / 60);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

// The local clock time of a reset, with the weekday when it is not today.
function resetClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function CoordinatorPage() {
  const qc = useQueryClient();
  // Countdowns move on their own, so the view refreshes even without pushes.
  const view = useQuery({ queryKey: keys.coordinator, queryFn: api.coordinator, refetchInterval: 30_000 });
  const setView = (v: CoordinatorView) => qc.setQueryData(keys.coordinator, v);
  const apply = useMutation({ mutationFn: api.applyCoordinatorAction, onSuccess: setView });
  const v = view.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold">Coordinator</h1>
          <p className="mt-1 text-sm text-ink-400">
            Watches each provider's session and weekly limits and keeps a reserve free for your own use. When usage gets close, queued agent work waits (only
            important work starts); inside the reserve, running agents pause and resume after the reset. Your own chats are never held. Advise lists the
            decisions for you to apply; Auto applies them.
          </p>
        </div>
        <ErrorNote error={view.error} />

        {v && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              {v.providers.map((p) => (
                <ProviderCard key={p.provider} p={p} config={v.config} onSaved={setView} />
              ))}
            </div>

            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-200">
                Decisions{" "}
                <span className="font-normal text-ink-400">
                  ({v.config.mode === "auto" ? "applied automatically" : v.config.mode === "advise" ? "waiting for you" : "coordinator is off"})
                </span>
              </h2>
              {v.recommendations.length === 0 ? (
                <p className="text-sm text-ink-400">Nothing to change right now.</p>
              ) : (
                <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800">
                  {v.recommendations.map((a) => (
                    <li key={a.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="w-28 shrink-0 font-medium text-ink-200">{ACTION_LABEL[a.type]}</span>
                      <div className="min-w-0 flex-1">
                        <Link to={`/tasks/${a.taskId}`} className="text-ink-100 hover:underline">
                          {a.taskTitle}
                        </Link>
                        <p className="truncate text-xs text-ink-400">
                          {providerLabel(a.provider)}
                          {a.to ? ` → ${providerLabel(a.to)}` : ""} · {a.reason}
                        </p>
                      </div>
                      <Button onClick={() => apply.mutate(a.key)} disabled={apply.isPending}>
                        Apply
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <ErrorNote error={apply.error} />
            </section>

            {v.paused.length > 0 && (
              <section>
                <h2 className="mb-2 text-sm font-semibold text-ink-200">Paused by the coordinator</h2>
                <ul className="space-y-1 text-sm">
                  {v.paused.map((p) => (
                    <li key={p.taskId}>
                      <Link to={`/tasks/${p.taskId}`} className="text-ink-100 hover:underline">
                        {p.title}
                      </Link>{" "}
                      <span className="text-xs text-ink-400">({providerLabel(p.provider)})</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <PolicyForm config={v.config} onSaved={setView} />

            <section>
              <h2 className="mb-2 text-sm font-semibold text-ink-200">Activity</h2>
              {v.log.length === 0 ? (
                <p className="text-sm text-ink-400">No decisions applied since the server started.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {v.log.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="w-20 shrink-0 text-xs text-ink-400">{ago(e.at)}</span>
                      <span className={e.error ? "text-red-300" : "text-ink-200"}>
                        {e.by === "owner" ? "You" : "Coordinator"}: {ACTION_LABEL[e.action.type]} "{e.action.taskTitle}"{e.error ? ` failed: ${e.error}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ p, config, onSaved }: { p: ProviderQuotaView; config: CoordinatorConfig; onSaved: (v: CoordinatorView) => void }) {
  const level = LEVEL[p.level];
  const refresh = useMutation({ mutationFn: api.refreshUsage, onSuccess: onSaved });
  return (
    <section className="space-y-3 rounded-xl border border-ink-800 bg-ink-900/60 p-4" aria-label={providerLabel(p.provider)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-ink-100">{providerLabel(p.provider)}</h2>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${level.className}`}>{level.label}</span>
      </div>
      <p className="text-sm text-ink-300">{p.reason}</p>
      <Meter w={p.session} reserve={config.sessionReservePct} title="Session" />
      <Meter w={p.weekly} reserve={config.weeklyReservePct} title="Week" />
      <p className="text-xs text-ink-400">
        {p.running} running · {p.queued} queued
      </p>
      {p.usageCheck && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className={p.usageCheck.error ? "text-amber-300" : "text-ink-400"}>
            {p.usageCheck.error ? `Usage not read: ${p.usageCheck.error}` : `Usage read from ${providerLabel(p.provider)} ${ago(p.usageCheck.at)}`}
          </span>
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Reading…" : "Refresh"}
          </Button>
        </div>
      )}
      <ErrorNote error={refresh.error} />
      <ReadingForm provider={p.provider} onSaved={onSaved} />
    </section>
  );
}

const SOURCE: Record<QuotaWindowView["source"], string> = {
  cli: "reported by the CLI",
  api: "from the provider's usage page",
  owner: "your reading",
  error: "a run hit the limit",
  estimate: "estimated from tokens",
  reset: "reset since the last reading",
  none: "no reading",
};

function Meter({ w, reserve, title }: { w: QuotaWindowView; reserve: number; title: string }) {
  const used = w.usedPercent;
  const bar = w.level === "exhausted" || w.level === "reserve" ? "bg-red-400" : w.level === "conserve" ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div>
      <div className="flex justify-between text-xs text-ink-400">
        <span>
          {title}:{" "}
          <span className="text-ink-200">{used === null ? "unknown" : `${Math.round(used)}% used · ${Math.max(0, 100 - Math.round(used))}% left`}</span>
        </span>
        <span title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>
          {w.resetsAt ? `resets in ${until(w.resetsAt)} (${resetClock(w.resetsAt)})` : "reset time unknown"}
        </span>
      </div>
      <div
        className="relative mt-1 h-2 overflow-hidden rounded-full bg-ink-800"
        role="meter"
        aria-label={`${title} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
      >
        {used !== null && <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, used)}%` }} />}
        {/* The owner's reserve sits at the right end of the bar. */}
        <div className="absolute inset-y-0 right-0 border-l border-dashed border-ink-400 bg-ink-400/10" style={{ width: `${reserve}%` }} />
        {w.paceLimitPct !== null && <div className="absolute inset-y-0 w-0.5 bg-sky-400" style={{ left: `${w.paceLimitPct}%` }} title="Even pace by now" />}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-400">
        {SOURCE[w.source]}
        {w.readingAt ? ` · read ${ago(w.readingAt)}` : ""}
        {w.paceLimitPct !== null ? ` · pace ${Math.round(w.paceLimitPct)}%` : ""}
      </p>
    </div>
  );
}

function ReadingForm({ provider, onSaved }: { provider: Provider; onSaved: (v: CoordinatorView) => void }) {
  const [window, setWindow] = useState<QuotaWindow>("session");
  const [used, setUsed] = useState("");
  const [resets, setResets] = useState("");
  const save = useMutation({
    mutationFn: () => api.addQuotaReading({ provider, window, usedPercent: Number(used), resetsAt: resets ? new Date(resets).toISOString() : null }),
    onSuccess: (v) => {
      onSaved(v);
      setUsed("");
      setResets("");
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-ink-800 pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Reading" hint="From the provider's usage page">
        <select className={selectClass} value={window} onChange={(e) => setWindow(e.target.value as QuotaWindow)} aria-label="Window">
          <option value="session">Session</option>
          <option value="weekly">Week</option>
        </select>
      </Field>
      <Field label="Used %">
        <input className={`${inputClass} !w-20`} type="number" min={0} max={100} required value={used} onChange={(e) => setUsed(e.target.value)} />
      </Field>
      <Field label="Resets at" hint="Empty: a full window from now">
        <input className={`${inputClass} !w-48`} type="datetime-local" value={resets} onChange={(e) => setResets(e.target.value)} />
      </Field>
      <Button type="submit" disabled={save.isPending || used === ""}>
        Save reading
      </Button>
      <ErrorNote error={save.error} />
    </form>
  );
}

function PolicyForm({ config, onSaved }: { config: CoordinatorConfig; onSaved: (v: CoordinatorView) => void }) {
  // Starts from the saved policy; later refreshes do not overwrite unsaved edits.
  const [c, setC] = useState(config);
  const save = useMutation({ mutationFn: () => api.saveCoordinatorConfig(c), onSuccess: onSaved });
  const num = (key: keyof CoordinatorConfig) => (e: ChangeEvent<HTMLInputElement>) => setC({ ...c, [key]: Number(e.target.value) });
  const setPlan = (p: Provider, patch: Partial<ProviderPlan>) => setC({ ...c, plans: { ...c.plans, [p]: { ...c.plans[p], ...patch } } });
  const cap = (v: string) => (v.trim() === "" ? null : Math.max(1, Math.round(Number(v))));

  return (
    <form
      className="space-y-4 rounded-xl border border-ink-800 bg-ink-900/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-sm font-semibold text-ink-200">Policy</h2>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Mode">
          <select className={selectClass} value={c.mode} onChange={(e) => setC({ ...c, mode: e.target.value as CoordinatorConfig["mode"] })}>
            <option value="off">Off: only show usage</option>
            <option value="advise">Advise: I apply decisions</option>
            <option value="auto">Auto: apply decisions</option>
          </select>
        </Field>
        <Field label="Session reserve %" hint="Kept free for you">
          <input className={`${inputClass} !w-24`} type="number" min={0} max={90} value={c.sessionReservePct} onChange={num("sessionReservePct")} />
        </Field>
        <Field label="Weekly reserve %">
          <input className={`${inputClass} !w-24`} type="number" min={0} max={90} value={c.weeklyReservePct} onChange={num("weeklyReservePct")} />
        </Field>
        <Field label="Conserve band %" hint="Above the reserve">
          <input className={`${inputClass} !w-24`} type="number" min={0} max={50} value={c.conserveMarginPct} onChange={num("conserveMarginPct")} />
        </Field>
        <Field label="Weekly burst %" hint="Ahead of an even pace">
          <input className={`${inputClass} !w-24`} type="number" min={0} max={100} value={c.weeklyBurstPct} onChange={num("weeklyBurstPct")} />
        </Field>
        <Field label="Conserving: min priority">
          <input className={`${inputClass} !w-24`} type="number" min={0} max={10} value={c.conservePriority} onChange={num("conservePriority")} />
        </Field>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Toggle checked={c.pauseRunning} onChange={(pauseRunning) => setC({ ...c, pauseRunning })} label="Pause running agents inside the reserve" />
        <Toggle checked={c.resumePaused} onChange={(resumePaused) => setC({ ...c, resumePaused })} label="Resume paused agents when there is room" />
        <Toggle
          checked={c.fillIdle}
          onChange={(fillIdle) => setC({ ...c, fillIdle })}
          label="Start backlog work before unused session usage resets"
          hint="Within 2 hours of a session reset, with at least 25% above the reserve left"
        />
        <Toggle
          checked={c.switchProvider}
          onChange={(switchProvider) => setC({ ...c, switchProvider })}
          label="Move held work to the other provider"
          hint="Sets the task's provider; its model and effort fall back to the role's or project's"
        />
      </div>
      {PROVIDERS.map(({ id, label }) => (
        <fieldset key={id} className="flex flex-wrap items-end gap-4 border-t border-ink-800 pt-3">
          <legend className="pb-2 text-xs font-medium text-ink-300">{label} plan</legend>
          <Field label="Session hours">
            <input
              className={`${inputClass} !w-20`}
              type="number"
              min={1}
              max={24}
              value={c.plans[id].sessionHours}
              onChange={(e) => setPlan(id, { sessionHours: Number(e.target.value) })}
            />
          </Field>
          <Field label="Weekly reset" hint="When no reading reports it">
            <div className="flex gap-1">
              <select className={selectClass} value={c.plans[id].weeklyResetDay} onChange={(e) => setPlan(id, { weeklyResetDay: Number(e.target.value) })}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <input
                className={`${inputClass} !w-16`}
                type="number"
                min={0}
                max={23}
                aria-label="Hour"
                value={c.plans[id].weeklyResetHour}
                onChange={(e) => setPlan(id, { weeklyResetHour: Number(e.target.value) })}
              />
            </div>
          </Field>
          <Field label="Session token cap" hint="Optional, for estimates">
            <input
              className={`${inputClass} !w-36`}
              inputMode="numeric"
              placeholder="unknown"
              value={c.plans[id].sessionTokenCap ?? ""}
              onChange={(e) => setPlan(id, { sessionTokenCap: cap(e.target.value) })}
            />
          </Field>
          <Field label="Weekly token cap">
            <input
              className={`${inputClass} !w-36`}
              inputMode="numeric"
              placeholder="unknown"
              value={c.plans[id].weeklyTokenCap ?? ""}
              onChange={(e) => setPlan(id, { weeklyTokenCap: cap(e.target.value) })}
            />
          </Field>
        </fieldset>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save policy
        </Button>
        {save.isSuccess && <span className="text-sm text-emerald-300">Saved.</span>}
        <ErrorNote error={save.error} />
      </div>
    </form>
  );
}
