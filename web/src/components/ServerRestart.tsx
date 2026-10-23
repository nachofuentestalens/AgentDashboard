import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api.ts";
import { Button } from "./ui.tsx";

export function ServerRestart() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const status = useQuery({ queryKey: ["server-restart"], queryFn: api.restartStatus, refetchInterval: 1000, retry: false });
  const action = useMutation({
    mutationFn: async (action: "request" | "cancel" | "confirm") => {
      if (action === "request") await api.requestRestart();
      else if (action === "cancel") await api.cancelRestart();
      else await api.confirmRestart();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["server-restart"] }),
  });
  const state = status.data;
  const idle = !state || state.phase === "idle";
  const errors = state?.participants.some((p) => p.state === "error");
  return (
    <div className="space-y-2 border-t border-ink-800 p-3 text-xs">
      {idle ? (
        <Button
          className="w-full text-xs"
          title={state && !state.supported ? "Start with pnpm start or pnpm dev to enable restart" : undefined}
          disabled={!state?.supported || status.isError || action.isPending}
          onClick={() => action.mutate("request")}
        >
          Request server restart
        </Button>
      ) : (
        <>
          <p role="status" className="text-ink-200">
            {state.phase === "ready"
              ? "All agents saved. Ready to restart."
              : state.phase === "restarting"
                ? "Restarting server…"
                : "Preparing agents for restart…"}
          </p>
          <p className="text-ink-400">
            New work is held. Current turns finish, then agents save handoffs. Sessions and queued work survive restart, which first pulls the latest Git
            version.
          </p>
          <button className="text-accent" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {state.participants.filter((p) => p.state === "ready").length} / {state.participants.length} agents ready
          </button>
          {expanded && (
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {state.participants.map((p) => (
                <li key={p.taskId}>
                  <Link to={`/tasks/${p.taskId}`} className="underline">
                    {p.title}
                  </Link>
                  : {p.state === "working" ? "Finishing current turn" : p.state === "saving" ? "Saving handoff" : p.state}
                  {p.error && <p className="text-red-300">{p.error}</p>}
                </li>
              ))}
            </ul>
          )}
          {state.error && (
            <p role="alert" className="text-red-300">
              {state.error}
            </p>
          )}
          {errors && (
            <Button className="w-full text-xs" disabled={action.isPending} onClick={() => action.mutate("request")}>
              Retry preparation
            </Button>
          )}
          <Button
            className="w-full text-xs"
            variant="primary"
            disabled={state.phase !== "ready" || action.isPending || status.isError}
            onClick={() => action.mutate("confirm")}
          >
            Restart server
          </Button>
          <Button
            className="w-full text-xs"
            disabled={state.phase === "restarting" || action.isPending || status.isError}
            onClick={() => action.mutate("cancel")}
          >
            Cancel restart
          </Button>
        </>
      )}
      {status.isError && (
        <p role="status" className="text-ink-400">
          Waiting for server connection…
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-red-300">
          {action.error.message}
        </p>
      )}
    </div>
  );
}
