import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, useMatch } from "react-router";
import { api, keys } from "../api.ts";
import { useLiveUpdates } from "../live.ts";
import { NewProjectContext } from "../newProject.ts";
import { NewProjectDialog } from "../pages/NewProjectDialog.tsx";

export function Layout() {
  const qc = useQueryClient();
  const connection = useLiveUpdates(qc);
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects });
  const [creating, setCreating] = useState(false);
  // A task page belongs to its project in the sidebar too.
  const taskMatch = useMatch("/tasks/:taskId");
  const task = useQuery({ queryKey: keys.task(taskMatch?.params.taskId ?? ""), queryFn: () => api.task(taskMatch!.params.taskId!), enabled: !!taskMatch });
  const activeProjectId = task.data?.task.projectId;

  return (
    <NewProjectContext.Provider value={() => setCreating(true)}>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <NavLink to="/" className="flex items-center gap-2 px-4 py-4">
            <img src="/favicon.svg" alt="" className="h-6 w-6" />
            <span className="font-semibold tracking-tight">AgentDashboard</span>
          </NavLink>
          <div className="flex items-center justify-between px-4 pt-2 pb-1">
            <span className="text-[11px] font-semibold tracking-wider text-ink-400 uppercase">Projects</span>
            <button
              className="rounded px-1.5 text-lg leading-none text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              title="New project"
              onClick={() => setCreating(true)}
            >
              +
            </button>
          </div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
            {projects.data?.map((p) => (
              <NavLink
                key={p.id}
                to={`/projects/${p.id}`}
                className={({ isActive }) =>
                  `block truncate rounded-md px-2 py-1.5 text-sm ${isActive || p.id === activeProjectId ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850 hover:text-ink-100"}`
                }
              >
                {p.name}
              </NavLink>
            ))}
            {projects.data?.length === 0 && <p className="px-2 py-1 text-xs text-ink-400">No projects yet.</p>}
          </nav>
          <div className="space-y-1 border-t border-ink-800 p-2">
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `block rounded-md px-2 py-1.5 text-sm ${isActive ? "bg-ink-800 text-ink-100" : "text-ink-300 hover:bg-ink-850 hover:text-ink-100"}`
              }
            >
              Settings
            </NavLink>
            <p className="flex items-center gap-1.5 px-2 text-[11px] text-ink-400" title="Live connection to the dashboard server">
              <span
                className={`h-1.5 w-1.5 rounded-full ${connection === "open" ? "bg-emerald-400" : connection === "lost" ? "bg-red-400" : "bg-amber-400"}`}
              />
              {connection === "open" ? "Live" : connection === "lost" ? "Reconnecting…" : "Connecting…"}
            </p>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
        <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
      </div>
    </NewProjectContext.Provider>
  );
}
