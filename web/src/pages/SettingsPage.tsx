import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EFFORT_LEVELS, MODEL_PRESETS, type Effort } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass } from "../components/ui.tsx";

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.settings });
  const [claudePath, setClaudePath] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("medium");

  useEffect(() => {
    if (!settings.data) return;
    setClaudePath(settings.data.claudePath);
    setModel(settings.data.defaultModel);
    setEffort(settings.data.defaultEffort);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => api.updateSettings({ claudePath, defaultModel: model, defaultEffort: effort }),
    onSuccess: (s) => qc.setQueryData(keys.settings, s),
  });
  const check = useMutation({ mutationFn: api.checkClaude });

  return (
    <div className="h-full overflow-y-auto">
      <form
        className="mx-auto max-w-2xl space-y-5 px-8 py-8"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <h1 className="text-xl font-semibold">Settings</h1>
        <Field
          label="Claude Code path"
          hint={
            <>
              Leave empty to find <code className="font-mono">claude</code> on PATH. Type <code className="font-mono">fake</code> to use the built-in demo
              agent, which costs nothing.
            </>
          }
        >
          <input
            className={`${inputClass} font-mono`}
            value={claudePath}
            onChange={(e) => setClaudePath(e.target.value)}
            placeholder="C:\Users\you\.local\bin\claude.exe"
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button onClick={() => void save.mutateAsync().then(() => check.mutate())} disabled={check.isPending}>
            Save and check Claude Code
          </Button>
          {check.data?.ok && (
            <span className="text-sm text-emerald-300">
              Found {check.data.version} <span className="font-mono text-xs text-ink-400">({check.data.command})</span>
            </span>
          )}
          {check.data && !check.data.ok && <span className="text-sm text-red-300">{check.data.error}</span>}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Default model for new projects">
            <input className={`${inputClass} font-mono`} list="settings-models" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="settings-models">
              {MODEL_PRESETS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Default effort for new projects">
            <select className={inputClass} value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {EFFORT_LEVELS.map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorNote error={save.error ?? check.error} />
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            Save
          </Button>
          {save.isSuccess && <span className="text-sm text-emerald-300">Saved.</span>}
        </div>
      </form>
    </div>
  );
}
