import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskDetail } from "@ad/shared";
import { api, keys } from "../api.ts";
import { duration, tokens } from "../format.ts";
import { Button, ErrorNote } from "./ui.tsx";

export function EfficiencyPanel({ detail }: { detail: TaskDetail }) {
  const { task, runs } = detail;
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.task(task.id) });
  };
  const prepare = useMutation({ mutationFn: () => api.prepareHandoff(task.id), onSuccess: refresh });
  const compact = useMutation({ mutationFn: (summary: string) => api.compactTask(task.id, summary), onSuccess: refresh });
  const update = useMutation({ mutationFn: (body: Parameters<typeof api.updateTask>[1]) => api.updateTask(task.id, body), onSuccess: refresh });
  const busy = task.status === "running" || task.status === "queued" || prepare.isPending || compact.isPending || update.isPending;
  const localTokens = runs.reduce((n, r) => n + r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens + r.usage.outputTokens, 0);
  const usedTokens = Math.max(localTokens, detail.usageSummary?.tokens ?? 0);
  const usedTools = Math.max(
    runs.reduce((n, r) => n + r.toolCalls, 0),
    detail.usageSummary?.toolCalls ?? 0,
  );
  const near = (task.tokenBudget !== null && usedTokens >= task.tokenBudget * 0.8) || (task.toolBudget !== null && usedTools >= task.toolBudget * 0.8);
  const tokensHit = task.tokenBudget !== null && usedTokens >= task.tokenBudget;
  const toolsHit = task.toolBudget !== null && usedTools >= task.toolBudget;
  // The server also checks parent tasks' allowances, which this panel cannot see on its own.
  const blocked = Boolean(detail.checkpoint) || tokensHit || toolsHit;
  const hitClass = "ring-2 ring-amber-400";
  const sessionStart = task.sessionId ? runs.find((r) => r.sessionId === task.sessionId)?.startedAt : null;
  // When the latest handoff run returned no valid block, offer its reply as a draft instead of an empty editor.
  const lastRun = runs.at(-1);
  const draft =
    task.handoff ?? (lastRun?.purpose === "handoff" ? (detail.messages.findLast((m) => m.role === "assistant" && m.runId === lastRun.id)?.text ?? "") : "");
  return (
    <details
      key={String(blocked)}
      open={blocked || undefined}
      className={`border-b px-6 py-2 text-xs ${blocked ? "border-amber-500 bg-amber-950/30" : "border-ink-800"}`}
    >
      <summary className={`cursor-pointer ${blocked ? "font-semibold text-amber-300" : "text-ink-300"}`}>
        Context & usage · {tokens(usedTokens)} reported tokens · {usedTools} tool calls
        {blocked ? " · ⚠ Blocked: raise the highlighted allowance below to continue" : near ? " · Usage checkpoint near" : ""}
      </summary>
      <div className="mx-auto mt-3 max-w-3xl space-y-3 pb-2">
        <p className="text-ink-300">
          Agents assess task complexity first and recommend model and effort before implementation. They can change settings at step boundaries using a compact
          handoff. Changes stay within the selected provider, appear in the conversation, and count toward the same allowance. Up to three automatic changes are
          allowed per message.
        </p>
        <p className="text-ink-400">
          Includes this task and delegated tasks, across retries and session resets. Cached tokens count toward this allowance; this is not a billing estimate.
          Tokens may arrive only when a run ends. Unreported usage is not zero usage.
        </p>
        <p>
          {detail.usageSummary?.runs ?? runs.length} runs · {detail.usageSummary?.unreportedRuns ?? 0} runs with unreported usage ·{" "}
          {sessionStart ? `Session age: ${duration(sessionStart, null)}` : "Fresh session on next message"}
        </p>
        {blocked ? (
          <div className="rounded border border-amber-500 p-3 text-amber-200" role="alert">
            <p className="font-semibold">New runs are blocked by a usage checkpoint.</p>
            <p className="mt-1">
              {detail.checkpoint ??
                `${tokensHit ? `Tokens: ${tokens(usedTokens)} used of ${tokens(task.tokenBudget!)}. ` : ""}${toolsHit ? `Tool calls: ${usedTools} used of ${task.toolBudget}. ` : ""}`}
            </p>
            <ol className="mt-2 list-decimal pl-5">
              <li>Set the highlighted allowance above its current usage, or clear it for unlimited.</li>
              <li>Click “Save usage controls”.</li>
              <li>Send a message (or press Retry). No page refresh or server restart is needed.</li>
            </ol>
          </div>
        ) : (
          near && <p className="text-amber-300">At least 80% of an allowance has been used. Consider finishing this phase and preparing a handoff.</p>
        )}
        <form
          key={`${task.tokenBudget}:${task.toolBudget}:${task.autoCompact}`}
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const limit = (name: string) => (String(data.get(name)).trim() === "" ? null : Number(data.get(name)));
            update.mutate({ tokenBudget: limit("tokens"), toolBudget: limit("tools"), autoCompact: data.get("autoCompact") === "on" });
          }}
        >
          <label>
            Task token allowance
            <input
              className={`mt-1 block rounded bg-ink-800 p-2 ${tokensHit ? hitClass : ""}`}
              aria-label="Task token allowance"
              type="number"
              name="tokens"
              min="1"
              max="1000000000"
              defaultValue={task.tokenBudget ?? ""}
              disabled={busy}
              placeholder="Unlimited"
            />
          </label>
          <label>
            Task tool-call allowance
            <input
              className={`mt-1 block rounded bg-ink-800 p-2 ${toolsHit ? hitClass : ""}`}
              aria-label="Task tool-call allowance"
              type="number"
              name="tools"
              min="1"
              max="100000"
              defaultValue={task.toolBudget ?? ""}
              disabled={busy}
              placeholder="Unlimited"
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="autoCompact" defaultChecked={task.autoCompact} disabled={busy} />
            Use fresh phase handoffs on next message
          </label>
          <Button disabled={busy} type="submit">
            Save usage controls
          </Button>
        </form>
        <p className="text-ink-400">
          Automatic handoff uses only a validated summary from the latest successful run. It never starts another run by itself. Keep it off to review every
          handoff. Tool checkpoints stop after reported tool completion; they can interrupt verification and cannot guarantee an exact cap.
        </p>
        <Button disabled={busy || !task.sessionStarted || blocked} onClick={() => prepare.mutate()}>
          Prepare handoff
        </Button>
        <span className="ml-2 text-ink-400">
          {blocked
            ? `Raise the allowances above current usage (${tokens(usedTokens)} tokens, ${usedTools} tool calls) to prepare a handoff or continue.`
            : !task.sessionStarted
              ? task.handoff
                ? "Handoff in place: your next message starts a fresh session from the summary below."
                : "No active session to summarize; write a handoff below."
              : "Uses one read-only agent run and counts toward the allowance."}
        </span>
        <form
          key={`${task.id}:${draft}`}
          onSubmit={(e) => {
            e.preventDefault();
            compact.mutate(String(new FormData(e.currentTarget).get("summary")));
          }}
          className="space-y-2"
        >
          <label className="block">
            Review or write the handoff
            <textarea
              className="mt-1 block min-h-32 w-full rounded bg-ink-800 p-2"
              aria-label="Compact handoff"
              name="summary"
              required
              maxLength={6000}
              defaultValue={draft}
              disabled={busy}
              placeholder="Goal and acceptance criteria; constraints; relevant files; changes made; checks completed; remaining work and uncertainties."
            />
          </label>
          <Button type="submit" disabled={busy}>
            Use compact handoff
          </Button>
          <p className="text-ink-400">
            Your next message starts a new session using this summary. The full transcript remains here; old tool output is not sent. Usage does not reset.
            Include any requirements that must survive.
          </p>
        </form>
        <ErrorNote error={prepare.error ?? compact.error ?? update.error} />
      </div>
    </details>
  );
}
