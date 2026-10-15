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
import { Button, ErrorNote, PriorityBadge, PrioritySelect, StatusBadge, Toggle } from "../components/ui.tsx";
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
          </>
        )}
        <StatusBadge status={task.status} />
        <span className="text-xs text-ink-400" title="Total cost of this task">
          {cost(totalCost)}
        </span>
        {task.status === "done" ? (
          <Button variant="ghost" className="text-xs" onClick={() => update.mutate({ done: false })}>
            Reopen
          </Button>
        ) : (
          task.roleId && (
            <Button variant="ghost" className="text-xs" disabled={busy} onClick={() => update.mutate({ done: true })} title="Nothing more to do here">
              Mark done
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
