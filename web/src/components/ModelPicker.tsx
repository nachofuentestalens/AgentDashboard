import { EFFORT_LEVELS, MODEL_PRESETS, type Effort } from "@ad/shared";
import { modelLabel } from "../format.ts";

const selectClass = "rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-200 focus:border-accent focus:outline-none";

// null = use the project's default; the option says what that default is.
export function ModelPicker({
  model,
  effort,
  defaults,
  onChange,
  disabled,
}: {
  model: string | null;
  effort: Effort | null;
  defaults: { model: string; effort: Effort };
  onChange: (next: { model: string | null; effort: Effort | null }) => void;
  disabled?: boolean;
}) {
  const presetIds: string[] = MODEL_PRESETS.map((m) => m.id);
  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label="Model"
        className={selectClass}
        value={model ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ model: e.target.value || null, effort })}
      >
        <option value="">Default ({modelLabel(defaults.model)})</option>
        {MODEL_PRESETS.map((m) => (
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
        onChange={(e) => onChange({ model, effort: (e.target.value || null) as Effort | null })}
      >
        <option value="">Default ({defaults.effort})</option>
        {EFFORT_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </div>
  );
}
