import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { DEFAULT_PRIORITY, resolveChoice, type Provider, type Effort, type Project, type RoleView } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Composer } from "../components/Composer.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { TaskBoard } from "../components/TaskBoard.tsx";
import { DeliveryPanel } from "../components/DeliveryPanel.tsx";
import { ErrorNote, PrioritySelect, selectClass, Toggle } from "../components/ui.tsx";
import { DocsTab } from "./DocsTab.tsx";
import { FeedbackTab } from "./FeedbackTab.tsx";
import { ProjectSettings } from "./ProjectSettings.tsx";
import { StudioTab } from "./StudioTab.tsx";
import { CompanyTab } from "./CompanyTab.tsx";

export type ProjectTab = "tasks" | "company" | "studio" | "docs" | "feedback" | "settings";

const TABS: { tab: ProjectTab; label: string; path: string }[] = [
  { tab: "tasks", label: "Tasks", path: "" },
  { tab: "company", label: "Company", path: "/company" },
  { tab: "studio", label: "Studio", path: "/studio" },
  { tab: "docs", label: "Docs", path: "/docs" },
  { tab: "feedback", label: "Feedback", path: "/feedback" },
  { tab: "settings", label: "Settings", path: "/settings" },
];

export function ProjectPage({ tab }: { tab: ProjectTab }) {
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
          {TABS.map((t) => (
            <NavLink key={t.tab} to={`/projects/${p.id}${t.path}`} end className={tabClass}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="flex-1 overflow-y-auto">
        {tab === "tasks" && <TasksTab project={p} />}
        {tab === "company" && <CompanyTab project={p} />}
        {tab === "studio" && <StudioTab project={p} />}
        {tab === "docs" && <DocsTab project={p} />}
        {tab === "feedback" && <FeedbackTab project={p} />}
        {tab === "settings" && <ProjectSettings project={p} />}
      </div>
    </div>
  );
}

// The roles of a project, for pickers, with their department's name.
export function useRoles(projectId: string): { role: RoleView; department: string }[] {
  const studio = useQuery({ queryKey: keys.studio(projectId), queryFn: () => api.studio(projectId) });
  return studio.data?.departments.flatMap((d) => d.roles.map((role) => ({ role, department: d.name }))) ?? [];
}

export function RoleSelect({ projectId, value, onChange, none }: { projectId: string; value: string; onChange: (id: string) => void; none?: string }) {
  const roles = useRoles(projectId);
  const departments = [...new Set(roles.map((r) => r.department))];
  return (
    <select aria-label="Assign to" className={selectClass} value={value} onChange={(e) => onChange(e.target.value)}>
      {none !== undefined && <option value="">{none}</option>}
      {departments.map((d) => (
        <optgroup key={d} label={d}>
          {roles
            .filter((r) => r.department === d)
            .map(({ role }) => (
              <option key={role.id} value={role.id}>
                {role.name}
                {role.agents.length === 0 ? " (no agents)" : ""}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function TasksTab({ project }: { project: Project }) {
  const navigate = useNavigate();
  const tasks = useQuery({ queryKey: keys.tasks(project.id), queryFn: () => api.tasks(project.id) });
  const roles = useRoles(project.id);
  const [canEdit, setCanEdit] = useState(true);
  const [roleId, setRoleId] = useState("");
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  const [emergency, setEmergency] = useState(false);
  const [choice, setChoice] = useState<{ provider: Provider | null; model: string | null; effort: Effort | null }>({
    provider: null,
    model: null,
    effort: null,
  });
  const role = roles.find((r) => r.role.id === roleId)?.role;
  const create = useMutation({
    mutationFn: (message: string) =>
      api.createTask(project.id, role ? { message, roleId: role.id, priority, emergency, ...choice } : { message, canEdit, ...choice }),
    onSuccess: (task) => void navigate(`/tasks/${task.id}`),
  });
  const roleName = (id: string | null) => roles.find((r) => r.role.id === id)?.role.name;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-8 py-6">
      <DeliveryPanel projectId={project.id} />
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-200">{role ? `New task for ${role.name}` : "New chat"}</h2>
        <Composer
          draftKey={`new:${project.id}`}
          placeholder={
            role
              ? `Brief the ${role.name}: what to do, why, and what done looks like. Its agents pick tasks up by priority.`
              : "Ask an agent anything about this project: design a system, fix a bug, explain the code…"
          }
          sendLabel={role ? "Queue task" : "Start chat"}
          busy={create.isPending}
          onSend={(text) => create.mutateAsync(text)}
          footer={
            <>
              {roles.length > 0 && <RoleSelect projectId={project.id} value={roleId} onChange={setRoleId} none="Me (chat now)" />}
              {role ? (
                <>
                  <PrioritySelect value={priority} onChange={setPriority} />
                  <Toggle
                    checked={emergency}
                    onChange={setEmergency}
                    label="Emergency"
                    hint="The project does not build or run: goes first and pauses other work."
                  />
                </>
              ) : (
                <Toggle checked={canEdit} onChange={setCanEdit} label="Can edit files" hint="On: full file, command and network access. Off: read-only." />
              )}
              <ModelPicker
                provider={choice.provider}
                model={choice.model}
                effort={choice.effort}
                defaults={resolveChoice([
                  { provider: role?.provider ?? null, model: role?.model ?? null, effort: role?.effort ?? null },
                  { provider: project.defaultProvider, model: project.defaultModel, effort: project.defaultEffort },
                ])}
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
        {tasks.data && <TaskBoard tasks={tasks.data} roleName={roleName} />}
      </section>
    </div>
  );
}
