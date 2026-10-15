import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { DEFAULT_ALLOWED_TOOLS, EFFORT_LEVELS, MODEL_PRESETS, type Effort, type Project } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass } from "../components/ui.tsx";

export function ProjectSettings({ project }: { project: Project }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [model, setModel] = useState(project.defaultModel);
  const [effort, setEffort] = useState<Effort>(project.defaultEffort);
  const [tools, setTools] = useState(project.allowedTools.join("\n"));

  const save = useMutation({
    mutationFn: () =>
      api.updateProject(project.id, {
        name,
        repoPath,
        defaultModel: model,
        defaultEffort: effort,
        allowedTools: tools
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    onSuccess: (p) => qc.setQueryData(keys.project(p.id), p),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => void navigate("/"),
  });

  return (
    <form
      className="mx-auto max-w-2xl space-y-5 px-8 py-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Repository folder">
        <input className={`${inputClass} font-mono`} value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Default model" hint="Any Claude model id works here.">
          <input className={`${inputClass} font-mono`} list="model-presets" value={model} onChange={(e) => setModel(e.target.value)} />
          <datalist id="model-presets">
            {MODEL_PRESETS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Default effort">
          <select className={inputClass} value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
            {EFFORT_LEVELS.map((level) => (
              <option key={level}>{level}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Allowed commands"
        hint={
          <>
            One rule per line, e.g. <code className="font-mono">Bash(git:*)</code>. Agents that can edit files may run only these without asking; anything else
            is refused.{" "}
            <button type="button" className="text-accent underline" onClick={() => setTools(DEFAULT_ALLOWED_TOOLS.join("\n"))}>
              Reset to defaults
            </button>
          </>
        }
      >
        <textarea className={`${inputClass} min-h-36 font-mono`} value={tools} onChange={(e) => setTools(e.target.value)} />
      </Field>
      <ErrorNote error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          Save
        </Button>
        {save.isSuccess && <span className="text-sm text-emerald-300">Saved.</span>}
      </div>

      <div className="mt-10 rounded-xl border border-red-500/20 p-4">
        <h3 className="text-sm font-semibold text-red-300">Delete project</h3>
        <p className="mt-1 text-xs text-ink-400">Removes the project, its tasks and run history from the dashboard. The repository folder is not touched.</p>
        <ErrorNote error={remove.error} />
        <Button
          variant="danger"
          className="mt-3"
          onClick={() => {
            if (confirm(`Delete "${project.name}" and all its tasks from the dashboard?`)) remove.mutate();
          }}
        >
          Delete project
        </Button>
      </div>
    </form>
  );
}
