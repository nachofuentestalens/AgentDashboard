import { useModelCatalog } from "../models.ts";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PROVIDERS, PROVIDER_EFFORTS, effortFor, type Provider, type Effort } from "@ad/shared";
import { api, keys } from "../api.ts";
import { Button, ErrorNote, Field, inputClass } from "../components/ui.tsx";

const limit = (value: string) => (value.trim() === "" ? null : Number(value));

export function SettingsPage() {
  const catalog = useModelCatalog();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.settings });
  const [codexPath, setCodexPath] = useState("");
  const [claudePath, setClaudePath] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("medium");
  // Kept as text so an empty field can mean unlimited.
  const [tokenBudget, setTokenBudget] = useState("");
  const [toolBudget, setToolBudget] = useState("");

  useEffect(() => {
    if (!settings.data) return;
    setTokenBudget(settings.data.defaultTokenBudget?.toString() ?? "");
    setToolBudget(settings.data.defaultToolBudget?.toString() ?? "");
    setClaudePath(settings.data.claudePath);
    setProvider(settings.data.defaultProvider);
    setCodexPath(settings.data.codexPath);
    setModel(settings.data.defaultModel);
    setEffort(settings.data.defaultEffort);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({
        claudePath,
        codexPath,
        defaultProvider: provider,
        defaultModel: model,
        defaultEffort: effort,
        defaultTokenBudget: limit(tokenBudget),
        defaultToolBudget: limit(toolBudget),
      }),
    onSuccess: (s) => qc.setQueryData(keys.settings, s),
  });
  const checkCodex = useMutation({ mutationFn: api.checkCodex });
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
          <Button
            onClick={() =>
              void save
                .mutateAsync()
                .then(() => check.mutate())
                .catch(() => {})
            }
            disabled={check.isPending}
          >
            Save and check Claude Code
          </Button>
          {check.data?.ok && (
            <span className="text-sm text-emerald-300">
              Found {check.data.version} <span className="font-mono text-xs text-ink-400">({check.data.command})</span>
            </span>
          )}
          {check.data && !check.data.ok && <span className="text-sm text-red-300">{check.data.error}</span>}
        </div>
        <Field
          label="ChatGPT / Codex CLI path"
          hint="Leave empty to find codex on PATH, or use fake for a free demo. Sign in once with codex login using your ChatGPT account."
        >
          <input className={inputClass} value={codexPath} onChange={(e) => setCodexPath(e.target.value)} />
        </Field>
        <Button
          disabled={checkCodex.isPending}
          onClick={() =>
            void save
              .mutateAsync()
              .then(() => checkCodex.mutate())
              .catch(() => {})
          }
        >
          Save and check Codex
        </Button>
        {checkCodex.data && <p className="text-sm">{checkCodex.data.ok ? "Found " + checkCodex.data.version : checkCodex.data.error}</p>}
        <p className="text-xs text-ink-400">
          Codex models refresh on server startup: the first five visible entries in CLI catalog order. The CLI may use cached metadata; this is not a benchmark
          ranking.
        </p>
        {catalog.status?.error && (
          <p role="status" className="text-sm text-gold">
            {catalog.status.error}
          </p>
        )}
        <ErrorNote error={catalog.error} />
        <Field label="Default provider">
          <select
            className={inputClass}
            value={provider}
            onChange={(e) => {
              const p = e.target.value as Provider;
              setProvider(p);
              setModel("");
              setEffort(effortFor(p, effort));
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Default model for new projects">
            <input className={`${inputClass} font-mono`} list="settings-models" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="settings-models">
              {catalog.presets[provider].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Default effort for new projects">
            <select className={inputClass} value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {PROVIDER_EFFORTS[provider].map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Default task token allowance" hint="Reported tokens, cached included. Empty: unlimited.">
            <input
              className={inputClass}
              type="number"
              min="1"
              max="1000000000"
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              placeholder="Unlimited"
            />
          </Field>
          <Field label="Default task tool-call allowance" hint="Empty: unlimited.">
            <input
              className={inputClass}
              type="number"
              min="1"
              max="100000"
              value={toolBudget}
              onChange={(e) => setToolBudget(e.target.value)}
              placeholder="Unlimited"
            />
          </Field>
        </div>
        <p className="text-xs text-ink-400">New tasks start with these allowances. Existing tasks keep theirs; change them on the task page.</p>
        <ErrorNote error={save.error ?? check.error ?? checkCodex.error} />
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
