import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import type { Effort, Project } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Composer } from "../components/Composer.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { ErrorNote, StatusBadge, Toggle } from "../components/ui.tsx";
import { ago, cost } from "../format.ts";
import { ProjectSettings } from "./ProjectSettings.tsx";

const PLANNED = [
  { label: "Design", hint: "Game design sections and the proposals inbox arrive in Phase 2." },
  { label: "Decisions", hint: "The decision log arrives in Phase 2." },
];

export function ProjectPage({ tab }: { tab: "tasks" | "settings" }) {
  const { projectId = "" } = useParams();
  const project = useQuery({ queryKey: keys.project(projectId), queryFn: () => api.project(projectId) });

  if (project.error)
    return (
      <div className="p-8">
        <ErrorNote error={project.error} />
      </div>
    );
  if (!project.data) return null;
  const p = project.data;

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `border-b-2 px-1 pb-2 text-sm ${isActive ? "border-accent text-ink-100" : "border-transparent text-ink-400 hover:text-ink-200"}`;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-ink-800 px-8 pt-6">
        <h1 className="text-xl font-semibold">{p.name}</h1>
        <p className="mt-0.5 font-mono text-xs text-ink-400">{p.repoPath}</p>
        <nav className="mt-4 flex gap-5">
          <NavLink to={`/projects/${p.id}`} end className={tabClass}>
            Tasks
          </NavLink>
          {PLANNED.map((t) => (
            <span key={t.label} title={t.hint} className="cursor-not-allowed border-b-2 border-transparent px-1 pb-2 text-sm text-ink-600">
              {t.label}
            </span>
          ))}
          <NavLink to={`/projects/${p.id}/settings`} className={tabClass}>
            Settings
          </NavLink>
        </nav>
      </header>
      <div className="flex-1 overflow-y-auto">{tab === "tasks" ? <TasksTab project={p} /> : <ProjectSettings project={p} />}</div>
    </div>
  );
}

function TasksTab({ project }: { project: Project }) {
  const navigate = useNavigate();
  const tasks = useQuery({ queryKey: keys.tasks(project.id), queryFn: () => api.tasks(project.id) });
  const [canEdit, setCanEdit] = useState(true);
  const [choice, setChoice] = useState<{ model: string | null; effort: Effort | null }>({ model: null, effort: null });
  const create = useMutation({
    mutationFn: (message: string) => api.createTask(project.id, { message, canEdit, ...choice }),
    onSuccess: (task) => void navigate(`/tasks/${task.id}`),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-200">New chat</h2>
        <Composer
          placeholder="Ask an agent anything about this project: design a system, fix a bug, explain the code…"
          sendLabel="Start chat"
          busy={create.isPending}
          onSend={(text) => create.mutateAsync(text)}
          footer={
            <>
              <Toggle checked={canEdit} onChange={setCanEdit} label="Can edit files" hint="Off: the agent can only read and investigate." />
              <ModelPicker
                model={choice.model}
                effort={choice.effort}
                defaults={{ model: project.defaultModel, effort: project.defaultEffort }}
                onChange={setChoice}
              />
            </>
          }
        />
        <ErrorNote error={create.error} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-200">Tasks</h2>
        {tasks.data?.length === 0 && <p className="text-sm text-ink-400">No tasks yet. Start a chat above.</p>}
        <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800">
          {tasks.data?.map((t) => (
            <li key={t.id}>
              <Link to={`/tasks/${t.id}`} className="flex items-start gap-4 bg-ink-900/40 px-4 py-3 hover:bg-ink-850">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">{t.title}</span>
                    {!t.canEdit && <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 uppercase">read-only</span>}
                  </div>
                  {t.lastMessage && <p className="mt-0.5 truncate text-xs text-ink-400">{t.lastMessage}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={t.status} />
                  <span className="text-xs text-ink-400">
                    {ago(t.updatedAt)} · {cost(t.costUsd)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
