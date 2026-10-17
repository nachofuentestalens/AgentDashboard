import { Fragment, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { resolveChoice, type Message, type Run, type TaskDetail } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Composer } from "../components/Composer.tsx";
import { EfficiencyPanel } from "../components/EfficiencyPanel.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { RunView } from "../components/RunView.tsx";
import { StageActions } from "../components/StageActions.tsx";
import { Button, ErrorNote, PriorityBadge, PrioritySelect, selectClass, StageBadge, StatusBadge, Toggle } from "../components/ui.tsx";
import { cost } from "../format.ts";
import { useRoles } from "./ProjectPage.tsx";

// The conversation reads as: each message the developer sent, then the agent's run(s) on it
// (more than one when a run was retried).
function turns(detail: TaskDetail): { message: Message; runs: Run[] }[] {
  return detail.messages.filter((m) => m.role === "user").map((message) => ({ message, runs: detail.runs.filter((r) => r.messageId === message.id) }));
}

export function TaskPage() {
  const { taskId = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: keys.task(taskId), queryFn: () => api.task(taskId) });
  const project = useQuery({
    queryKey: keys.project(detail.data?.task.projectId ?? ""),
    queryFn: () => api.project(detail.data!.task.projectId),
    enabled: !!detail.data,
  });

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateTask>[1]) => api.updateTask(taskId, body),
    onSuccess: (task) => qc.setQueryData<TaskDetail>(keys.task(taskId), (old) => (old ? { ...old, task } : old)),
  });
  const send = useMutation({
    mutationFn: (text: string) => api.send(taskId, text),
    onSuccess: ({ message, run }) =>
      qc.setQueryData<TaskDetail>(keys.task(taskId), (old) =>
        old ? { ...old, messages: [...old.messages, message], runs: old.runs.some((r) => r.id === run.id) ? old.runs : [...old.runs, run] } : old,
      ),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTask(taskId),
    onSuccess: () => void navigate(detail.data ? `/projects/${detail.data.task.projectId}` : "/"),
  });
  const roles = useRoles(detail.data?.task.projectId ?? "");
  const checkpoint = useMutation({
    mutationFn: async () => {
      const active = detail.data?.runs.findLast((r) => r.status === "running" || r.status === "queued");
      if (active) await api.stopRun(active.id);
      else await api.checkpointTask(taskId);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.task(taskId) }),
  });
  const github = useMutation({
    mutationFn: (action: "publish" | "merge") => (action === "publish" ? api.publishTask(taskId) : api.mergeTask(taskId)),
    // Task lists show where each task's changes are.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.task(taskId) });
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // Follow the stream while the reader is at the bottom; leave them alone if they scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  const loaded = !!detail.data;
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const follow = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [loaded]);

  if (detail.error)
    return (
      <div className="p-8">
        <ErrorNote error={detail.error} />
      </div>
    );
  if (!detail.data) return null;
  const { task } = detail.data;
  const running = task.status === "running";
  const busy = running || task.status === "queued";
  const latestRunId = detail.data.runs.at(-1)?.id;
  const totalCost = detail.data.runs.reduce((sum, r) => sum + r.costUsd, 0);
  const role = roles.find((r) => r.role.id === task.roleId);
  const agentName = role?.role.agents.find((a) => a.id === task.agentId)?.name;
  const latestReview = detail.data.reviews?.at(-1);
  const steps = detail.data.steps ?? [];
  const roleName = (id: string) => roles.find((r) => r.role.id === id)?.role.name ?? "removed role";

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-800 px-6 py-3">
        <div className="min-w-0 flex-1">
          {project.data && (
            <Link to={`/projects/${project.data.id}`} className="text-xs text-ink-400 hover:text-ink-200">
              {project.data.name}
            </Link>
          )}
          <input
            aria-label="Task title"
            className="block w-full truncate bg-transparent text-base font-semibold focus:outline-none"
            defaultValue={task.title}
            key={task.title}
            onBlur={(e) => {
              const title = e.target.value.trim();
              if (title && title !== task.title) update.mutate({ title });
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </div>
        {task.roleId && (
          <>
            <span className="text-xs text-ink-300" title="The role, and the agent that last worked on it">
              {role ? `${role.role.name}${agentName && agentName !== role.role.name ? ` · ${agentName}` : ""}` : "Role"}
            </span>
            <PriorityBadge priority={task.priority} emergency={task.emergency} />
            <PrioritySelect value={task.priority} onChange={(priority) => update.mutate({ priority })} />
            <Toggle checked={task.emergency} onChange={(emergency) => update.mutate({ emergency })} label="Emergency" />
            <select
              aria-label="Reviewer"
              className={selectClass}
              value={task.reviewerRoleId ?? ""}
              onChange={(e) => update.mutate({ reviewerRoleId: e.target.value || null })}
              title="Who reviews this task's steps when you ask for a review"
            >
              <option value="">Reviewer: role default</option>
              {roles.map(({ role: r }) => (
                <option key={r.id} value={r.id}>
                  Reviewer: {r.name}
                </option>
              ))}
            </select>
          </>
        )}
        <StatusBadge status={task.status} />
        <span className="text-xs text-ink-400" title="Total cost of this task">
          {cost(totalCost)}
        </span>
        <StageBadge stage={task.stage} />
        {task.stage ? (
          <StageActions task={task} />
        ) : (
          task.status === "done" && (
            <Button variant="ghost" className="text-xs" onClick={() => update.mutate({ done: false })}>
              Reopen
            </Button>
          )
        )}
        <Button
          variant="ghost"
          className="text-xs"
          disabled={busy}
          title={busy ? "Stop the agent first" : "Delete this task"}
          onClick={() => {
            if (confirm("Delete this task and its history?")) remove.mutate();
          }}
        >
          Delete
        </Button>
      </header>
      {(task.canEdit || detail.data.workspace) && (
        <div className="border-b border-ink-800 px-6 py-2 text-xs text-ink-300" aria-label="Task workspace">
          <div className="flex flex-wrap items-center gap-3">
            <span>{detail.data.workspace ? `Isolated branch: ${detail.data.workspace.branch}` : "Writing runs use a separate task worktree."}</span>
            <Button variant="ghost" disabled={checkpoint.isPending || (!busy && !detail.data.workspace)} onClick={() => checkpoint.mutate()}>
              {busy ? "Pause & checkpoint" : "Save checkpoint"}
            </Button>
          </div>
          {detail.data.workspace && (
            <>
              <p className="break-all text-ink-400">{detail.data.workspace.path}</p>
              <p>
                {detail.data.workspace.checkpointCommit
                  ? `Local checkpoint: ${detail.data.workspace.checkpointCommit.slice(0, 8)} · ${detail.data.workspace.checkpointAt}`
                  : "No checkpoint saved yet."}{" "}
                {detail.data.workspace.publishedCommit === detail.data.workspace.checkpointCommit && detail.data.workspace.publishedCommit
                  ? "Checkpoint backed up on GitHub."
                  : "Not published to GitHub."}
              </p>
              {!detail.data.workspace.mergeCommit && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="ghost" disabled={busy || checkpoint.isPending || github.isPending} onClick={() => github.mutate("publish")}>
                    Publish / retry GitHub
                  </Button>
                  {detail.data.workspace.pullRequestUrl && (
                    <>
                      <a className="text-sky-300 underline" href={detail.data.workspace.pullRequestUrl} target="_blank" rel="noreferrer">
                        Open pull request
                      </a>
                      <Button
                        variant="ghost"
                        disabled={busy || checkpoint.isPending || github.isPending || (!!task.roleId && task.stage !== "approved")}
                        onClick={() => github.mutate("merge")}
                      >
                        Merge on GitHub
                      </Button>
                    </>
                  )}
                </div>
              )}
              {detail.data.workspace.mergeCommit && (
                <p>Merged as {detail.data.workspace.mergeCommit.slice(0, 8)}. The running checkout is unchanged; update it when ready to restart.</p>
              )}
              {detail.data.workspace.error && <p className="text-amber-300">{detail.data.workspace.error}</p>}
              {detail.data.workspace.publishError && <p className="text-amber-300">{detail.data.workspace.publishError}</p>}
            </>
          )}
          <ErrorNote error={checkpoint.error} />
          <ErrorNote error={github.error} />
        </div>
      )}
      {task.stage && (task.stepSummary || task.nextStep || task.stepState === "complete") && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-ink-800 px-6 py-2 text-xs text-ink-300" aria-label="Step report">
          {task.stepState === "complete" && <span className="font-semibold text-emerald-300">Agent: complete</span>}
          {task.stepSummary && <span>{task.stepSummary}</span>}
          {task.nextStep && <span className="text-ink-400">Next: {task.nextStep}</span>}
        </div>
      )}
      {steps.length > 0 && (
        <details className="border-b border-ink-800 px-6 py-2 text-xs" aria-label="Plan">
          <summary className="cursor-pointer text-ink-300">
            Plan: step {Math.min(steps.filter((s) => s.state === "done").length + 1, steps.length)} of {steps.length}
            {steps.find((s) => s.state === "active") && <span className="text-ink-400"> · {steps.find((s) => s.state === "active")!.title}</span>}
          </summary>
          <ol className="mt-1 space-y-0.5 pl-1">
            {steps.map((s) => (
              <li key={s.id} className={s.state === "done" ? "text-ink-400" : s.state === "active" ? "text-ink-100" : "text-ink-300"}>
                {s.state === "done" ? "✓" : s.state === "active" ? "▸" : "·"} {s.title}
                {s.summary && <span className="text-ink-400"> · {s.summary}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {latestReview && (
        <details className="border-b border-ink-800 px-6 py-2 text-xs" aria-label="Latest review">
          <summary className="cursor-pointer text-ink-300">
            <span className={latestReview.verdict === "changes" ? "font-semibold text-amber-300" : "font-semibold text-emerald-300"}>
              {latestReview.reviewer === "owner" ? "Your review" : `Agent review (${roleName(latestReview.reviewer)})`}:{" "}
              {{ pass: "passed", changes: "changes requested", approved: "approved" }[latestReview.verdict]}
            </span>
            {latestReview.findings.length > 0 && ` · ${latestReview.findings.length} finding${latestReview.findings.length === 1 ? "" : "s"}`}
            {(detail.data.reviews?.length ?? 0) > 1 && ` · ${detail.data.reviews!.length} reviews in all`}
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-200">
            {latestReview.findings.map((f, i) => (
              <li key={i} className="font-mono">
                {f}
              </li>
            ))}
          </ul>
        </details>
      )}
      <EfficiencyPanel key={task.id} detail={detail.data} />

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div ref={content} className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {turns(detail.data).map(({ message, runs }) => (
            <Fragment key={message.id}>
              <div className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-ink-800 px-4 py-3 text-sm">
                <Markdown text={message.text} />
              </div>
              {runs.map((run) => (
                <div key={run.id} className="border-l-2 border-ink-800 pl-4 text-sm">
                  <RunView run={run} isLatest={run.id === latestRunId} />
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-6 pb-5">
        {task.status === "waiting" && task.question && (
          <div className="mb-2 rounded-xl border border-gold/40 bg-gold/10 px-4 py-3 text-sm">
            <p className="text-xs font-semibold text-gold">The agent is waiting for your answer</p>
            <div className="mt-1 text-ink-100">
              <Markdown text={task.question} />
            </div>
            <p className="mt-1 text-xs text-ink-400">
              Reply below, or answer from the{" "}
              <Link to="/inbox" className="text-accent underline">
                Inbox
              </Link>{" "}
              to record it in decisions.md.
            </p>
          </div>
        )}
        <ErrorNote error={send.error ?? update.error ?? remove.error} />
        <Composer
          placeholder={
            running
              ? "The agent is working. You can type your next message meanwhile."
              : task.status === "queued"
                ? "Queued for an agent. You can type your next message meanwhile."
                : task.stage === "needs_review"
                  ? task.nextStep
                    ? `Continue with: ${task.nextStep}`
                    : "Ask for changes, or say what to do next…"
                  : task.stage === "changes_requested"
                    ? "Describe the fix, or use Fix to send the review findings…"
                    : "Reply to the agent…"
          }
          disabled={busy}
          busy={send.isPending || update.isPending}
          onSend={(text) => {
            pinned.current = true;
            return send.mutateAsync(text);
          }}
          footer={
            <>
              <Toggle
                checked={task.canEdit}
                onChange={(canEdit) => update.mutate({ canEdit })}
                label="Can edit files"
                hint="Off: the agent can only read and investigate."
              />
              {project.data && (
                <ModelPicker
                  provider={task.provider}
                  disabled={busy || update.isPending}
                  model={task.model}
                  effort={task.effort}
                  defaults={resolveChoice([
                    { provider: role?.role.provider ?? null, model: role?.role.model ?? null, effort: role?.role.effort ?? null },
                    { provider: project.data.defaultProvider, model: project.data.defaultModel, effort: project.data.defaultEffort },
                  ])}
                  onChange={(choice) => update.mutate(choice)}
                />
              )}
            </>
          }
        />
      </div>
    </div>
  );
}
