import { useModelCatalog } from "../models.ts";
import { PROVIDERS, PROVIDER_EFFORTS, resolveChoice, type Provider, type Effort } from "@ad/shared";
import { modelLabel } from "../format.ts";

const selectClass = "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-200 focus:border-accent focus:outline-none";

// null = use the project's default; the option says what that default is.
export function ModelPicker({
  provider = null,
  model,
  effort,
  defaults,
  onChange,
  disabled,
}: {
  provider?: Provider | null;
  model: string | null;
  effort: Effort | null;
  defaults: { provider: Provider; model: string | null; effort: Effort };
  onChange: (next: { provider: Provider | null; model: string | null; effort: Effort | null }) => void;
  disabled?: boolean;
}) {
  const catalog = useModelCatalog();
  const effective = resolveChoice([{ provider, model, effort }, defaults]);
  const presets = catalog.presets[effective.provider];
  const presetIds = presets.map((m) => m.id);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        aria-label="Provider"
        className={selectClass}
        value={provider ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ provider: (e.target.value || null) as Provider | null, model: null, effort: null })}
      >
        <option value="">Default ({PROVIDERS.find((p) => p.id === defaults.provider)?.label})</option>
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Model"
        className={selectClass}
        value={model ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ provider, model: e.target.value || null, effort })}
      >
        <option value="">Default ({modelLabel(resolveChoice([{ provider, model: null, effort }, defaults]).model ?? "CLI default")})</option>
        {presets.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {model && !presetIds.includes(model) && <option value={model}>{model}</option>}
      </select>
      <select
        aria-label="Effort"
        className={selectClass}
        value={effort ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ provider, model, effort: (e.target.value || null) as Effort | null })}
      >
        <option value="">Default ({effective.effort})</option>
        {PROVIDER_EFFORTS[effective.provider].map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}
