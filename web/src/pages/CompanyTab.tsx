import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CompanyConfig, Project } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass, Toggle } from "../components/ui.tsx";

const EMPTY: CompanyConfig = { enabled: false, description: "", genre: "", references: "", audience: "", playtestInstructions: "", dailyHourUtc: 9 };

export function CompanyTab({ project }: { project: Project }) {
  const query = useQuery({ queryKey: keys.company(project.id), queryFn: () => api.company(project.id), refetchInterval: 30_000 });
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CompanyConfig | null>(null);
  const config = draft ?? query.data?.config ?? EMPTY;
  const change = (patch: Partial<CompanyConfig>) => setDraft({ ...config, ...patch });
  const save = useMutation({
    mutationFn: () => api.saveCompany(project.id, config),
    onSuccess: (view) => {
      qc.setQueryData(keys.company(project.id), view);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: keys.studio(project.id) });
      void qc.invalidateQueries({ queryKey: keys.tasks(project.id) });
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-8 py-6">
      <div>
        <h2 className="text-lg font-semibold">Company brief and daily reviews</h2>
        <p className="mt-2 text-sm text-ink-400">
          Describe the game and enable daily Director and QA Player assignments. Reports cover the playable state, bugs, fun, priorities, and milestones.
        </p>
        <p className="mt-2 text-xs text-ink-400">
          This first stage schedules observation and planning. Dynamic staffing and automatic execution of report recommendations are not available yet.
          Existing task review and delivery settings still apply.
        </p>
      </div>
      <ErrorNote error={query.error} />
      {query.data && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Game description">
            <textarea
              required
              maxLength={12000}
              className={`${inputClass} min-h-32`}
              value={config.description}
              onChange={(e) => change({ description: e.target.value })}
            />
          </Field>
          <Field label="Genre">
            <input required maxLength={200} className={inputClass} value={config.genre} onChange={(e) => change({ genre: e.target.value })} />
          </Field>
          <Field label="Target audience">
            <input maxLength={2000} className={inputClass} value={config.audience} onChange={(e) => change({ audience: e.target.value })} />
          </Field>
          <Field label="References" hint="Games, links, and what the team should learn from each.">
            <textarea maxLength={6000} className={inputClass} value={config.references} onChange={(e) => change({ references: e.target.value })} />
          </Field>
          <Field
            label="How to playtest"
            hint="Local launch instructions, controls, scenarios, and evidence to capture. Agents must report when they cannot actually play."
          >
            <textarea
              maxLength={6000}
              className={inputClass}
              value={config.playtestInstructions}
              onChange={(e) => change({ playtestInstructions: e.target.value })}
            />
          </Field>
          <Field
            label="Daily review hour (UTC)"
            hint="The dashboard must be running. After downtime, it schedules today's reviews without replaying missed days."
          >
            <input
              type="number"
              required
              min={0}
              max={23}
              step={1}
              className={inputClass}
              value={config.dailyHourUtc}
              onChange={(e) => change({ dailyHourUtc: Number(e.target.value) })}
            />
          </Field>
          <Toggle checked={config.enabled} onChange={(enabled) => change({ enabled })} label="Schedule daily Director and QA reviews" />
          <p className="text-xs text-ink-400">
            Enabling staffs a Game Director and QA Player if needed and uses the configured provider and compute limits. Paused staff stay paused. Disabling
            stops future assignments; existing queued or running tasks remain in Tasks.
          </p>
          <ErrorNote error={save.error} />
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={save.isPending}>
              Save company
            </Button>
            {save.isSuccess && !draft && <span className="text-sm text-emerald-300">Company saved.</span>}
          </div>
        </form>
      )}
      {query.data?.error && (
        <p role="alert" className="text-sm text-red-300">
          Daily scheduling: {query.data.error}
        </p>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Recent review assignments</h3>
        <p className="mb-3 text-xs text-ink-400">
          Open an assignment for its report and evidence. A finished assignment does not guarantee the agent successfully played the game.
        </p>
        {!query.data?.assignments.length && <p className="text-sm text-ink-400">No daily assignments yet.</p>}
        <ul className="space-y-2">
          {query.data?.assignments.map((a) => (
            <li key={`${a.day}:${a.kind}`} className="flex gap-3 text-sm">
              {a.taskId ? (
                <Link className="text-accent underline" to={`/tasks/${a.taskId}`}>
                  {a.day} · {a.kind === "director" ? "Director review" : "QA playtest"}
                </Link>
              ) : (
                <span>
                  {a.day} · {a.kind} (deleted)
                </span>
              )}
              <span className="text-ink-400">{a.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
