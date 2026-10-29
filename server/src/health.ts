import type { Run, StewardItemKind, Task, TaskStage } from "@ad/shared";

// Project health for the inbox steward (docs/STEWARD.md): concerns no single inbox item shows, such
// as a queue that stopped moving, a task that keeps failing or work nobody will pick up again, plus
// an overview so the steward can see when many items share one cause. Pure, so the rules are tested
// as a table (server/test/health.test.ts).

export const STALL_MS = 15 * 60_000;
export const STUCK_MS = 30 * 60_000;
// Retrying more often than this rarely helps; the steward delegates, reports or escalates instead.
export const MAX_RETRIES = 3;
const FAILURE_WINDOW_MS = 6 * 60 * 60_000;

export interface HealthInput {
  now: number;
  // The project's open tasks (not the steward's own triage) with their runs, oldest first.
  // autoContinueStopped: the runner stopped resuming the task's step after a continue that changed nothing.
  tasks: { task: Task; runs: Run[]; autoContinueStopped?: boolean }[];
  // Runs in progress across every project, to tell a full machine from a stuck project.
  runningElsewhere: number;
}

export interface HealthConcern {
  key: string;
  kind: Extract<StewardItemKind, "stall" | "failing" | "stuck">;
  title: string;
  detail: string;
  taskId: string | null;
  runId: string | null;
  // failing: failed runs in a row at the end of the task's history.
  failures?: number;
  // stall: every queued run waits on a coordinator quota hold, which the provider alert already explains.
  quotaHold?: boolean;
}

export interface Health {
  overview: string;
  concerns: HealthConcern[];
}

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`;
const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);
const firstLine = (text: string, max = 160) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}...` : line;
};

function counts<T>(items: T[], by: (item: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const item of items) m.set(by(item), (m.get(by(item)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

// Failed runs in a row at the end of the history; stopped runs were the owner's doing.
function failureStreak(runs: Run[]): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    const status = runs[i]!.status;
    if (status !== "failed" && status !== "interrupted") break;
    n++;
  }
  return n;
}

export function projectHealth({ now, tasks, runningElsewhere }: HealthInput): Health {
  const runs = tasks.flatMap(({ runs }) => runs);
  const title = new Map(tasks.map(({ task }) => [task.id, task.title]));
  const queued = runs.filter((r) => r.status === "queued").sort((a, b) => time(a.startedAt) - time(b.startedAt));
  const running = runs.filter((r) => r.status === "running");
  // A queued run's startedAt is when it was queued, so only started or ended runs count as progress.
  const activity = Math.max(-Infinity, ...running.map((r) => time(r.startedAt)), ...runs.flatMap((r) => (r.endedAt ? [time(r.endedAt)] : [])));
  const concerns: HealthConcern[] = [];

  const oldest = queued[0];
  const stalledFor = oldest ? now - Math.max(time(oldest.startedAt), activity) : 0;
  if (oldest && running.length === 0 && stalledFor >= STALL_MS) {
    // The key changes as the stall doubles (15, 30, 60 min...), so a "wait" is looked at again later.
    const step = Math.floor(Math.log2(stalledFor / STALL_MS));
    const reasons = counts(queued, (r) => r.waitReason ?? "waiting for a slot");
    concerns.push({
      key: `stall:${oldest.id}:${step}`,
      kind: "stall",
      title: `Nothing has run for ${minutes(stalledFor)} while ${queued.length} run${queued.length === 1 ? "" : "s"} wait`,
      detail: [
        `Queued runs: ${queued.length}; running in this project: 0; running in other projects: ${runningElsewhere}.`,
        `Oldest queued: "${title.get(oldest.taskId) ?? oldest.taskId}" for ${minutes(now - time(oldest.startedAt))}.`,
        "Wait reasons:",
        ...reasons.map(([reason, n]) => `- ${n} × ${firstLine(reason, 300)}`),
        "If the reasons cannot explain the stall (for example a slot is free but nothing starts, or work waits on something that is already done), the dashboard itself may be at fault: report it.",
      ].join("\n"),
      taskId: oldest.taskId,
      runId: oldest.id,
      quotaHold: queued.every((r) => r.waitReason?.startsWith("Coordinator:")),
    });
  }

  for (const { task, runs, autoContinueStopped } of tasks) {
    if (!task.roleId) continue;
    const last = runs.at(-1);
    const streak = failureStreak(runs);
    if (last && streak > 0 && (task.status === "failed" || task.status === "interrupted")) {
      concerns.push({
        key: `failing:${last.id}`,
        kind: "failing",
        title: `"${task.title}" failed${streak > 1 ? ` ${streak} times in a row` : ""}`,
        detail: [
          `Stage: ${task.stage ?? "none"}; run purpose: ${last.purpose}; ended ${last.endedAt ? `${minutes(now - time(last.endedAt))} ago` : "unknown"}.`,
          `Error: ${firstLine(last.error ?? last.status, 600)}`,
          streak >= MAX_RETRIES ? `Retry is not available: it already failed ${streak} times in a row.` : "Retry runs the same message again.",
        ].join("\n"),
        taskId: task.id,
        runId: last.id,
        failures: streak,
      });
    }
    // An idle task in progress has no run, question or review coming: nothing will move it.
    const quiet = now - time(task.updatedAt);
    if (task.stage === "in_progress" && task.status === "idle" && !task.question && quiet >= STUCK_MS) {
      concerns.push({
        key: `stuck:${task.id}:${task.updatedAt}`,
        kind: "stuck",
        title: `"${task.title}" has been idle in progress for ${minutes(quiet)}`,
        detail: [
          `Last step: ${task.stepState ?? "none"}. Summary: ${firstLine(task.stepSummary ?? "none", 600)}`,
          `Next step: ${task.nextStep ?? "none"}`,
          `Automatic continues used: ${task.autoContinues}.${autoContinueStopped ? " Stopped: the last one changed nothing, so the step waits for a reply." : ""}`,
        ].join("\n"),
        taskId: task.id,
        runId: last?.id ?? null,
      });
    }
  }

  const recentFailures = runs.filter((r) => (r.status === "failed" || r.status === "interrupted") && r.endedAt && now - time(r.endedAt) <= FAILURE_WINDOW_MS);
  const errors = counts(recentFailures, (r) => firstLine(r.error ?? r.status, 200));
  const stages = counts(
    tasks.flatMap(({ task }) => (task.stage ? [task.stage] : [])),
    (s: TaskStage) => s,
  );
  const overview = [
    "Project health:",
    `- Running: ${running.length}; queued: ${queued.length}${oldest ? ` (oldest for ${minutes(now - time(oldest.startedAt))})` : ""}; running in other projects: ${runningElsewhere}.`,
    `- Last run started or ended: ${Number.isFinite(activity) ? `${minutes(now - activity)} ago` : "never"}.`,
    stages.length ? `- Open role tasks by stage: ${stages.map(([s, n]) => `${s} ${n}`).join(", ")}.` : "",
    queued.length
      ? `- Queue wait reasons: ${counts(queued, (r) => firstLine(r.waitReason ?? "waiting for a slot", 120))
          .map(([r, n]) => `${n} × ${r}`)
          .join("; ")}.`
      : "",
    recentFailures.length
      ? `- Failed runs in the last 6 hours: ${recentFailures.length} in ${new Set(recentFailures.map((r) => r.taskId)).size} task(s). Errors: ${errors
          .slice(0, 5)
          .map(([e, n]) => `${n} × ${e}`)
          .join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { overview, concerns };
}
