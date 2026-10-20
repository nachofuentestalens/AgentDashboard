import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_MODEL, type ComputeRun, type Provider } from "@ad/shared";
import { api } from "../api.ts";

export function ModelHolds({ provider, runs }: { provider: Provider; runs: ComputeRun[] }) {
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["models"], queryFn: api.models });
  const holds = useQuery({ queryKey: ["model-holds"], queryFn: api.modelHolds, refetchInterval: 5000 });
  const [selected, setSelected] = useState(provider === "claude" ? DEFAULT_MODEL : "");
  const mutation = useMutation({
    mutationFn: ({ model, paused }: { model: string; paused: boolean }) => api.setModelHold(provider, model, paused),
    onSuccess: (data) => {
      qc.setQueryData(["model-holds"], data);
      void qc.invalidateQueries({ queryKey: ["compute"] });
    },
  });
  const options = new Map<string, string>(provider === "codex" ? [["", "CLI default"]] : [[DEFAULT_MODEL, DEFAULT_MODEL]]);
  for (const model of catalog.data?.presets[provider] ?? []) options.set(model.id, model.label);
  for (const row of runs) if (row.run.model && !options.has(row.run.model)) options.set(row.run.model, row.run.model);
  for (const hold of holds.data ?? []) if (hold.provider === provider && !options.has(hold.model)) options.set(hold.model, hold.model);
  const paused = holds.data?.some((hold) => hold.provider === provider && hold.model === selected) ?? false;
  const label = provider === "claude" ? "Claude" : "Codex";
  return (
    <details className="text-[11px]">
      <summary className="cursor-pointer rounded px-1 py-1 text-ink-300 hover:bg-ink-800">
        Model controls{holds.data?.some((hold) => hold.provider === provider) ? " - Paused" : ""}
      </summary>
      <div className="space-y-2 px-1 py-2">
        <select
          aria-label={`${label} model to pause`}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="w-full rounded bg-ink-800 p-1"
        >
          {[...options].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
              {holds.data?.some((hold) => hold.provider === provider && hold.model === id) ? " (paused)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={`${paused ? "Resume" : "Pause"} ${label} model`}
          aria-pressed={paused}
          disabled={holds.isPending || holds.isError || mutation.isPending}
          onClick={() => mutation.mutate({ model: selected, paused: !paused })}
          className="w-full rounded border border-ink-700 px-2 py-1 text-ink-100 hover:bg-ink-800 disabled:opacity-50"
        >
          {mutation.isPending ? "Saving..." : paused ? "Resume model" : "Pause model"}
        </button>
        <p className="text-ink-400">Stops dashboard runs and holds new work until resumed. CLI default is a separate choice.</p>
        {(mutation.isError || holds.isError) && (
          <p role="alert" className="text-red-300">
            {mutation.error?.message ?? "Could not load model holds."}
          </p>
        )}
      </div>
    </details>
  );
}
