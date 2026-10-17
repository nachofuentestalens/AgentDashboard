import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, keys } from "../api.ts";
import { Button, ErrorNote } from "./ui.tsx";

export function DeliveryPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);
  const view = useQuery({ queryKey: ["delivery", projectId], queryFn: () => api.delivery(projectId), enabled: open });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["delivery", projectId] });
    await qc.invalidateQueries({ queryKey: keys.tasks(projectId) });
    await qc.invalidateQueries({ queryKey: keys.project(projectId) });
  };
  const prepare = useMutation({
    mutationFn: (taskId?: string) => (taskId ? api.previewIntegration(projectId, taskId) : api.previewBaseline(projectId, paths)),
    onSuccess: refresh,
  });
  const approve = useMutation({ mutationFn: (id: string) => api.approveBaseline(projectId, id), onSuccess: refresh });
  const plan = useMutation({
    mutationFn: (id?: string) => (id ? api.approveDeliveryPlan(projectId, id) : api.previewDeliveryPlan(projectId)),
    onSuccess: refresh,
  });
  const enable = useMutation({ mutationFn: () => api.enableDelivery(projectId), onSuccess: refresh });
  const busy = prepare.isPending || approve.isPending || plan.isPending || enable.isPending;
  const preview = view.data?.preview;
  return (
    <details className="rounded-xl border border-ink-700 p-4 text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">Delivery & baseline</summary>
      <p className="my-3 text-ink-300">
        Review the baseline and integrate approved work here. Agents receive the approved files in isolated task folders; the live checkout stays unchanged.
      </p>
      <ErrorNote error={view.error} />
      {view.data && (
        <>
          {view.data.baseline ? (
            <p>
              Approved baseline: <code>{view.data.baseline.commit.slice(0, 12)}</code>
            </p>
          ) : (
            <>
              <p className="mb-2">Choose uncommitted files to include in the initial snapshot. Existing committed files are included automatically.</p>
              <div className="max-h-56 space-y-1 overflow-auto">
                {view.data.snapshotFiles.map((file) => (
                  <label key={file} className="flex gap-2 font-mono text-xs">
                    <input
                      type="checkbox"
                      checked={paths.includes(file)}
                      onChange={(e) => setPaths((old) => (e.target.checked ? [...old, file] : old.filter((p) => p !== file)))}
                    />
                    {file}
                  </label>
                ))}
              </div>
              <Button className="mt-3" disabled={busy} onClick={() => prepare.mutate(undefined)}>
                Prepare baseline preview
              </Button>
            </>
          )}
          {view.data.tasks.length > 0 && (
            <ul className="my-3 space-y-2">
              {view.data.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3">
                  <Link className="underline" to={`/tasks/${t.id}`}>
                    {t.title}
                  </Link>
                  {t.integrated ? (
                    <span className="text-emerald-300">Integrated</span>
                  ) : (
                    <Button disabled={busy || !view.data?.baseline} onClick={() => prepare.mutate(t.id)}>
                      Preview integration
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {view.data.baseline && (
            <div className="my-3 space-y-2">
              <p>
                Import the committed <code>planning/milestone.json</code> and <code>planning/dashboard-state.json</code> to connect the existing backlog.
              </p>
              <Button disabled={busy} onClick={() => plan.mutate(undefined)}>
                Preview milestone import
              </Button>
              {view.data.paused && <p className="text-amber-300">Delivery is paused for recovery. Review the recovered outcomes before enabling automation.</p>}
              {view.data.planImported && (
                <Button disabled={busy} onClick={() => enable.mutate()}>
                  Enable reviewed delivery automation
                </Button>
              )}
            </div>
          )}
          {view.data.planPreview && (
            <section aria-label="Milestone import preview" className="my-3 space-y-3 rounded-lg bg-ink-900 p-3">
              <p>
                Import {view.data.planPreview.entries.length} existing tasks. Automation will pause. Completed legacy outputs return to owner review; unfinished
                work returns to the backlog with its WIP preserved.
              </p>
              <ul className="max-h-96 space-y-3 overflow-auto">
                {view.data.planPreview.entries.map((e) => (
                  <li key={e.taskId}>
                    <Link to={`/tasks/${e.taskId}`} className="underline">
                      {e.title}
                    </Link>
                    : {e.fromStage} → {e.toStage}
                    <p className="text-xs text-ink-400">
                      Prerequisites:{" "}
                      {e.dependencyIds.map((id) => view.data!.planPreview!.entries.find((t) => t.taskId === id)?.milestoneId ?? id).join(", ") || "none"}
                    </p>
                    <p className="text-xs text-ink-400">Inputs: {e.requiredPaths.join(", ")}</p>
                    <p className="text-xs text-ink-400">Evidence report: {e.report}</p>
                    {!!e.missingOutputs.length && <p className="text-xs text-amber-300">Outputs not yet in baseline: {e.missingOutputs.join(", ")}</p>}
                  </li>
                ))}
              </ul>
              <Button disabled={busy} onClick={() => plan.mutate(view.data!.planPreview!.id)}>
                Approve import and pause automation
              </Button>
            </section>
          )}
          {preview && (
            <section aria-label="Baseline preview" className="my-3 space-y-3 rounded-lg bg-ink-900 p-3">
              <p>
                Review {preview.kind === "snapshot" ? "initial baseline" : "approved task integration"}: <code>{preview.commit.slice(0, 12)}</code>
              </p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{preview.files || "No file differences."}</pre>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
                {preview.diff || "The existing committed content will become the baseline."}
              </pre>
              <Button disabled={busy} onClick={() => approve.mutate(preview.id)}>
                {preview.approvesTask ? "Approve task and integrate" : "Approve this baseline"}
              </Button>
            </section>
          )}
          <Button className="mt-2" variant="ghost" disabled={busy} onClick={() => void refresh()}>
            Refresh delivery status
          </Button>
        </>
      )}
      <ErrorNote error={prepare.error} />
      <ErrorNote error={approve.error} />
      <ErrorNote error={plan.error} />
      <ErrorNote error={enable.error} />
    </details>
  );
}
