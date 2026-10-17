import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task, TaskAction, TaskStage } from "@ad/shared";
import { api, keys } from "../api.ts";
import { useRoles } from "../pages/ProjectPage.tsx";
import { Button, ErrorNote } from "./ui.tsx";

type ActionButton = { action: TaskAction["action"]; label: string; title: string; main?: boolean };

const close: ActionButton = { action: "close", label: "Close", title: "Finish this task and hide it from the active list" };
const backlog: ActionButton = { action: "backlog", label: "To backlog", title: "Put it back in the queue" };

// The owner's moves for each stage; the server checks them again (stages.ts). The first one marked
// main is the stage's usual next move, shown alone where space is short.
export function stageActions(stage: TaskStage): ActionButton[] {
  switch (stage) {
    case "backlog":
      return [{ action: "start", label: "Start", title: "Send the agent to work on it", main: true }, close];
    case "needs_review":
      return [
        { action: "approve", label: "Approve", title: "Accept this step", main: true },
        { action: "continue", label: "Continue", title: "Go on with the next step", main: true },
        { action: "review", label: "Review with agent", title: "A read-only agent checks the changes in a fresh session", main: true },
        { action: "request_changes", label: "Request changes", title: "Note what should change" },
        backlog,
        close,
      ];
    case "changes_requested":
      return [{ action: "fix", label: "Fix", title: "Send the requested changes to the agent", main: true }, backlog, close];
    case "approved":
      return [{ ...close, main: true }, backlog];
    case "closed":
      return [{ action: "reopen", label: "Reopen", title: "Put it back in the backlog", main: true }];
    case "in_progress":
      return [close];
    case "in_review":
      return [];
  }
}

// Who reviews when the owner does not pick: the task's reviewer, the role's default, the role itself.
export function useReviewer(task: Task): string | undefined {
  const roles = useRoles(task.projectId).map((r) => r.role);
  const author = roles.find((r) => r.id === task.roleId);
  const id = [task.reviewerRoleId, author?.reviewerRoleId].find((r) => r && roles.some((x) => x.id === r)) ?? task.roleId;
  return roles.find((r) => r.id === id)?.name;
}

// Buttons for a role task's stage. Server pushes refresh the task everywhere it is shown.
export function StageActions({ task, mainOnly = false }: { task: Task; mainOnly?: boolean }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (body: TaskAction) => api.taskAction(task.id, body),
    // Reviews are part of the detail, which task pushes do not carry.
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.task(task.id) }),
  });
  const reviewer = useReviewer(task);
  if (!task.stage) return null;
  const busy = task.status === "running" || task.status === "queued";
  const buttons = stageActions(task.stage)
    .map((b) => (b.action === "review" && reviewer ? { ...b, label: `Review with ${reviewer}` } : b))
    .filter((b) => !mainOnly || b.main);
  if (buttons.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {buttons.map(({ action, label, title }) => (
        <Button
          key={action}
          variant="ghost"
          className="text-xs"
          disabled={busy || act.isPending}
          title={busy ? "Wait for the agent or stop it first" : title}
          onClick={() => {
            if (action !== "request_changes") return act.mutate({ action } as TaskAction);
            const text = prompt("What should change?")?.trim();
            if (text) act.mutate({ action, text });
          }}
        >
          {label}
        </Button>
      ))}
      <ErrorNote error={act.error} />
    </span>
  );
}
