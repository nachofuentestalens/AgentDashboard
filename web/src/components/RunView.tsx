import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { buildTranscript, describeToolInput, type Run, type TranscriptItem } from "@ad/shared";
import { api, keys } from "../api.ts";
import { cost, duration, modelLabel, usageLine } from "../format.ts";
import { fetchRunEvents } from "../live.ts";
import { Markdown } from "./Markdown.tsx";
import { Button, ErrorNote, StatusBadge } from "./ui.tsx";

function ToolRow({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const summary = describeToolInput(item.input);
  const pending = item.result === null;
  return (
    <details className="group rounded-md border border-ink-700/70 bg-ink-900/60 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-ink-300 hover:text-ink-100">
        <span className="text-ink-400 transition-transform group-open:rotate-90">▸</span>
        <span className={`font-mono font-medium ${item.isError ? "text-red-300" : "text-accent"}`}>{item.name}</span>
        <span className="truncate font-mono text-ink-400">{summary}</span>
        {pending && <span className="ml-auto animate-pulse text-ink-400">running…</span>}
        {item.isError && <span className="ml-auto text-red-300">error</span>}
      </summary>
      <div className="space-y-2 border-t border-ink-700/70 px-3 py-2">
        <pre className="max-h-64 overflow-auto font-mono whitespace-pre-wrap text-ink-300">{JSON.stringify(item.input, null, 2)}</pre>
        {item.result !== null && (
          <pre className={`max-h-80 overflow-auto font-mono whitespace-pre-wrap ${item.isError ? "text-red-300" : "text-ink-200"}`}>
            {item.result || "(no output)"}
          </pre>
        )}
      </div>
    </details>
  );
}

// Ticks once a second while the run is active, so the elapsed time moves.
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function RunView({ run, isLatest }: { run: Run; isLatest: boolean }) {
  const running = run.status === "running";
  const events = useQuery({
    queryKey: keys.runEvents(run.id),
    queryFn: () => fetchRunEvents(run.id),
    staleTime: running ? 0 : Infinity,
  });
  const transcript = useMemo(() => buildTranscript((events.data ?? []).map((e) => e.event)), [events.data]);
  const stderr = useMemo(() => (events.data ?? []).filter((e) => e.event.kind === "stderr"), [events.data]);
  const now = useNow(running);

  const stop = useMutation({ mutationFn: () => api.stopRun(run.id) });
  const retry = useMutation({ mutationFn: () => api.retryRun(run.id) });
  const force = useMutation({ mutationFn: () => api.forceRun(run.id) });
  const canRetry = isLatest && (run.status === "failed" || run.status === "stopped" || run.status === "interrupted");

  if (run.status === "queued")
    return (
      <div className="space-y-2">
        <p className="text-sm text-sky-300">Queued for an agent.</p>
        <p className="text-xs text-ink-400">{run.waitReason ?? "Waiting for the scheduler…"}</p>
        <div className="flex gap-2">
          {!run.forced && (
            <Button
              variant="ghost"
              className="!px-2 !py-0.5 text-xs"
              onClick={() => force.mutate()}
              title="Ignore budgets, an open emergency and a paused project for this run"
            >
              Run anyway
            </Button>
          )}
          <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => stop.mutate()}>
            ■ Take out of the queue
          </Button>
        </div>
        <ErrorNote error={force.error ?? stop.error} />
      </div>
    );

  return (
    <div className="space-y-3">
      {transcript.items.length === 0 && running && <p className="caret text-sm text-ink-400">Starting agent</p>}
      {transcript.items.map((item, i) =>
        item.type === "text" ? (
          <Markdown key={i} text={item.text} streaming={item.streaming && running} />
        ) : item.type === "tool" ? (
          <ToolRow key={item.id || i} item={item} />
        ) : item.type === "notice" ? (
          <div
            key={i}
            role="note"
            className={`flex gap-1.5 rounded-md border px-3 py-1.5 text-xs ${item.level === "warn" ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-ink-700 bg-ink-900 text-ink-300"}`}
          >
            <span aria-hidden>{item.level === "warn" ? "⚠" : "→"}</span>
            <Markdown text={item.text} />
          </div>
        ) : (
          <p key={i} className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-red-300">
            {item.message}
          </p>
        ),
      )}
      {run.error && run.status !== "stopped" && !transcript.items.some((i) => i.type === "error" && i.message === run.error) && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm whitespace-pre-wrap text-red-300">{run.error}</p>
      )}
      {stderr.length > 0 && run.status === "failed" && (
        <details className="text-xs text-ink-400">
          <summary className="cursor-pointer">Agent log ({stderr.length} lines)</summary>
          <pre className="mt-1 max-h-60 overflow-auto font-mono whitespace-pre-wrap">
            {stderr.map((e) => (e.event.kind === "stderr" ? e.event.text : "")).join("\n")}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
        <StatusBadge status={run.status} />
        <span>
          {modelLabel(run.model || (run.provider === "codex" ? "ChatGPT (Codex default)" : "Claude default"))} · {run.effort}
        </span>
        <span>{duration(run.startedAt, run.endedAt, now)}</span>
        <span>
          {run.toolCalls} tool calls{run.purpose === "handoff" ? " · handoff preparation" : run.purpose === "review" ? " · review (read-only)" : ""}
        </span>
        {/* A stopped or crashed run reports no usage; zeros would read as "free". */}
        {!running && (run.costUsd > 0 || run.usage.outputTokens > 0) && (
          <>
            <span>{usageLine(run.usage)}</span>
            <span>{run.provider === "codex" ? "Cost not reported" : cost(run.costUsd)}</span>
          </>
        )}
        {running && (
          <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => stop.mutate()} disabled={stop.isPending}>
            ■ Stop
          </Button>
        )}
        {canRetry && (
          <Button variant="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => retry.mutate()} disabled={retry.isPending}>
            ↻ Retry
          </Button>
        )}
      </div>
      <ErrorNote error={stop.error ?? retry.error} />
    </div>
  );
}
