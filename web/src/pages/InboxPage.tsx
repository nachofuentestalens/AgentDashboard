import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { lineDiff, type Handoff, type Inbox, type InboxQuestion, type InboxRun } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Markdown } from "../components/Markdown.tsx";
import { StageActions } from "../components/StageActions.tsx";
import { Button, ErrorNote, inputClass, PriorityBadge, PrioritySelect, Toggle } from "../components/ui.tsx";
import { useDraft } from "../drafts.ts";
import { ago } from "../format.ts";
import { RoleSelect } from "./ProjectPage.tsx";

const card = "rounded-xl border border-ink-800 bg-ink-900/60 p-4 space-y-3";

export function InboxPage() {
  const inbox = useQuery({ queryKey: keys.inbox, queryFn: api.inbox });
  const data = inbox.data;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-8 py-8">
        <div>
          <h1 className="text-xl font-semibold">Inbox</h1>
          <p className="mt-1 text-sm text-ink-400">What the studio is waiting on you for, across projects.</p>
        </div>
        <ErrorNote error={inbox.error} />
        {data && data.count === 0 && <p className="text-sm text-ink-300">Nothing is waiting on you.</p>}
        {data && data.questions.length > 0 && (
          <Section title="Questions">
            {data.questions.map((q) => (
              <QuestionCard key={q.task.id} q={q} />
            ))}
          </Section>
        )}
        {data && data.reviews.length > 0 && (
          <Section title="Ready for review">
            {data.reviews.map((r) => (
              <StageCard key={r.task.id} item={r} />
            ))}
          </Section>
        )}
        {data && data.changes.length > 0 && (
          <Section title="Changes requested">
            {data.changes.map((r) => (
              <StageCard key={r.task.id} item={r} />
            ))}
          </Section>
        )}
        {data && data.proposals.length > 0 && (
          <Section title="Design proposals">
            {data.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))}
          </Section>
        )}
        {data && data.handoffs.length > 0 && (
          <Section title="Task requests">
            {data.handoffs.map((h) => (
              <HandoffCard key={h.id} h={h} />
            ))}
          </Section>
        )}
        {data && data.blocked.length > 0 && (
          <Section title="Blocked on the baseline">
            {data.blocked.map((h) => (
              <BlockedCard key={h.run.id} h={h} />
            ))}
          </Section>
        )}
        {data && data.held.length > 0 && (
          <Section title="Held by a budget or an emergency">
            {data.held.map((h) => (
              <HeldCard key={h.run.id} h={h} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-200">{title}</h2>
      {children}
    </section>
  );
}

function From({ project, task, taskId, role }: { project: string; task?: string; taskId?: string | null; role?: string | null }) {
  return (
    <p className="text-xs text-ink-400">
      {project}
      {role && ` · ${role}`}
      {task && taskId && (
        <>
          {" · "}
          <Link to={`/tasks/${taskId}`} className="text-accent underline">
            {task}
          </Link>
        </>
      )}
    </p>
  );
}

function QuestionCard({ q }: { q: InboxQuestion }) {
  const [text, setText] = useDraft(`answer:${q.task.id}`);
  const [record, setRecord] = useState(true);
  const answer = useMutation({ mutationFn: () => api.answer(q.task.id, text.trim(), record), onSuccess: () => setText("") });
  return (
    <article className={card} aria-label={`Question from ${q.task.title}`}>
      <From project={q.projectName} task={q.task.title} taskId={q.task.id} />
      <div className="text-sm">
        <Markdown text={q.task.question ?? ""} />
      </div>
      <textarea aria-label="Answer" className={`${inputClass} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" />
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!text.trim() || answer.isPending} onClick={() => answer.mutate()}>
          Answer
        </Button>
        <Toggle checked={record} onChange={setRecord} label="Record in decisions.md" />
      </div>
      <ErrorNote error={answer.error} />
    </article>
  );
}

function StageCard({ item }: { item: InboxQuestion }) {
  const { task } = item;
  return (
    <article className={card} aria-label={`Review: ${task.title}`}>
      <div className="flex items-center gap-2">
        <PriorityBadge priority={task.priority} emergency={task.emergency} />
        <Link to={`/tasks/${task.id}`} className="text-sm font-medium text-ink-100 hover:underline">
          {task.title}
        </Link>
        {task.stepState === "complete" && <span className="text-[10px] font-semibold text-emerald-300 uppercase">Agent: complete</span>}
        <span className="ml-auto text-xs text-ink-400">{item.projectName}</span>
      </div>
      {task.stepSummary && <p className="text-sm text-ink-200">{task.stepSummary}</p>}
      {task.nextStep && <p className="text-xs text-ink-400">Next: {task.nextStep}</p>}
      <StageActions task={task} />
    </article>
  );
}

function ProposalCard({ p }: { p: Inbox["proposals"][number] }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(p.body);
  const [reason, setReason] = useState("");
  const accept = useMutation({ mutationFn: () => api.acceptProposal(p.id, editing ? body : undefined) });
  const reject = useMutation({ mutationFn: () => api.rejectProposal(p.id, reason.trim() || undefined) });
  const diff = useMemo(() => lineDiff(p.current ?? "", editing ? body : p.body), [p.current, p.body, body, editing]);
  return (
    <article className={card} aria-label={`Proposal for ${p.docPath}`}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ink-100">{p.docPath}</span>
        {p.current === null && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300 uppercase">new</span>}
        <span className="ml-auto text-xs text-ink-400">{ago(p.createdAt)}</span>
      </div>
      <From project={p.projectName} role={p.roleName} task="from this task" taskId={p.taskId} />
      {p.rationale && <p className="text-sm text-ink-200">{p.rationale}</p>}
      {editing ? (
        <textarea aria-label="Proposed content" className={`${inputClass} min-h-64 font-mono text-xs`} value={body} onChange={(e) => setBody(e.target.value)} />
      ) : (
        <pre className="max-h-96 overflow-auto rounded-md border border-ink-700 bg-ink-950 p-2 font-mono text-xs leading-relaxed">
          {diff.map((line, i) => (
            <div
              key={i}
              className={
                line.type === "add" ? "bg-emerald-500/10 text-emerald-200" : line.type === "del" ? "bg-red-500/10 text-red-300 line-through" : "text-ink-400"
              }
            >
              {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
              {line.text || " "}
            </div>
          ))}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => accept.mutate()} disabled={accept.isPending}>
          {editing ? "Accept my version" : "Accept"}
        </Button>
        <Button onClick={() => setEditing(!editing)}>{editing ? "Show diff" : "Edit"}</Button>
        <input
          aria-label="Rejection reason"
          className={`${inputClass} !w-64`}
          placeholder="Why not? (sent to the agent)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button variant="danger" onClick={() => reject.mutate()} disabled={reject.isPending}>
          Reject
        </Button>
      </div>
      {accept.data?.commitError && <ErrorNote error={new Error(`Saved, but the commit failed: ${accept.data.commitError}`)} />}
      <ErrorNote error={accept.error ?? reject.error} />
    </article>
  );
}

function HandoffCard({ h }: { h: Handoff & { projectName: string } }) {
  const [roleId, setRoleId] = useState(h.roleId ?? "");
  const [priority, setPriority] = useState(h.priority);
  const approve = useMutation({ mutationFn: () => api.approveHandoff(h.id, { roleId: roleId || undefined, priority }) });
  const reject = useMutation({ mutationFn: () => api.rejectHandoff(h.id) });
  return (
    <article className={card} aria-label={`Task request: ${h.title}`}>
      <div className="flex items-center gap-2">
        <PriorityBadge priority={h.priority} emergency={h.emergency} />
        <span className="text-sm font-medium text-ink-100">{h.title}</span>
        <span className="text-xs text-ink-400">for {h.toRoleName}</span>
        <span className="ml-auto text-xs text-ink-400">{ago(h.createdAt)}</span>
      </div>
      <From project={h.projectName} role={h.fromRoleName ? `asked by ${h.fromRoleName}` : null} task="from this task" taskId={h.fromTaskId} />
      {h.reason && <p className="text-xs text-gold">{h.reason}</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-xs text-ink-400">Instructions</summary>
        <div className="mt-2">
          <Markdown text={h.prompt} />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <RoleSelect projectId={h.projectId} value={roleId} onChange={setRoleId} none={h.roleId ? undefined : "Pick a role"} />
        <PrioritySelect value={priority} onChange={setPriority} />
        <Button variant="primary" disabled={approve.isPending || (!roleId && !h.roleId)} onClick={() => approve.mutate()}>
          Create task
        </Button>
        <Button variant="danger" onClick={() => reject.mutate()} disabled={reject.isPending}>
          Reject
        </Button>
      </div>
      <ErrorNote error={approve.error ?? reject.error} />
    </article>
  );
}

function BlockedCard({ h }: { h: InboxRun }) {
  const stop = useMutation({ mutationFn: () => api.stopRun(h.run.id) });
  return (
    <article className={card} aria-label={`Blocked: ${h.task.title}`}>
      <div className="flex items-center gap-2">
        <PriorityBadge priority={h.task.priority} emergency={h.task.emergency} />
        <Link to={`/tasks/${h.task.id}`} className="text-sm font-medium text-ink-100 hover:underline">
          {h.task.title}
        </Link>
        <span className="ml-auto text-xs text-ink-400">{h.projectName}</span>
      </div>
      <p className="text-xs text-gold">{h.run.waitReason}</p>
      <div className="flex items-center gap-2">
        <Link to={`/projects/${h.task.projectId}`} className="text-xs text-accent underline">
          Open Delivery &amp; baseline
        </Link>
        <Button onClick={() => stop.mutate()} disabled={stop.isPending}>
          Take out of the queue
        </Button>
      </div>
      <ErrorNote error={stop.error} />
    </article>
  );
}

function HeldCard({ h }: { h: InboxRun }) {
  const force = useMutation({ mutationFn: () => api.forceRun(h.run.id) });
  const stop = useMutation({ mutationFn: () => api.stopRun(h.run.id) });
  return (
    <article className={card} aria-label={`Held: ${h.task.title}`}>
      <div className="flex items-center gap-2">
        <PriorityBadge priority={h.task.priority} emergency={h.task.emergency} />
        <Link to={`/tasks/${h.task.id}`} className="text-sm font-medium text-ink-100 hover:underline">
          {h.task.title}
        </Link>
        <span className="ml-auto text-xs text-ink-400">{h.projectName}</span>
      </div>
      <p className="text-xs text-gold">{h.run.waitReason}</p>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => force.mutate()} disabled={force.isPending}>
          Run anyway
        </Button>
        <Button onClick={() => stop.mutate()} disabled={stop.isPending}>
          Take out of the queue
        </Button>
      </div>
      <ErrorNote error={force.error ?? stop.error} />
    </article>
  );
}
