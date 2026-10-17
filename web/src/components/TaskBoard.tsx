import type { ReactNode } from "react";
import { Link } from "react-router";
import type { TaskSummary } from "@ad/shared";
import { ago, cost } from "../format.ts";
import { StageActions } from "./StageActions.tsx";
import { GitBadge, PriorityBadge, StageBadge, StatusBadge } from "./ui.tsx";

type Group = "needsYou" | "working" | "upNext" | "approved" | "closed" | "chats" | "chatsDone";

// Whose move it is. Display only: the stage itself is decided on the server.
function groupOf(t: TaskSummary): Group {
  // A chat is finished once the owner marks it done or its changes are merged.
  if (!t.roleId || !t.stage) return t.status === "done" || t.git === "merged" ? "chatsDone" : "chats";
  if (t.status === "running" || t.status === "queued") return "working";
  if (t.stage === "closed") return "closed";
  if (t.stage === "approved") return "approved";
  if (t.stage === "backlog") return "upNext";
  // needs_review, changes_requested, and anything stopped, failed or waiting on a question.
  return "needsYou";
}

const since = (t: TaskSummary) => t.stageChangedAt ?? t.updatedAt;

export function groupTasks(tasks: TaskSummary[]): Record<Group, TaskSummary[]> {
  const groups: Record<Group, TaskSummary[]> = { needsYou: [], working: [], upNext: [], approved: [], closed: [], chats: [], chatsDone: [] };
  for (const t of tasks) groups[groupOf(t)].push(t);
  groups.needsYou.sort((a, b) => since(a).localeCompare(since(b)));
  groups.upNext.sort((a, b) => Number(b.emergency) - Number(a.emergency) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  return groups;
}

const SECTIONS: { group: Group; title: string; open: boolean }[] = [
  { group: "needsYou", title: "Needs you", open: true },
  { group: "working", title: "Working", open: true },
  { group: "upNext", title: "Up next", open: true },
  { group: "approved", title: "Approved", open: true },
  { group: "closed", title: "Closed", open: false },
  { group: "chats", title: "Chats", open: true },
  { group: "chatsDone", title: "Finished chats", open: false },
];

export function TaskBoard({ tasks, roleName }: { tasks: TaskSummary[]; roleName: (id: string | null) => string | undefined }) {
  const groups = groupTasks(tasks);
  const next = groups.needsYou[0] ?? groups.upNext[0];
  return (
    <div className="space-y-4">
      {next && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/30 bg-gold/5 px-4 py-2" aria-label="Next up">
          <span className="text-xs font-semibold tracking-wide text-gold uppercase">Next up</span>
          <Link to={`/tasks/${next.id}`} className="min-w-0 flex-1 truncate text-sm text-ink-100 hover:underline">
            {next.title}
          </Link>
          <StageBadge stage={next.stage} />
          <StageActions task={next} mainOnly />
        </div>
      )}
      {SECTIONS.map(({ group, title, open }) =>
        groups[group].length === 0 ? null : (
          <details key={group} open={open} className="group">
            <summary className="mb-2 cursor-pointer text-sm font-semibold text-ink-200">
              {title} <span className="font-normal text-ink-400">{groups[group].length}</span>
            </summary>
            <ul className="divide-y divide-ink-800 overflow-hidden rounded-xl border border-ink-800" aria-label={title}>
              {groups[group].map((t, i) => (
                <TaskRow key={t.id} task={t} roleName={roleName} badge={group === "upNext" && i === 0 ? "Next" : null} />
              ))}
            </ul>
          </details>
        ),
      )}
    </div>
  );
}

function TaskRow({ task: t, roleName, badge }: { task: TaskSummary; roleName: (id: string | null) => string | undefined; badge: ReactNode }) {
  const detail = t.status === "waiting" ? t.question : (t.stepSummary ?? t.lastMessage);
  return (
    <li className="flex items-start gap-4 bg-ink-900/40 px-4 py-3 hover:bg-ink-850">
      <Link to={`/tasks/${t.id}`} className="flex min-w-0 flex-1 items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {t.roleId && <PriorityBadge priority={t.priority} emergency={t.emergency} />}
            {badge && <span className="rounded bg-gold/15 px-1.5 py-0.5 text-[10px] font-semibold text-gold uppercase">{badge}</span>}
            <span className="truncate text-sm font-medium text-ink-100">{t.title}</span>
            {!t.canEdit && <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 uppercase">read-only</span>}
            {t.steps && (
              <span className="font-mono text-[10px] text-ink-300" title="Steps of the agent's plan done">
                {t.steps.done}/{t.steps.total}
              </span>
            )}
            {t.stepState === "complete" && <span className="text-[10px] font-semibold text-emerald-300 uppercase">Agent: complete</span>}
            {t.lastReview && t.lastReview.reviewer !== "owner" && t.stage !== "closed" && (
              <span className={`text-[10px] font-semibold uppercase ${t.lastReview.verdict === "pass" ? "text-emerald-300" : "text-amber-300"}`}>
                Agent review: {t.lastReview.verdict === "pass" ? "passed" : "changes"}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-400">
            {t.roleId && <span className="text-ink-300">{roleName(t.roleId) ?? "Role"} · </span>}
            {detail}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <GitBadge state={t.git} />
            <StageBadge stage={t.stage} />
            <StatusBadge status={t.status} />
          </div>
          <span className="text-xs text-ink-400">
            {ago(t.updatedAt)} · {cost(t.costUsd)}
          </span>
        </div>
      </Link>
      <StageActions task={t} mainOnly />
    </li>
  );
}
