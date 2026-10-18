import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { FeedbackStatus, Project } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, inputClass, selectClass } from "../components/ui.tsx";
import { useDraft } from "../drafts.ts";
import { ago } from "../format.ts";
import { RoleSelect, useRoles } from "./ProjectPage.tsx";

// Pasted text and .md/.txt files hold one item per paragraph; a .csv holds one per line (its first
// column, unquoted), after an optional header.
export function splitFeedback(text: string, csv: boolean): string[] {
  if (!csv)
    return text
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  if (rows[0] && /^(feedback|text|comment|review)\b/i.test(rows[0])) rows.shift();
  return rows.map((row) => (row.startsWith('"') ? row.slice(1, row.indexOf('"', 1) > 0 ? row.indexOf('"', 1) : undefined) : row).trim()).filter(Boolean);
}

export function FeedbackTab({ project }: { project: Project }) {
  const navigate = useNavigate();
  const items = useQuery({ queryKey: keys.feedback(project.id), queryFn: () => api.feedback(project.id) });
  const roles = useRoles(project.id);
  const [text, setText] = useDraft(`feedback:${project.id}`);
  const [source, setSource] = useState("");
  const [filter, setFilter] = useState<FeedbackStatus | "all">("new");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [roleChoice, setRoleChoice] = useState("");
  const director = roles.find((r) => /director/i.test(r.role.name))?.role.id ?? roles[0]?.role.id ?? "";
  const roleId = roleChoice || director;

  const add = useMutation({
    mutationFn: (input: { texts: string[]; source: string }) =>
      api.addFeedback(project.id, { items: input.texts.map((t) => ({ text: t, source: input.source || undefined })) }),
    onSuccess: () => setText(""),
  });
  const triage = useMutation({
    mutationFn: () => api.triage(project.id, [...selected], roleId),
    onSuccess: (task) => void navigate(`/tasks/${task.id}`),
  });
  const setStatus = useMutation({ mutationFn: (v: { id: string; status: FeedbackStatus }) => api.updateFeedback(v.id, v.status) });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteFeedback(id) });

  const shown = (items.data ?? []).filter((f) => filter === "all" || f.status === filter);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink-200">Add player feedback</h2>
        <textarea
          aria-label="Feedback"
          className={`${inputClass} min-h-28`}
          placeholder="Paste feedback here. Separate items with a blank line."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Source"
            className={`${selectClass} w-48`}
            placeholder="Source (Steam, Discord…)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Button variant="primary" disabled={!text.trim() || add.isPending} onClick={() => add.mutate({ texts: splitFeedback(text, false), source })}>
            Add {splitFeedback(text, false).length || ""} item{splitFeedback(text, false).length === 1 ? "" : "s"}
          </Button>
          <label className="cursor-pointer rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-200 hover:bg-ink-800">
            Import .txt / .md / .csv
            <input
              type="file"
              accept=".txt,.md,.csv"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const texts = splitFeedback(await file.text(), file.name.toLowerCase().endsWith(".csv"));
                if (texts.length) add.mutate({ texts: texts.slice(0, 500), source: source || file.name });
              }}
            />
          </label>
        </div>
        <ErrorNote error={add.error} />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-ink-200">Feedback</h2>
          <select aria-label="Show" className={selectClass} value={filter} onChange={(e) => setFilter(e.target.value as FeedbackStatus | "all")}>
            <option value="new">New</option>
            <option value="triaged">Triaged</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
          <span className="ml-auto text-xs text-ink-400">{selected.size} selected</span>
          {roles.length > 0 ? (
            <>
              <RoleSelect projectId={project.id} value={roleId} onChange={setRoleChoice} />
              <Button variant="primary" disabled={selected.size === 0 || !roleId || triage.isPending} onClick={() => triage.mutate()}>
                Triage with {roles.find((r) => r.role.id === roleId)?.role.name ?? "role"}
              </Button>
            </>
          ) : (
            <span className="text-xs text-ink-400">Set up the Studio to triage with a role.</span>
          )}
        </div>
        <ErrorNote error={triage.error ?? setStatus.error ?? remove.error} />
        {shown.length === 0 && <p className="text-sm text-ink-400">Nothing here.</p>}
        <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800">
          {shown.map((f) => (
            <li key={f.id} className="flex items-start gap-3 bg-ink-900/40 px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select: ${f.text.slice(0, 40)}`}
                className="mt-1 accent-[var(--color-accent)]"
                checked={selected.has(f.id)}
                onChange={() => toggle(f.id)}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm whitespace-pre-wrap text-ink-100">{f.text}</p>
                <p className="mt-1 text-xs text-ink-400">
                  {f.source} · {ago(f.createdAt)}
                  {f.taskId && (
                    <>
                      {" · "}
                      <Link to={`/tasks/${f.taskId}`} className="text-accent underline">
                        triage task
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <select
                aria-label="Status"
                className={selectClass}
                value={f.status}
                onChange={(e) => setStatus.mutate({ id: f.id, status: e.target.value as FeedbackStatus })}
              >
                <option value="new">new</option>
                <option value="triaged">triaged</option>
                <option value="done">done</option>
              </select>
              <button className="px-1 text-ink-400 hover:text-red-300" aria-label="Delete feedback" onClick={() => remove.mutate(f.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
