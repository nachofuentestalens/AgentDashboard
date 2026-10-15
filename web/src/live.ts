import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { ServerPush, StampedEvent, TaskDetail } from "@ad/shared";
import { api, keys } from "./api.ts";

// Events that arrived over the live stream, per run. A run's events query merges these with what it
// fetched, so an event pushed while the fetch was in flight is not lost.
const buffers = new Map<string, StampedEvent[]>();

export function mergeEvents(a: StampedEvent[], b: StampedEvent[]): StampedEvent[] {
  if (b.length === 0) return a;
  const bySeq = new Map<number, StampedEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export async function fetchRunEvents(runId: string): Promise<StampedEvent[]> {
  const fetched = await api.runEvents(runId);
  return mergeEvents(fetched, buffers.get(runId) ?? []);
}

export type Connection = "connecting" | "open" | "lost";

// One EventSource for the whole app; every push updates the query cache in place.
export function useLiveUpdates(qc: QueryClient): Connection {
  const [state, setState] = useState<Connection>("connecting");

  useEffect(() => {
    const source = new EventSource("/api/events");
    let lost = false;

    source.onopen = () => {
      setState("open");
      // Anything could have changed while disconnected (including a server restart).
      if (lost) void qc.invalidateQueries();
      lost = false;
    };
    source.onerror = () => {
      lost = true;
      setState("lost");
    };
    source.onmessage = (message) => {
      const push = JSON.parse(message.data as string) as ServerPush;
      switch (push.type) {
        case "run_event": {
          const list = buffers.get(push.runId) ?? [];
          list.push(push.stamped);
          buffers.set(push.runId, list);
          qc.setQueryData<StampedEvent[]>(keys.runEvents(push.runId), (old) => (old ? mergeEvents(old, [push.stamped]) : old));
          break;
        }
        case "run_updated": {
          const run = push.run;
          qc.setQueryData<TaskDetail>(keys.task(run.taskId), (old) => {
            if (!old) return old;
            const exists = old.runs.some((r) => r.id === run.id);
            return { ...old, runs: exists ? old.runs.map((r) => (r.id === run.id ? run : r)) : [...old.runs, run] };
          });
          if (run.status !== "running") {
            void qc.invalidateQueries({ queryKey: ["task"] });
            // The stored file now holds every event; the buffer is no longer needed.
            setTimeout(() => buffers.delete(run.id), 30_000);
            void qc.invalidateQueries({ queryKey: keys.task(run.taskId) });
          }
          void qc.invalidateQueries({ queryKey: ["tasks"] });
          // Agents' states, queue positions and spend all follow runs.
          void qc.invalidateQueries({ queryKey: ["studio"] });
          void qc.invalidateQueries({ queryKey: keys.compute });
          // A queued run's reason decides whether it is held in the inbox.
          void qc.invalidateQueries({ queryKey: keys.inbox });
          break;
        }
        case "task_updated":
          qc.setQueryData<TaskDetail>(keys.task(push.task.id), (old) => (old ? { ...old, task: push.task } : old));
          void qc.invalidateQueries({ queryKey: keys.tasks(push.task.projectId) });
          void qc.invalidateQueries({ queryKey: keys.studio(push.task.projectId) });
          break;
        case "studio_changed":
          void qc.invalidateQueries({ queryKey: keys.studio(push.projectId) });
          void qc.invalidateQueries({ queryKey: keys.compute });
          break;
        case "inbox_changed":
          void qc.invalidateQueries({ queryKey: keys.inbox });
          break;
        case "docs_changed":
          void qc.invalidateQueries({ queryKey: keys.docs(push.projectId) });
          void qc.invalidateQueries({ queryKey: ["doc", push.projectId] });
          break;
        case "feedback_changed":
          void qc.invalidateQueries({ queryKey: keys.feedback(push.projectId) });
          break;
        case "task_deleted":
          qc.removeQueries({ queryKey: keys.task(push.taskId) });
          void qc.invalidateQueries({ queryKey: keys.tasks(push.projectId) });
          break;
        case "projects_changed":
          void qc.invalidateQueries({ queryKey: keys.projects });
          void qc.invalidateQueries({ queryKey: ["project"] });
          break;
      }
    };
    return () => source.close();
  }, [qc]);

  return state;
}
