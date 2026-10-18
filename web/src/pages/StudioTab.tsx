import { useModelCatalog } from "../models.ts";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  PROVIDERS,
  PROVIDER_EFFORTS,
  type Provider,
  type AgentView,
  type DepartmentView,
  type Effort,
  type Project,
  type RoleView,
  type UpdateDepartmentBody,
  type UpdateRoleBody,
} from "@ad/shared";
import { api, keys } from "../api.ts";
import { useStoredDraft } from "../drafts.ts";
import { Button, Dialog, ErrorNote, Field, inputClass, selectClass, Toggle } from "../components/ui.tsx";
import { cost, modelLabel } from "../format.ts";

const agentDot: Record<AgentView["status"], string> = {
  idle: "bg-ink-400",
  running: "bg-accent animate-pulse",
  waiting: "bg-gold",
  paused: "bg-ink-600",
};

export function StudioTab({ project }: { project: Project }) {
  const studio = useQuery({ queryKey: keys.studio(project.id), queryFn: () => api.studio(project.id) });
  const template = useMutation({ mutationFn: () => api.applyTemplate(project.id) });
  const addDept = useMutation({ mutationFn: (name: string) => api.createDepartment(project.id, { name }) });
  const [editing, setEditing] = useState<{ role: RoleView | null; departmentId: string } | null>(null);

  if (studio.error) return <ErrorNote error={studio.error} />;
  if (!studio.data) return null;
  const { departments, emergencies } = studio.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-8 py-6">
      {emergencies.length > 0 && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <p className="font-semibold">⚠ Emergency open: other role tasks in this project wait until it is done.</p>
          <ul className="mt-1 list-disc pl-5">
            {emergencies.map((e) => (
              <li key={e.taskId}>
                <Link to={`/tasks/${e.taskId}`} className="underline">
                  {e.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {departments.length === 0 ? (
        <div className="rounded-xl border border-ink-800 bg-ink-900 p-6 text-sm text-ink-300">
          <h2 className="text-base font-semibold text-ink-100">Staff this project like a studio</h2>
          <p className="mt-2">
            Departments own folders of the repository and share compute by weight. Roles inside them are job descriptions with their own model and effort;
            agents staff the roles and pick up tasks by priority. Only one agent per department edits files at a time.
          </p>
          <p className="mt-2">
            The <strong>Small indie studio</strong> template sets up Leadership (CTO, Game Director), Engineering (Gameplay Programmer), Design (Systems
            Designer) and QA (QA Tester). Everything stays editable.
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={() => template.mutate()} disabled={template.isPending}>
              Apply the Small indie studio template
            </Button>
            <Button onClick={() => addDept.mutate("New department")}>Start empty</Button>
          </div>
          <ErrorNote error={template.error ?? addDept.error} />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {departments.map((d) => (
              <DepartmentCard key={d.id} dept={d} onEditRole={(role) => setEditing({ role, departmentId: d.id })} />
            ))}
          </div>
          <Button onClick={() => addDept.mutate("New department")} disabled={addDept.isPending}>
            + Add department
          </Button>
          <ErrorNote error={addDept.error} />
        </>
      )}

      {editing && (
        <RoleEditor project={project} departments={departments} role={editing.role} departmentId={editing.departmentId} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function DepartmentCard({ dept, onEditRole }: { dept: DepartmentView; onEditRole: (role: RoleView | null) => void }) {
  const update = useMutation({ mutationFn: (body: UpdateDepartmentBody) => api.updateDepartment(dept.id, body) });
  const remove = useMutation({ mutationFn: () => api.deleteDepartment(dept.id) });
  const [weight, setWeight] = useState(dept.weight);
  const over = dept.dailyBudgetUsd !== null && dept.spend24h >= dept.dailyBudgetUsd;

  return (
    <section aria-label={`${dept.name} department`} className="rounded-xl border border-ink-800 bg-ink-900/60">
      <header className="space-y-3 border-b border-ink-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Color"
            className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
            defaultValue={dept.color}
            onBlur={(e) => e.target.value !== dept.color && update.mutate({ color: e.target.value })}
          />
          <input
            aria-label="Department name"
            className="min-w-0 flex-1 bg-transparent text-base font-semibold focus:outline-none"
            defaultValue={dept.name}
            key={dept.name}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== dept.name && update.mutate({ name: e.target.value.trim() })}
          />
          <span className="text-xs text-ink-400" title="Spend over the last 24 hours, and the last 7 days">
            {cost(dept.spend24h)} today · {cost(dept.spend7d)} this week
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-ink-300">
          <label className="flex items-center gap-2" title="Share of compute relative to other departments">
            Compute weight
            <input
              type="range"
              min={1}
              max={10}
              value={weight}
              aria-label={`${dept.name} compute weight`}
              className="flex-1 accent-[var(--color-accent)]"
              onChange={(e) => setWeight(Number(e.target.value))}
              onPointerUp={() => weight !== dept.weight && update.mutate({ weight })}
              onKeyUp={() => weight !== dept.weight && update.mutate({ weight })}
            />
            <span className="w-4 text-right font-mono text-ink-100">{weight}</span>
          </label>
          <label className="flex items-center gap-2">
            Daily budget $
            <input
              aria-label={`${dept.name} daily budget`}
              className={`${selectClass} w-20`}
              placeholder="none"
              inputMode="decimal"
              defaultValue={dept.dailyBudgetUsd ?? ""}
              key={String(dept.dailyBudgetUsd)}
              onBlur={(e) => {
                const v = e.target.value.trim();
                const next = v === "" ? null : Number(v);
                if (next !== dept.dailyBudgetUsd && (next === null || Number.isFinite(next))) update.mutate({ dailyBudgetUsd: next });
              }}
            />
            {over && <span className="text-red-300">reached</span>}
          </label>
          <label
            className="flex items-center gap-2"
            title='Repository folders this department may edit, comma separated. "." means everything other departments do not own.'
          >
            Folders
            <input
              aria-label={`${dept.name} folders`}
              className={`${selectClass} flex-1 font-mono`}
              defaultValue={dept.folders.join(", ")}
              key={dept.folders.join(",")}
              onBlur={(e) => {
                const folders = e.target.value
                  .split(",")
                  .map((f) => f.trim())
                  .filter(Boolean);
                if (folders.length && folders.join(",") !== dept.folders.join(",")) update.mutate({ folders });
              }}
            />
          </label>
          <label className="flex items-center gap-2" title="Tasks this department's agents create for others">
            Tasks it creates
            <select
              aria-label={`${dept.name} autonomy`}
              className={selectClass}
              value={dept.autonomy}
              onChange={(e) => update.mutate({ autonomy: e.target.value as "ask" | "auto" })}
            >
              <option value="auto">start right away</option>
              <option value="ask">wait for my approval</option>
            </select>
          </label>
        </div>
        <p className="text-xs text-ink-400">
          {dept.writerRunId ? <span className="text-accent">One agent is editing files now; other writers here wait.</span> : "Nobody is editing files."}
        </p>
        <ErrorNote error={update.error ?? remove.error} />
      </header>

      <ul className="divide-y divide-ink-800">
        {dept.roles.map((role) => (
          <RoleRow key={role.id} role={role} onEdit={() => onEditRole(role)} />
        ))}
      </ul>
      <footer className="flex items-center gap-2 px-4 py-2">
        <Button variant="ghost" className="text-xs" onClick={() => onEditRole(null)}>
          + Add role
        </Button>
        {dept.roles.length === 0 && (
          <Button variant="ghost" className="ml-auto text-xs" onClick={() => confirm(`Remove ${dept.name}?`) && remove.mutate()}>
            Remove department
          </Button>
        )}
      </footer>
    </section>
  );
}

function RoleRow({ role, onEdit }: { role: RoleView; onEdit: () => void }) {
  const hire = useMutation({ mutationFn: () => api.hire(role.id) });
  return (
    <li className="space-y-2 px-4 py-3" aria-label={`${role.name} role`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink-100">{role.name}</span>
        <span className="text-xs text-ink-400">
          {role.model ? modelLabel(role.model) : "Project model"} · {role.effort ?? "project effort"}
        </span>
        {!role.canEdit && <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 uppercase">read-only</span>}
        {role.queued > 0 && <span className="text-xs text-sky-300">{role.queued} queued</span>}
        <span className="ml-auto text-xs text-ink-400">{cost(role.spend24h)} today</span>
        <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={onEdit}>
          Edit
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {role.agents.map((agent) => (
          <AgentChip key={agent.id} agent={agent} />
        ))}
        {role.agents.length === 0 && <span className="text-xs text-ink-400">No agents: tasks for this role wait.</span>}
        <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => hire.mutate()} disabled={hire.isPending} aria-label={`Hire a ${role.name}`}>
          + Hire
        </Button>
      </div>
      <ErrorNote error={hire.error} />
    </li>
  );
}

function AgentChip({ agent }: { agent: AgentView }) {
  const pause = useMutation({ mutationFn: () => api.updateAgent(agent.id, { paused: !agent.paused }) });
  const remove = useMutation({ mutationFn: () => api.removeAgent(agent.id) });
  const label: Record<AgentView["status"], string> = { idle: "idle", running: "working", waiting: "waiting on you", paused: "paused" };
  return (
    <span
      className="group inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 py-0.5 pr-1 pl-2 text-xs text-ink-200"
      title={`${agent.name}: ${label[agent.status]}${agent.taskTitle ? ` on "${agent.taskTitle}"` : ""} · ${cost(agent.spend24h)} today${remove.error ? ` · ${(remove.error as Error).message}` : ""}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${agentDot[agent.status]}`} />
      {agent.taskId ? (
        <Link to={`/tasks/${agent.taskId}`} className="hover:underline">
          {agent.name}
        </Link>
      ) : (
        agent.name
      )}
      <button
        className="rounded px-1 text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        aria-label={`${agent.paused ? "Resume" : "Pause"} ${agent.name}`}
        onClick={() => pause.mutate()}
      >
        {agent.paused ? "▶" : "⏸"}
      </button>
      <button
        className="rounded px-1 text-ink-400 hover:bg-ink-700 hover:text-red-300"
        aria-label={`Remove ${agent.name}`}
        onClick={() => confirm(`Remove ${agent.name}? Its history stays.`) && remove.mutate()}
      >
        ×
      </button>
    </span>
  );
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

type RoleForm = {
  name: string;
  dept: string;
  provider: Provider | "";
  model: string;
  effort: Effort | "";
  canEdit: boolean;
  tools: string;
  docs: string;
  brief: string;
  reviewer: string;
};

function RoleEditor({
  project,
  departments,
  role,
  departmentId,
  onClose,
}: {
  project: Project;
  departments: DepartmentView[];
  role: RoleView | null;
  departmentId: string;
  onClose: () => void;
}) {
  const catalog = useModelCatalog();
  // Closing the dialog (Escape, a click outside, leaving the tab) keeps the edits; Cancel, save and remove drop them.
  const [stored, setStored] = useStoredDraft<RoleForm>(role ? `role:${role.id}` : `role-new:${departmentId}`);
  const [restored] = useState(stored !== null);
  const form: RoleForm = stored ?? {
    name: role?.name ?? "",
    dept: role?.departmentId ?? departmentId,
    provider: role?.provider ?? "",
    model: role?.model ?? "",
    effort: role?.effort ?? "",
    canEdit: role?.canEdit ?? true,
    tools: role?.allowedTools?.join("\n") ?? "",
    docs: role?.contextDocs.join("\n") ?? "",
    brief: role?.brief ?? "",
    reviewer: role?.reviewerRoleId ?? "",
  };
  const { name, dept, provider, model, effort, canEdit, tools, docs, brief, reviewer } = form;
  const set = (patch: Partial<RoleForm>) => setStored({ ...form, ...patch });
  const setName = (v: string) => set({ name: v });
  const setDept = (v: string) => set({ dept: v });
  const setModel = (v: string) => set({ model: v });
  const setEffort = (v: Effort | "") => set({ effort: v });
  const setCanEdit = (v: boolean) => set({ canEdit: v });
  const setTools = (v: string) => set({ tools: v });
  const setDocs = (v: string) => set({ docs: v });
  const setBrief = (v: string) => set({ brief: v });
  const setReviewer = (v: string) => set({ reviewer: v });
  const finish = () => {
    setStored(null);
    onClose();
  };

  const body = (): UpdateRoleBody => ({
    reviewerRoleId: reviewer || null,
    name: name.trim(),
    departmentId: dept,
    provider: provider || null,
    model: model.trim() || null,
    effort: effort || null,
    canEdit,
    allowedTools: tools.trim() ? lines(tools) : null,
    contextDocs: lines(docs),
    brief,
  });
  const save = useMutation({
    mutationFn: () => (role ? api.updateRole(role.id, body()) : api.createRole(project.id, { ...body(), departmentId: dept, name: name.trim() })),
    onSuccess: finish,
  });
  const remove = useMutation({ mutationFn: () => api.deleteRole(role!.id), onSuccess: finish });
  const effortCost = (level: Effort): ReactNode => {
    const c = role?.costByEffort[level];
    return c ? ` · avg ${cost(c.avgUsd)}/task over ${c.runs}` : "";
  };

  return (
    <Dialog open onClose={onClose} title={role ? `Edit ${role.name}` : "Add a role"}>
      <form
        className="max-h-[75vh] space-y-4 overflow-y-auto pr-1"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {restored && stored && (
          <p className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            Restored your unsaved changes.
            <Button variant="ghost" className="ml-auto !px-2 !py-0.5 text-xs" onClick={() => setStored(null)}>
              Discard them
            </Button>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="Agents use this exact name to ask this role for work.">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Department">
            <select className={inputClass} value={dept} onChange={(e) => setDept(e.target.value)}>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Provider">
            <select
              aria-label="Role provider"
              className={inputClass}
              value={provider}
              onChange={(e) => set({ provider: e.target.value as Provider | "", model: "", effort: "" })}
            >
              <option value="">Project default</option>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select aria-label="Role model" className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Project default ({modelLabel(project.defaultModel)})</option>
              {catalog.presets[provider || project.defaultProvider].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {model && !catalog.presets[provider || project.defaultProvider].some((m) => m.id === model) && <option value={model}>{model}</option>}
            </select>
          </Field>
          <Field label="Effort" hint="Higher effort thinks longer and costs more; use it for decisions that matter.">
            <select aria-label="Role effort" className={inputClass} value={effort} onChange={(e) => setEffort(e.target.value as Effort | "")}>
              <option value="">Project default ({project.defaultEffort})</option>
              {PROVIDER_EFFORTS[provider || project.defaultProvider].map((level) => (
                <option key={level} value={level}>
                  {level}
                  {effortCost(level)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reviewer" hint="Who reviews this role's steps when you ask for a review. Tasks can override it.">
            <select aria-label="Role reviewer" className={inputClass} value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">The same role, in a fresh session</option>
              {departments.flatMap((d) =>
                d.roles
                  .filter((r) => r.id !== role?.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({d.name})
                    </option>
                  )),
              )}
            </select>
          </Field>
        </div>
        <Toggle checked={canEdit} onChange={setCanEdit} label="Can edit files in its department's folders" />
        <Field label="Job description" hint="What the role is responsible for, which documents it owns, what it must escalate and to whom.">
          <textarea className={`${inputClass} min-h-48 font-mono text-xs`} value={brief} onChange={(e) => setBrief(e.target.value)} />
        </Field>
        <Field label="Always-read documents" hint="Design documents included in full in every task, one path per line, e.g. design/studio/tech-stack.md.">
          <textarea className={`${inputClass} min-h-16 font-mono text-xs`} value={docs} onChange={(e) => setDocs(e.target.value)} />
        </Field>
        <Field label="Allowed commands" hint="One rule per line. Empty: the project's allowed commands.">
          <textarea
            className={`${inputClass} min-h-16 font-mono text-xs`}
            value={tools}
            placeholder={project.allowedTools.join("\n")}
            onChange={(e) => setTools(e.target.value)}
          />
        </Field>
        <ErrorNote error={save.error ?? remove.error} />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()}>
            {role ? "Save role" : "Add role"}
          </Button>
          <Button onClick={() => (!stored || confirm("Discard your unsaved changes?")) && finish()}>Cancel</Button>
          {role && (
            <Button variant="danger" className="ml-auto" onClick={() => confirm(`Remove the ${role.name} role and its agents?`) && remove.mutate()}>
              Remove role
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
