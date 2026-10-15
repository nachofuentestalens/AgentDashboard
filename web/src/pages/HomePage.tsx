import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, keys } from "../api.ts";
import { Button } from "../components/ui.tsx";
import { useOpenNewProject } from "../newProject.ts";

export function HomePage() {
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects });
  const openNewProject = useOpenNewProject();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-12">
        <h1 className="text-2xl font-semibold">Your game projects</h1>
        <p className="mt-2 text-sm text-ink-300">Each project points at a game's git repository. Start chats with agents that work inside it.</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {projects.data?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="rounded-xl border border-ink-800 bg-ink-900 p-4 hover:border-ink-600">
              <div className="font-medium">{p.name}</div>
              <div className="mt-1 truncate font-mono text-xs text-ink-400">{p.repoPath}</div>
            </Link>
          ))}
          <button
            onClick={() => openNewProject()}
            className="rounded-xl border border-dashed border-ink-700 p-4 text-left text-sm text-ink-300 hover:border-accent hover:text-ink-100"
          >
            + New project
          </button>
        </div>
        {projects.data?.length === 0 && (
          <div className="mt-10 rounded-xl border border-ink-800 bg-ink-900 p-5 text-sm text-ink-300">
            <p className="font-medium text-ink-100">Getting started</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                Open{" "}
                <Link to="/settings" className="text-accent underline">
                  Settings
                </Link>{" "}
                and check that Claude Code is found.
              </li>
              <li>Create a project and point it at your game's repository folder (or an empty folder: the dashboard can run git init).</li>
              <li>Start a chat from the project's Tasks tab, or staff its Studio tab with roles and give them tasks.</li>
            </ol>
            <Button variant="primary" className="mt-4" onClick={() => openNewProject()}>
              Create your first project
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
